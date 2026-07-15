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
