/**
 * State-dir path resolution + JSON/JSONL helpers, all validated through
 * @scale/core schemas. This is the single place that knows the on-disk layout
 *
 *   ~/.scale/<repo-id>/
 *     ├── config.json     (ScaleConfigSchema)
 *     ├── coverage.json   (UserCoverageSchema)
 *     ├── evidence.jsonl  (EvidenceEntrySchema, one per line, append-only)
 *     └── quests.json     (QuestSchema[])
 *
 * Hook-path callers (log/gate/context) use only the synchronous, fast
 * read/append helpers here — no schema-heavy work, no network, no LLM.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

import {
  ScaleConfigSchema,
  type ScaleConfig,
  UserCoverageSchema,
  type UserCoverage,
  QuestSchema,
  type Quest,
  EvidenceEntrySchema,
  type EvidenceEntry,
} from '@scale/core';

// ---------------------------------------------------------------------------
// repo-id + path resolution
// ---------------------------------------------------------------------------

/** Turn any string into a filesystem-safe slug. */
function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/^[a-z]+:\/\//, '') // strip scheme
      .replace(/\.git$/, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'repo'
  );
}

/**
 * Derive a stable repo-id for the current working tree:
 *   1. `git remote get-url origin`  → slug of host/owner/repo
 *   2. else basename of the git toplevel
 *   3. else basename of cwd
 * All git calls are best-effort and never throw.
 */
export function resolveRepoId(cwd: string = process.cwd()): string {
  const git = (args: string[]): string | null => {
    try {
      return execFileSync('git', args, {
        cwd,
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8',
      }).trim();
    } catch {
      return null;
    }
  };

  const remote = git(['remote', 'get-url', 'origin']);
  if (remote) {
    // git@github.com:owner/repo.git  →  github.com/owner/repo
    const normalized = remote.replace(/^git@([^:]+):/, '$1/');
    return slugify(normalized);
  }

  const top = git(['rev-parse', '--show-toplevel']);
  if (top) return slugify(path.basename(top));

  return slugify(path.basename(cwd));
}

/** Absolute path to `~/.scale/<repo-id>/` for the given cwd. */
export function stateDir(cwd: string = process.cwd()): string {
  return path.join(os.homedir(), '.scale', resolveRepoId(cwd));
}

export const paths = {
  config: (dir: string) => path.join(dir, 'config.json'),
  coverage: (dir: string) => path.join(dir, 'coverage.json'),
  evidence: (dir: string) => path.join(dir, 'evidence.jsonl'),
  quests: (dir: string) => path.join(dir, 'quests.json'),
  pendingEdits: (dir: string) => path.join(dir, 'pending-edits.json'),
};

/** Create the state dir (idempotent). */
export function ensureStateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// config.json  (validated by ScaleConfigSchema)
// ---------------------------------------------------------------------------

export function configExists(dir: string): boolean {
  return fs.existsSync(paths.config(dir));
}

/** Read + parse config.json; throws if missing or invalid. */
export function readConfig(dir: string): ScaleConfig {
  const raw = fs.readFileSync(paths.config(dir), 'utf8');
  return ScaleConfigSchema.parse(JSON.parse(raw));
}

/** Read config if present, else null (no throw). Used by hook-path commands. */
export function readConfigSafe(dir: string): ScaleConfig | null {
  try {
    return readConfig(dir);
  } catch {
    return null;
  }
}

/** Validate then write config.json (pretty-printed). */
export function writeConfig(dir: string, config: unknown): ScaleConfig {
  const parsed = ScaleConfigSchema.parse(config);
  ensureStateDir(dir);
  fs.writeFileSync(paths.config(dir), JSON.stringify(parsed, null, 2) + '\n');
  return parsed;
}

// ---------------------------------------------------------------------------
// coverage.json  (validated by UserCoverageSchema)
// ---------------------------------------------------------------------------

