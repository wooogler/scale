import { execFileSync } from 'node:child_process';
import {
  configChangeRows,
  flattenLeaves,
  loadScaleDir,
  resolveConfig,
  POLICY_SECTIONS,
  type ScaleConfig,
  type TelemetryRow,
  type OutOfBandRow,
} from '@scale/core';
import { appendTelemetry, readTelemetrySafe } from './telemetry-append.js';
import {
  readPolicyRaw,
  readSessionSafe,
  readLocksSafe,
  loadEffectiveConfig,
  paths,
  type SessionRecord,
} from './state.js';
import { myIdentities, loadFileComponentIndex } from './coverage.js';
import fs from 'node:fs';

export { appendTelemetry, readTelemetrySafe, telemetryPath } from './telemetry-append.js';

function nowIso(): string {
  return new Date().toISOString();
}

function currentSessionId(dir: string): string | null {
  return readSessionSafe(dir)?.sessionId ?? null;
}

/**
 * Leaf paths the team policy actually names (reduced to its allowed sections),
 * plus the flattened policy-only effective config — what the user would be
 * running under with no personal file at all.
 */
function policyView(cwd: string, user: string): {
  leaves: Record<string, unknown>;
  paths: Set<string>;
} {
  const policy = readPolicyRaw(cwd);
  const raw = policy.parseError ? undefined : policy.raw;
  const resolved = resolveConfig({ user }, raw);
  const named = new Set<string>();
  if (resolved.policyApplied && raw && typeof raw === 'object') {
    const overlay: Record<string, unknown> = {};
    for (const s of POLICY_SECTIONS) {
      const v = (raw as Record<string, unknown>)[s];
      if (v !== undefined) overlay[s] = v;
    }
    for (const p of Object.keys(flattenLeaves(overlay))) named.add(p);
  }
  return { leaves: flattenLeaves(resolved.config), paths: named };
}

/**
 * Record every effective-config leaf that changed between `before` and `after`
 * as config_change rows. Called by the three writers (CLI set/unset, web
 * settings PATCH/unset) AFTER the file landed, so a rejected write logs nothing.
 */
export function recordConfigDelta(
  dir: string,
  cwd: string,
  before: ScaleConfig,
  after: ScaleConfig,
  source: 'cli' | 'web',
  reset: boolean,
): number {
  const pv = policyView(cwd, after.user);
  const rows = configChangeRows(before, after, pv.leaves, pv.paths, {
    ts: nowIso(),
    user: after.user,
    sessionId: currentSessionId(dir),
    source,
    reset,
  });
  let n = 0;
  for (const r of rows) if (appendTelemetry(dir, r)) n++;
  return n;
}

// ---------------------------------------------------------------------------
// Out-of-band edits (PLAN-GATE §6: "우회 신호는 측정 대상")
// ---------------------------------------------------------------------------

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', ['-c', 'core.quotepath=off', ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
  } catch {
    return '';
  }
}

/**
 * Components whose sources changed during the period WITHOUT any Edit/Write
 * reaching the gate for them — the edit went around Claude Code's tools.
 *
 * Two places a change can show: commits the user authored since the period
 * began (`git log --since`), and the working tree (`git diff HEAD`, plus
 * untracked files). Both are mapped through the exact file→component index,
 * the same way the gate maps them. A component counts only if it was NOT
 * unlocked at period end (an unlocked territory can be edited any way one
 * likes) and had no `touch` evidence during the period — touch rows are what
 * the PostToolUse hook writes for every edit that DID go through the tools.
 *
 * Reads git once per period (SessionEnd), never on the edit path.
 */
