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
import { appendTelemetry } from './telemetry-append.js';
import { promises as fsp } from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

import {
  ScaleConfigSchema,
  type ScaleConfig,
  resolveConfig,
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
  locks: (dir: string) => path.join(dir, 'locks.json'),
  telemetry: (dir: string) => path.join(dir, 'telemetry.jsonl'),
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

/**
 * Read the user config file RAW — no schema, no defaults. This is the shape the
 * layering needs (PLAN-GATE §2): the file stores only explicit choices, and a
 * parsed-and-defaulted view cannot tell "user chose 2" from "default is 2".
 * Returns null when absent or unparseable.
 */
export function readUserConfigRaw(dir: string): Record<string, unknown> | null {
  try {
    const raw = JSON.parse(fs.readFileSync(paths.config(dir), 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Write the user config file SPARSE — exactly the given raw object, which must
 * already have been validated by the caller (via `resolveConfig` against the
 * current policy, so a bad value is rejected before it lands on disk). Never
 * write a fully materialized `ScaleConfig` here: that would turn every schema
 * default into an explicit user override and permanently shadow team policy.
 */
export function writeUserConfigRaw(dir: string, raw: Record<string, unknown>): void {
  ensureStateDir(dir);
  fs.writeFileSync(paths.config(dir), JSON.stringify(raw, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// effective config  (schema defaults < .scale/policy.json < user config.json)
// ---------------------------------------------------------------------------

/** Read `<cwd>/.scale/policy.json` raw. `parseError` = present but not JSON. */
export function readPolicyRaw(cwd: string): {
  present: boolean;
  raw: unknown;
  parseError: boolean;
} {
  const p = path.join(cwd, '.scale', 'policy.json');
  if (!fs.existsSync(p)) return { present: false, raw: undefined, parseError: false };
  try {
    return { present: true, raw: JSON.parse(fs.readFileSync(p, 'utf8')), parseError: false };
  } catch {
    return { present: true, raw: undefined, parseError: true };
  }
}

export interface EffectiveConfig {
  config: ScaleConfig;
  /** A committed policy file exists (even if it failed to apply). */
  policyPresent: boolean;
  /** The policy actually contributed defaults to `config`. */
  policyApplied: boolean;
  /** Why a present policy was ignored, or null. */
  policyError: string | null;
}

/**
 * The one config read path for every consumer that acts on configuration —
 * gate, quests, tutor context, serve. Never throws: a corrupt user file is
 * treated as absent (schema defaults + policy), matching the old
 * `readConfigSafe(dir) ?? parse({user})` fail-open contract.
 */
export function loadEffectiveConfig(cwd: string, dir: string): EffectiveConfig {
  const user = readUserConfigRaw(dir) ?? { user: process.env.USER ?? 'user' };
  if (typeof user.user !== 'string' || !user.user) user.user = process.env.USER ?? 'user';
  const policy = readPolicyRaw(cwd);
  const jsonError = policy.parseError ? 'policy.json is not valid JSON' : null;
  try {
    const resolved = resolveConfig(user, policy.raw);
    return {
      config: resolved.config,
      policyPresent: policy.present,
      policyApplied: resolved.policyApplied,
      policyError: jsonError ?? resolved.policyError,
    };
  } catch {
    // User file invalid beyond repair — schema defaults, still under policy.
    const fallback = resolveConfig({ user: process.env.USER ?? 'user' }, policy.raw);
    return {
      config: fallback.config,
      policyPresent: policy.present,
      policyApplied: fallback.policyApplied,
      policyError: jsonError ?? fallback.policyError,
    };
  }
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
  /**
   * Claude Code windows currently attached to this repo. SessionStart increments
   * it, SessionEnd decrements it, and the budget period ends when it reaches
   * zero — which is what makes "per session" mean a period of work rather than
   * a window, so opening a second terminal shares the budget instead of
   * refilling it.
   */
  openWindows: number;
  /**
   * Components the user chose to SKIP this budget period (PLAN-GATE §3.1):
   * under `soft` enforcement, `scale gate defer` is a session-scoped unlock —
   * the edit gate stops firing on these until the period ends, then they lock
   * again. Dies with the record, which is exactly the intended lifetime.
   */
  sessionSkips: string[];
  /**
   * Per-period tallies for the `session_end` telemetry row (PLAN-GATE S4).
   * `edits` is every gate call; the rest partition its outcomes. `redirects`
   * counts allowed edits elsewhere while a deny was outstanding.
   */
  counters: SessionCounters;
  /** When the most recent deny fired this period — the clock `skip`/`redirect` measure from. */
  lastDenyAt: string | null;
}

export interface SessionCounters {
  edits: number;
  allows: number;
  denies: number;
  redenies: number;
  advisories: number;
  redirects: number;
  skips: number;
}

export function zeroCounters(): SessionCounters {
  return { edits: 0, allows: 0, denies: 0, redenies: 0, advisories: 0, redirects: 0, skips: 0 };
}

/** A brand-new session record (fresh budget). */
export function defaultSession(sessionId: string, startedAt: string): SessionRecord {
  return {
    sessionId,
    startedAt,
    interventionsThisSession: 0,
    lastInterventionAt: null,
    pendingComponent: null,
    openWindows: 0,
    sessionSkips: [],
    counters: zeroCounters(),
    lastDenyAt: null,
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
      // Clamped at 0: a lost SessionEnd must not drive this negative, and a
      // record written before this field existed reads as "unknown" → 0.
      openWindows:
        typeof raw.openWindows === 'number' && Number.isFinite(raw.openWindows)
          ? Math.max(0, Math.trunc(raw.openWindows))
          : 0,
      sessionSkips: Array.isArray(raw.sessionSkips)
        ? raw.sessionSkips.filter((s): s is string => typeof s === 'string')
        : [],
      counters: readCounters(raw.counters),
      lastDenyAt: typeof raw.lastDenyAt === 'string' ? raw.lastDenyAt : null,
    };
  } catch {
    return null;
  }
}

function readCounters(raw: unknown): SessionCounters {
  const out = zeroCounters();
  if (raw && typeof raw === 'object') {
    for (const k of Object.keys(out) as (keyof SessionCounters)[]) {
      const v = (raw as Record<string, unknown>)[k];
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = Math.trunc(v);
    }
  }
  return out;
}

/** Write session.json (pretty-printed). */
export function writeSession(dir: string, session: SessionRecord): void {
  ensureStateDir(dir);
  fs.writeFileSync(sessionPath(dir), JSON.stringify(session, null, 2) + '\n');
}

/**
 * True when `session` is still the CURRENT budget period and must not be
 * replaced by a fresh one.
 *
 * The period is ended by SessionEnd bringing `openWindows` to zero — see
 * `budgets.sessionIdleResetMinutes` for why the idle check exists at all. This
 * predicate deliberately does NOT consult `openWindows`: a zero count means the
 * next SessionStart may begin a new period, not that an already-spent budget
 * should be forgotten by everything else. The gate in particular must keep
 * honoring a recent record even in a session where SessionStart never ran (the
 * plugin was enabled mid-session), or it would mint a fresh budget on every
 * commit and fire without limit.
 */
export function isSessionAdoptable(
  session: SessionRecord,
  backstopMs: number,
  now: number = Date.now(),
): boolean {
  const started = Date.parse(session.startedAt);
  const lastAt = session.lastInterventionAt ? Date.parse(session.lastInterventionAt) : NaN;
  const marks = [started, lastAt].filter((n) => Number.isFinite(n));
  if (marks.length === 0) return false; // no usable timestamp — treat as expired
  // Math.abs so a record stamped in the FUTURE (clock skew, a restored backup)
  // expires like any other instead of being adoptable forever, which would
  // freeze the budget in whatever state it was last written.
  return Math.abs(now - Math.max(...marks)) < backstopMs;
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
// locks.json  (the durable per-user unlock ledger — PLAN-GATE §3.1)
// ---------------------------------------------------------------------------

/**
 * One durably unlocked component. Presence in `LocksRecord.components` IS the
 * unlock — partial progress toward `unlock.checksRequired` lives in `progress`
 * instead, so the gate's membership test stays a plain lookup.
 */
export interface LockEntry {
  unlockedAt: string;
  /** HEAD sha at unlock time — rebellion (S2) will compare against this. */
  sha: string;
  /** Passed checks that produced the unlock. */
  checks: number;
  via: 'check';
}

/**
 * A territory that rebelled — re-locked because its code moved after the user
 * had earned it (PLAN-GATE §4 S2).
 *
 * Informational: the RE-LOCK itself is simply the component's absence from
 * `components`. This record exists so the SessionStart digest can say who
 * changed it and the recovery check can be grounded in the right range, and it
 * is cleared when the component is unlocked again.
 */
export interface DriftEntry {
  /** When we noticed. */
  at: string;
  /** Anchor the user had validated at — the recovery diff starts here. */
  sinceSha: string;
  /** Author emails of the foreign commits, sorted. Empty for a self rebellion. */
  foreignAuthors: string[];
  /** Which side of the split tripped the threshold. */
  cause: 'foreign' | 'self';
}

/**
 * A territory the gate denied under ASYNC assessment and the user has not yet
 * dealt with (PLAN-GATE §4 S3). This is the async user's to-do list: the edit
 * was blocked, the agent taught instead of quizzing, and the check is owed
 * later — in the map viewer or via /scale-study. It exists because a DENIED edit
 * leaves no `touch` evidence (the PostToolUse hook never fires), so without it
 * nothing downstream knew which component the user had actually been locked out
 * of: SessionEnd quest generation picked from "touched" components, and the
 * one that mattered was never among them.
 */
export interface PendingUnlock {
  at: string;
  sessionId: string;
}

export interface LocksRecord {
  version: 1;
  components: Record<string, LockEntry>;
  /** Passed-check counts still below `unlock.checksRequired`. */
  progress: Record<string, number>;
  /** Territories re-locked by drift, keyed by component id. */
  drifted: Record<string, DriftEntry>;
  /** Async denies awaiting the user's check, keyed by component id. */
  pendingUnlocks: Record<string, PendingUnlock>;
  /** Last time the SessionStart drift digest was shown (ISO). */
  digestShownAt?: string;
}

export function emptyLocks(): LocksRecord {
  return { version: 1, components: {}, progress: {}, drifted: {}, pendingUnlocks: {} };
}

/** Read locks.json, defaulting structure; malformed entries are dropped. */
export function readLocksSafe(dir: string): LocksRecord {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(paths.locks(dir), 'utf8'));
  } catch {
    return emptyLocks();
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyLocks();
  const r = raw as Record<string, unknown>;
  const out = emptyLocks();
  if (r.components && typeof r.components === 'object' && !Array.isArray(r.components)) {
    for (const [id, v] of Object.entries(r.components as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue;
      const e = v as Record<string, unknown>;
      out.components[id] = {
        unlockedAt: typeof e.unlockedAt === 'string' ? e.unlockedAt : '',
        sha: typeof e.sha === 'string' ? e.sha : '',
        checks: typeof e.checks === 'number' && Number.isFinite(e.checks) ? e.checks : 1,
        via: 'check',
      };
    }
  }
  if (r.progress && typeof r.progress === 'object' && !Array.isArray(r.progress)) {
    for (const [id, v] of Object.entries(r.progress as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) out.progress[id] = Math.trunc(v);
    }
  }
  if (r.drifted && typeof r.drifted === 'object' && !Array.isArray(r.drifted)) {
    for (const [id, v] of Object.entries(r.drifted as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue;
      const e = v as Record<string, unknown>;
      out.drifted[id] = {
        at: typeof e.at === 'string' ? e.at : '',
        sinceSha: typeof e.sinceSha === 'string' ? e.sinceSha : '',
        foreignAuthors: Array.isArray(e.foreignAuthors)
          ? e.foreignAuthors.filter((a): a is string => typeof a === 'string')
          : [],
        cause: e.cause === 'self' ? 'self' : 'foreign',
      };
    }
  }
  if (r.pendingUnlocks && typeof r.pendingUnlocks === 'object' && !Array.isArray(r.pendingUnlocks)) {
    for (const [id, v] of Object.entries(r.pendingUnlocks as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue;
      const e = v as Record<string, unknown>;
      out.pendingUnlocks[id] = {
        at: typeof e.at === 'string' ? e.at : '',
        sessionId: typeof e.sessionId === 'string' ? e.sessionId : '',
      };
    }
  }
  if (typeof r.digestShownAt === 'string') out.digestShownAt = r.digestShownAt;
  return out;
}

/** Record an async deny the user still owes a check for. Idempotent per id. */
export function notePendingUnlock(
  dir: string,
  componentId: string,
  sessionId: string,
  now: string = new Date().toISOString(),
): void {
  withSessionLock(dir, () => {
    const locks = readLocksSafe(dir);
    if (locks.pendingUnlocks[componentId]) return; // keep the first deny's timestamp
    locks.pendingUnlocks[componentId] = { at: now, sessionId };
    writeLocks(dir, locks);
  });
}

/** The user dealt with it — unlocked, or skipped for the session. */
export function clearPendingUnlock(dir: string, componentId: string): void {
  withSessionLock(dir, () => {
    const locks = readLocksSafe(dir);
    if (!locks.pendingUnlocks[componentId]) return;
    delete locks.pendingUnlocks[componentId];
    writeLocks(dir, locks);
  });
}

/**
 * Write the ledger ATOMICALLY (temp file + rename).
 *
 * This file is earned permission, and a bare `writeFileSync` truncates before
 * it writes: a crash or a concurrent read mid-write leaves either a corrupt
 * file or a torn read, and `readLocksSafe` turns both into `emptyLocks()` —
 * silently revoking every unlock the user has ever earned. Rename is atomic on
 * every platform this runs on, so a reader sees either the old file or the new
 * one and never a half of each.
 */
export function writeLocks(dir: string, locks: LocksRecord): void {
  ensureStateDir(dir);
  const target = paths.locks(dir);
  const tmp = `${target}.tmp.${process.pid}.${Date.now().toString(36)}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(locks, null, 2) + '\n');
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* nothing to clean up */
    }
    throw err;
  }
}

/**
 * Register a passed/failed check against the unlock ledger. This is THE single
 * unlock path — `scale record`, `scale quest complete`, and the serve API all
 * funnel through it, so the ledger cannot disagree with itself across surfaces.
 *
 * Rules (PLAN-GATE §3.1, §5-4):
 *  - only `by === 'user'` counts — an agent answering its own quiz must never
 *    unlock territory for itself, whatever it scored;
 *  - the check's mean score must reach `unlock.passBar`;
 *  - `unlock.checksRequired` passed checks accumulate in `progress` before the
 *    component moves into `components` (the actual unlock).
 *
 * Runs under the session lock: record and a concurrent gate decision touch the
 * same directory, and a lost update here would re-lock passed territory.
 */
export function noteCheckOutcome(
  cwd: string,
  dir: string,
  componentId: string,
  meanScore: number,
  by: 'user' | 'agent',
  headSha: string,
  now: string = new Date().toISOString(),
  via: 'record' | 'quiz' | 'socratic' = 'record',
): { unlocked: boolean; alreadyUnlocked: boolean; checks: number } {
  const { config } = loadEffectiveConfig(cwd, dir);
  if (by !== 'user' || !Number.isFinite(meanScore) || meanScore < config.unlock.passBar) {
    const existing = readLocksSafe(dir).components[componentId];
    return { unlocked: false, alreadyUnlocked: !!existing, checks: existing?.checks ?? 0 };
  }

  const result = withSessionLock(dir, () => {
    const locks = readLocksSafe(dir);
    const existing = locks.components[componentId];
    if (existing) {
      existing.checks += 1;
      writeLocks(dir, locks);
      return { unlocked: false, alreadyUnlocked: true, checks: existing.checks };
    }
    const checks = (locks.progress[componentId] ?? 0) + 1;
    if (checks >= config.unlock.checksRequired) {
      const owedSince = locks.pendingUnlocks[componentId]?.at;
      const owedMs = owedSince ? Math.max(0, Date.parse(now) - Date.parse(owedSince)) : null;
      const recovery = !!locks.drifted[componentId];
      delete locks.progress[componentId];
      // Recovering clears the drift note and the async to-do along with the
      // lock — otherwise the digest and the viewer would keep announcing a
      // territory the user has already won back.
      delete locks.drifted[componentId];
      delete locks.pendingUnlocks[componentId];
      locks.components[componentId] = { unlockedAt: now, sha: headSha, checks, via: 'check' };
      writeLocks(dir, locks);
      appendTelemetry(dir, {
        v: 1,
        type: 'unlock',
        ts: now,
        user: config.user,
        sessionId: readSessionSafe(dir)?.sessionId ?? null,
        component: componentId,
        via,
        meanScore: Math.max(0, Math.min(1, meanScore)),
        checks,
        owedMs: Number.isFinite(owedMs as number) ? owedMs : null,
        recovery,
      });
      return { unlocked: true, alreadyUnlocked: false, checks };
    }
    locks.progress[componentId] = checks;
    writeLocks(dir, locks);
    return { unlocked: false, alreadyUnlocked: false, checks };
  });
  // Lock contention: fail toward not-unlocking now — the next passed check (or
  // a retry) gets it. Never toward a phantom unlock.
  return result ?? { unlocked: false, alreadyUnlocked: false, checks: 0 };
}

/**
 * Re-lock every unlocked territory that coverage now reports as `stale`
 * (PLAN-GATE §4 S2). Returns the component ids newly re-locked.
 *
 * WHY IT IS ITS OWN STEP, not part of `recomputeCoverageFromDisk`: recompute is
 * called from eight places, including `scale serve`'s GET /api/coverage — a read
 * endpoint that must not quietly revoke a permission — and from quest
 * generation. Re-locking is a deliberate act, so its callers name themselves:
 * `scale context` (SessionStart, where fresh git-measured drift lands) and
 * `scale gate edit` (so a rebellion any recompute noticed takes effect on the
 * very next edit, without the gate ever running git).
 *
 * Pure file work — the caller supplies the already-computed states, and the
 * optional `detail` only enriches the note. Fails toward NOT re-locking: if the
 * lock is contended, nothing changes and the next caller tries again.
 */
export function syncLocksWithDrift(
  dir: string,
  stateOf: Record<string, { state: string }>,
  detail: Record<string, { sinceSha?: string | null; foreignAuthors?: string[]; cause?: 'foreign' | 'self' }> = {},
  now: string = new Date().toISOString(),
): string[] {
  const current = readLocksSafe(dir);
  const toRelock = Object.keys(current.components).filter(
    (id) => stateOf[id]?.state === 'stale',
  );
  if (toRelock.length === 0) return [];

  const done = withSessionLock(dir, () => {
    // Re-read under the lock: a concurrent check may have just unlocked
    // something, and re-locking a component someone passed a check on a
    // millisecond ago would be exactly the wrong outcome.
    const locks = readLocksSafe(dir);
    const relocked: string[] = [];
    for (const id of toRelock) {
      if (!locks.components[id]) continue; // already gone
      delete locks.components[id];
      delete locks.progress[id];
      const d = detail[id] ?? {};
      locks.drifted[id] = {
        at: now,
        sinceSha: d.sinceSha ?? '',
        foreignAuthors: d.foreignAuthors ?? [],
        cause: d.cause ?? 'foreign',
      };
      relocked.push(id);
    }
    if (relocked.length > 0) writeLocks(dir, locks);
    return relocked;
  });
  if (done && done.length > 0) {
    const user = (readUserConfigRaw(dir)?.user as string | undefined) ?? 'user';
    const sessionId = readSessionSafe(dir)?.sessionId ?? null;
    for (const id of done) {
      const d = detail[id] ?? {};
      appendTelemetry(dir, {
        v: 1,
        type: 'relock',
        ts: now,
        user,
        sessionId,
        component: id,
        cause: d.cause ?? 'foreign',
        foreignAuthors: d.foreignAuthors?.length ?? 0,
      });
    }
  }
  return done ?? [];
}

/**
 * Drop ledger entries for components the map no longer knows (PLAN-GATE §14.4).
 * A doc that was deleted or renamed otherwise leaves a permanent owed check
 * in the SessionStart line and the viewer header. Called where the map is at
 * hand (`scale context`), never from the gate. Returns the ids removed.
 */
export function pruneLocksToKnown(dir: string, knownIds: Iterable<string>): string[] {
  const known = new Set(knownIds);
  const current = readLocksSafe(dir);
  const stray = (o: Record<string, unknown>): string[] => Object.keys(o).filter((id) => !known.has(id));
  const candidates = new Set([
    ...stray(current.components),
    ...stray(current.progress),
    ...stray(current.drifted),
    ...stray(current.pendingUnlocks),
  ]);
  if (candidates.size === 0) return [];
  const done = withSessionLock(dir, () => {
    const locks = readLocksSafe(dir);
    const removed: string[] = [];
    for (const id of candidates) {
      let hit = false;
      for (const table of [locks.components, locks.progress, locks.drifted, locks.pendingUnlocks] as Record<string, unknown>[]) {
        if (id in table) {
          delete table[id];
          hit = true;
        }
      }
      if (hit) removed.push(id);
    }
    if (removed.length > 0) writeLocks(dir, locks);
    return removed;
  });
  return done ?? [];
}

/**
 * Rebellions the SessionStart digest should mention, honoring the cadence knob.
 * `daily` shows at most once per calendar day (UTC), `session` every session,
 * `off` never. Marking is the caller's job via {@link markDigestShown}, so a
 * failed render does not consume the day's notice.
 */
export function pendingDigest(
  dir: string,
  cadence: 'daily' | 'session' | 'off',
  now: Date = new Date(),
): { id: string; entry: DriftEntry }[] {
  if (cadence === 'off') return [];
  const locks = readLocksSafe(dir);
  const ids = Object.keys(locks.drifted).sort();
  if (ids.length === 0) return [];
  if (cadence === 'daily' && locks.digestShownAt) {
    const shown = new Date(locks.digestShownAt);
    if (!Number.isNaN(shown.getTime()) &&
        shown.toISOString().slice(0, 10) === now.toISOString().slice(0, 10)) {
      return [];
    }
  }
  return ids.map((id) => ({ id, entry: locks.drifted[id]! }));
}

/** Stamp the digest as shown (best-effort — a lost stamp only repeats a notice). */
export function markDigestShown(dir: string, now: string = new Date().toISOString()): void {
  withSessionLock(dir, () => {
    const locks = readLocksSafe(dir);
    locks.digestShownAt = now;
    writeLocks(dir, locks);
  });
}

// ---------------------------------------------------------------------------
// coverage-memory (.scale/) doc scan — for `map index`
// ---------------------------------------------------------------------------

/**
 * Minimal frontmatter scan of a coverage-memory `.scale/` dir. Extracts just
 * `id` and `sources` from each `README.md` — the two fields
 * `buildFileComponentIndex` needs. Deliberately lightweight (no YAML dep); the
 * authoritative doc parser lives in the Mode-B builder skill, not the CLI.
 */
export function scanDocs(scaleDir: string): { id: string; sources: string[] }[] {
  const docs: { id: string; sources: string[] }[] = [];

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
        const doc = parseFrontmatter(full);
        if (doc) docs.push(doc);
      }
    }
  };

  walk(scaleDir);
  return docs;
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