export function readCoverageSafe(dir: string): UserCoverage | null {
  try {
    const raw = fs.readFileSync(paths.coverage(dir), 'utf8');
    return UserCoverageSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// quests.json  (validated by QuestSchema[])
// ---------------------------------------------------------------------------

export function readQuestsSafe(dir: string): Quest[] {
  try {
    const raw = fs.readFileSync(paths.quests(dir), 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map((q) => QuestSchema.parse(q)) : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// evidence.jsonl  (append-only, validated by EvidenceEntrySchema)
// ---------------------------------------------------------------------------

/**
 * Validate + append one evidence line. Async, single append write — this is on
 * the hook latency path (§6.1: pure file append, < 200 ms, no LLM).
 */
export async function appendEvidence(
  dir: string,
  entry: EvidenceEntry,
): Promise<EvidenceEntry> {
  const parsed = EvidenceEntrySchema.parse(entry);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.appendFile(paths.evidence(dir), JSON.stringify(parsed) + '\n');
  return parsed;
}

// ---------------------------------------------------------------------------
// session.json  (CLI-local session/budget accounting — not a core schema)
// ---------------------------------------------------------------------------

/**
 * Per-session record. Written at SessionStart (`scale context`) and mutated by
 * the pre-commit gate to enforce the interruption budget (PLAN §6.1). This is
 * CLI-local state (never in the pilot repo), so it carries no zod schema — the
 * reader defaults every field so a partial/old session.json still works.
 */
export interface SessionRecord {
  sessionId: string;
  startedAt: string;
  /** Interventions already fired this session (vs budgets.maxPerSession). */
  interventionsThisSession: number;
  /** ISO timestamp of the last fired intervention, or null. */
  lastInterventionAt: string | null;
  /** Component the last deny asked about; cleared once its retry passes. */
  pendingComponent: string | null;
}

/** A brand-new session record (fresh budget). */
export function defaultSession(sessionId: string, startedAt: string): SessionRecord {
  return {
    sessionId,
    startedAt,
    interventionsThisSession: 0,
    lastInterventionAt: null,
    pendingComponent: null,
  };
}

const sessionPath = (dir: string): string => path.join(dir, 'session.json');

/**
 * Read session.json, defaulting any missing field. Returns null only when the
 * file is absent/unreadable — callers then synthesize a fresh session.
 */
export function readSessionSafe(dir: string): SessionRecord | null {
  try {
    const raw = JSON.parse(fs.readFileSync(sessionPath(dir), 'utf8')) as Partial<SessionRecord>;
    return {
      sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : 'unknown',
      startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : '',
      interventionsThisSession:
        typeof raw.interventionsThisSession === 'number' ? raw.interventionsThisSession : 0,
      lastInterventionAt:
        typeof raw.lastInterventionAt === 'string' ? raw.lastInterventionAt : null,
      pendingComponent:
        typeof raw.pendingComponent === 'string' ? raw.pendingComponent : null,
    };
  } catch {
    return null;
  }
}

/** Write session.json (pretty-printed). */
export function writeSession(dir: string, session: SessionRecord): void {
  ensureStateDir(dir);
  fs.writeFileSync(sessionPath(dir), JSON.stringify(session, null, 2) + '\n');
}

/**
 * How long an idle session record stays adoptable.
 *
 * The interruption budget is per REPO, not per window: `gate.ts` documents it as
 * "≤ maxPerSession per session", and opening a second terminal used to rewrite
 * session.json with a fresh budget, so the guarantee was false — a sibling
 * window refilled the counter and nulled the cooldown. A second window now joins
 * the running budget instead of resetting it.
 *
 * That needs an end, or the budget would never refill again. "Session" therefore
 * means a work period in this repo, ended by going quiet, rather than a window
 * being opened or closed — which is also the quantity the study is actually
 * about (how often was this person interrupted while working), and it is
 * measured the same whether they use one terminal or four.
 */
const SESSION_ADOPT_WINDOW_MS = 4 * 60 * 60 * 1000;

/**
 * True when `session` is still the current work period and should be adopted
 * rather than replaced. Measured from the later of its start and its last
 * intervention, so an active session never expires under someone's hands.
 */
export function isSessionAdoptable(
  session: SessionRecord,
  now: number = Date.now(),
): boolean {
  const started = Date.parse(session.startedAt);
  const lastAt = session.lastInterventionAt ? Date.parse(session.lastInterventionAt) : NaN;
  const marks = [started, lastAt].filter((n) => Number.isFinite(n));
  if (marks.length === 0) return false; // no usable timestamp — treat as expired
  // Math.abs so a record stamped in the FUTURE (clock skew, a restored backup)
  // expires like any other instead of being adoptable forever, which would
  // freeze the budget in whatever state it was last written.
  return Math.abs(now - Math.max(...marks)) < SESSION_ADOPT_WINDOW_MS;
}

const lockPath = (dir: string): string => path.join(dir, 'session.lock');

/** A lock older than this is presumed abandoned (a crashed process). */
const LOCK_STALE_MS = 5_000;
/** Give up acquiring rather than blow the hook's latency budget. */
const LOCK_WAIT_MS = 400;
const LOCK_POLL_MS = 15;

/** Sleep synchronously — the gate path is sync end-to-end and must stay simple. */
function sleepSync(ms: number): void {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

/**
 * Try to remove a lock judged abandoned, returning true only if THIS caller is
 * the one that removed it.
 *
 * Removing it must itself be atomic. Stat-then-unlink is not: two processes both
 * judge the same lock stale, both unlink, and the second one deletes the first
 * one's freshly created LIVE lock, so both end up inside — the exact race the
 * lock exists to prevent (reproduced at 8-way concurrency). Renaming to a unique
 * name can succeed for only one caller; everyone else gets ENOENT because the
 * source is already gone, and they fall back to waiting normally.
 */
function reclaimStaleLock(lock: string): boolean {
  const dead = `${lock}.dead.${process.pid}.${Date.now().toString(36)}`;
  try {
    fs.renameSync(lock, dead);
  } catch {
    return false; // someone else claimed the removal, or we cannot write here
  }
  try {
    fs.unlinkSync(dead);
  } catch {
    /* the rename already freed the lock name — this is only tidying */
  }
  return true;
}

/**
 * Run `fn` holding an exclusive lock on this repo's session record, or return
 * `null` if the lock could not be taken in time.
 *
 * The gate reads the budget, decides, and writes the spent slot back. Two
 * commits landing together both read the same pre-spend counter and both fire,
 * so the budget was advisory even within one window. Returning `null` on
 * contention is deliberate: the caller treats it as "someone else is deciding
 * right now" and allows the commit. Failing toward NOT interrupting is the
 * correct bias for a gate whose whole design goal is minimal interruption.
 *
 * Every path through the loop either makes progress or sleeps, and the deadline
 * is checked on every iteration — an earlier version checked it only on the
 * sleep path, so a stale lock that could not be unlinked (read-only state dir,
 * immutable file) spun at 100% CPU forever instead of giving up at 400 ms.
 */
export function withSessionLock<T>(dir: string, fn: () => T): T | null {
  ensureStateDir(dir);
  const lock = lockPath(dir);
  // Identifies THIS acquisition, so release can refuse to delete a lock that
  // was reclaimed out from under a stalled holder.
  const token = `${process.pid}:${crypto.randomUUID()}`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let acquired = false;

  while (Date.now() < deadline) {
    try {
      // 'wx' fails if the path exists — an atomic test-and-set on every platform
      // this runs on, with no dependency.
      fs.writeFileSync(lock, `${token}\n`, { flag: 'wx' });
      acquired = true;
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return null;
    }

    let ageMs: number;
    try {
      // Math.abs so a lock stamped in the FUTURE (clock skew, a restored
      // backup) is still reclaimable instead of disabling the gate forever.
      ageMs = Math.abs(Date.now() - fs.statSync(lock).mtimeMs);
    } catch {
      continue; // vanished between the create and the stat — retry immediately
    }

    // A successful reclaim means the name is free right now, so retry at once;
    // anything else waits. Never loop without progress or a sleep.
    if (ageMs > LOCK_STALE_MS && reclaimStaleLock(lock)) continue;
    sleepSync(LOCK_POLL_MS);
  }

  if (!acquired) return null;

  try {
    return fn();
  } finally {
    // Release only a lock we still hold. A holder that stalled past the stale
    // window loses it to a reclaimer; unlinking unconditionally would then
    // delete the SUCCESSOR's live lock on the way out.
    try {
      if (fs.readFileSync(lock, 'utf8').trim() === token) fs.unlinkSync(lock);
    } catch {
      /* gone, or no longer ours — nothing to release */
    }
  }
}

// ---------------------------------------------------------------------------
// pending-edits.json  (PreToolUse → PostToolUse pairing for diff_review)
// ---------------------------------------------------------------------------

/**
 * Proposal timestamps from `PreToolUse(Edit|Write|MultiEdit)`, awaiting the
 * paired `PostToolUse` to close them into a `diff_review` evidence row
 * (PLAN §5 `diff_review`, §7.2).
 *
 * Keys are opaque to this module — the CLI builds them from session id + target
 * file so concurrent sessions can't close each other's pairs. Values are ISO-8601.
 *
 * Kept in its own file rather than session.json so the per-edit hook path never
 * contends with the gate's session/budget writes.
 */
export type PendingEdits = Record<string, string>;

/** Proposals older than this are abandoned (the edit was rejected or lost). */
const PENDING_EDIT_TTL_MS = 10 * 60 * 1000;
/** Hard cap so a pathological session can't grow the file without bound. */
const PENDING_EDIT_MAX = 64;

/** Read pending-edits.json, dropping expired and malformed entries. */
export function readPendingEdits(dir: string, now: number = Date.now()): PendingEdits {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(paths.pendingEdits(dir), 'utf8'));
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};

  const out: PendingEdits = {};
  for (const [file, ts] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof ts !== 'string') continue;
    const at = Date.parse(ts);
    if (!Number.isFinite(at) || now - at > PENDING_EDIT_TTL_MS) continue;
    out[file] = ts;
  }
  return out;
}

/**
 * Write pending-edits.json, keeping only the most recent PENDING_EDIT_MAX
 * entries. Best-effort: a write failure must never break the edit hook.
 */
export function writePendingEdits(dir: string, pending: PendingEdits): void {
  const entries = Object.entries(pending)
    .sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0))
    .slice(0, PENDING_EDIT_MAX);
  try {
    ensureStateDir(dir);
    fs.writeFileSync(
      paths.pendingEdits(dir),
      JSON.stringify(Object.fromEntries(entries), null, 2) + '\n',
    );
  } catch {
    /* fail open — evidence capture is never worth breaking an edit over */
  }
}

// ---------------------------------------------------------------------------
// coverage-memory (.scale/) paper scan — for `map index`
// ---------------------------------------------------------------------------

/**
 * Minimal frontmatter scan of a coverage-memory `.scale/` dir. Extracts just
 * `id` and `sources` from each `README.md` — the two fields
 * `buildFileComponentIndex` needs. Deliberately lightweight (no YAML dep); the
 * authoritative paper parser lives in the Mode-B builder skill, not the CLI.
 */
export function scanPapers(scaleDir: string): { id: string; sources: string[] }[] {
  const papers: { id: string; sources: string[] }[] = [];

  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile() && e.name.toLowerCase() === 'readme.md') {
        const paper = parseFrontmatter(full);
        if (paper) papers.push(paper);
      }
    }
  };

  walk(scaleDir);
  return papers;
}

function parseFrontmatter(file: string): { id: string; sources: string[] } | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const block = match?.[1];
  if (!block) return null;

  const idMatch = /^id:\s*(.+)$/m.exec(block);
  const idRaw = idMatch?.[1];
  if (!idRaw) return null;
  const id = idRaw.trim().replace(/^["']|["']$/g, '');

  // Collect the YAML list under `sources:` (indented `- path` lines).
  const sources: string[] = [];
  const lines = block.split(/\r?\n/);
  const start = lines.findIndex((l) => /^sources:\s*$/.test(l));
  if (start >= 0) {
    for (let i = start + 1; i < lines.length; i++) {
      const l = lines[i] ?? '';
      const item = /^\s+-\s+(.+)$/.exec(l);
      if (item?.[1]) {
        sources.push(item[1].trim().replace(/^["']|["']$/g, ''));
      } else if (/^\S/.test(l)) {
        break; // next top-level key
      }
    }
  }
  return { id, sources };
}