export function outOfBandEdits(
  cwd: string,
  dir: string,
  session: SessionRecord,
  now: string = nowIso(),
): OutOfBandRow[] {
  if (!session.startedAt) return [];
  const index = loadFileComponentIndex(cwd, loadScaleDir(cwd));
  const toComponents = (files: string[]): Set<string> => {
    const out = new Set<string>();
    for (const f of files) for (const id of index[f] ?? []) out.add(id);
    return out;
  };

  const me = [...myIdentities(cwd, loadEffectiveConfig(cwd, dir).config)];
  const authorArgs = me.flatMap((e) => ['--author', e]);
  const committed = git(cwd, [
    'log',
    `--since=${session.startedAt}`,
    '--name-only',
    '--format=',
    '--no-merges',
    ...authorArgs,
  ])
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const worktree = [
    ...git(cwd, ['diff', '--name-only', 'HEAD']).split('\n'),
    ...git(cwd, ['ls-files', '--others', '--exclude-standard']).split('\n'),
  ]
    .map((s) => s.trim())
    .filter(Boolean);

  const inCommits = toComponents(committed);
  const inWorktree = toComponents(worktree);
  const changed = new Set([...inCommits, ...inWorktree]);
  if (changed.size === 0) return [];

  // Components an in-tool edit touched this period.
  const touched = new Set<string>();
  const denied = new Set<string>();
  const since = Date.parse(session.startedAt);
  try {
    for (const line of fs.readFileSync(paths.evidence(dir), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let e: { type?: string; ts?: string; componentIds?: string[]; componentId?: string; outcome?: string };
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (!e.ts || Date.parse(e.ts) < since) continue;
      if (e.type === 'touch') for (const id of e.componentIds ?? []) touched.add(id);
      if (e.type === 'intervention' && e.outcome === 'requested' && e.componentId) denied.add(e.componentId);
    }
  } catch {
    /* no evidence yet */
  }

  const unlocked = new Set(Object.keys(readLocksSafe(dir).components));
  const rows: OutOfBandRow[] = [];
  for (const id of [...changed].sort()) {
    if (unlocked.has(id) || touched.has(id)) continue;
    rows.push({
      v: 1,
      type: 'out_of_band',
      ts: now,
      user: session.sessionId ? (readSessionUser(dir) ?? 'user') : 'user',
      sessionId: session.sessionId,
      component: id,
      seenIn: inCommits.has(id) && inWorktree.has(id) ? 'both' : inCommits.has(id) ? 'commits' : 'worktree',
      deniedThisSession: denied.has(id),
    });
  }
  return rows;
}

function readSessionUser(dir: string): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(paths.config(dir), 'utf8')) as { user?: unknown };
    return typeof raw.user === 'string' ? raw.user : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Summary (scale telemetry summary)
// ---------------------------------------------------------------------------

export interface TelemetrySummary {
  rows: number;
  byType: Record<string, number>;
  sessions: number;
  denies: number;
  redenies: number;
  skips: { user: number; agent: number };
  redirects: number;
  outOfBand: number;
  unlocks: number;
  recoveries: number;
  relocks: number;
  overrides: { loosen: number; tighten: number; neutral: number; unknown: number; resets: number };
  /**
   * Of the components the gate denied, the share that were NEVER unlocked
   * anywhere in the log — the user routed around them (skip, redirect,
   * out-of-band) or simply stopped. Per component, not per signal, so one deny
   * with three avoidance rows still counts once.
   */
  avoidanceRate: number | null;
  deniedComponents: number;
  unlockedAfterDeny: number;
  /** How long owed checks took to clear, ms, median over unlocks that were owed. */
  medianOwedMs: number | null;
}

export function summarizeTelemetry(rows: TelemetryRow[]): TelemetrySummary {
  const byType: Record<string, number> = {};
  const s: TelemetrySummary = {
    rows: rows.length,
    byType,
    sessions: 0,
    denies: 0,
    redenies: 0,
    skips: { user: 0, agent: 0 },
    redirects: 0,
    outOfBand: 0,
    unlocks: 0,
    recoveries: 0,
    relocks: 0,
    overrides: { loosen: 0, tighten: 0, neutral: 0, unknown: 0, resets: 0 },
    avoidanceRate: null,
    deniedComponents: 0,
    unlockedAfterDeny: 0,
    medianOwedMs: null,
  };
  const owed: number[] = [];
  const denied = new Set<string>();
  const unlockedIds = new Set<string>();
  for (const r of rows) {
    byType[r.type] = (byType[r.type] ?? 0) + 1;
    switch (r.type) {
      case 'session_end':
        s.sessions++;
        break;
      case 'gate':
        if (r.decision === 'deny') {
          s.denies++;
          denied.add(r.component);
        } else if (r.decision === 'redeny') s.redenies++;
        break;
      case 'skip':
        s.skips[r.by]++;
        break;
      case 'redirect':
        s.redirects++;
        break;
      case 'out_of_band':
        s.outOfBand++;
        break;
      case 'unlock':
        s.unlocks++;
        unlockedIds.add(r.component);
        if (r.recovery) s.recoveries++;
        if (r.owedMs !== null) owed.push(r.owedMs);
        break;
      case 'relock':
        s.relocks++;
        break;
      case 'config_change':
        if (r.reset) s.overrides.resets++;
        if (r.direction === null) s.overrides.unknown++;
        else s.overrides[r.direction]++;
        break;
    }
  }
  s.deniedComponents = denied.size;
  s.unlockedAfterDeny = [...denied].filter((id) => unlockedIds.has(id)).length;
  if (denied.size > 0) s.avoidanceRate = 1 - s.unlockedAfterDeny / denied.size;
  if (owed.length > 0) {
    const sorted = [...owed].sort((a, b) => a - b);
    s.medianOwedMs = sorted[Math.floor(sorted.length / 2)]!;
  }
  return s;
}
