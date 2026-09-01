import { z } from 'zod';

/**
 * Study telemetry — the SHIPPABLE stream (PLAN-GATE §4 S4, §15).
 *
 * Why a second file next to evidence.jsonl. Evidence is the comprehension
 * model's input: prompts (with text), touches (with file paths), quiz scores.
 * It stays on the participant's machine. Telemetry is what a deployment study
 * needs to answer "did people learn, or did they route around the gate?" —
 * and it is written from day one so that the collection path, when it is
 * decided, ships ONE file with a contract that was designed to leave the
 * machine: no prompt text, no file contents, no file paths, no collaborator
 * addresses. Component ids are the only repo-specific names, and those are the
 * team's own paper titles.
 *
 * Every row carries `v` so a reader can tell which contract wrote it, and
 * `sessionId` so rows can be grouped into the same working period the budget
 * uses. Rows are append-only; nothing rewrites history.
 */

const base = {
  v: z.literal(1),
  /** ISO-8601. */
  ts: z.string(),
  user: z.string(),
  /** Budget-period id (session.json) — null when written outside any session. */
  sessionId: z.string().nullable(),
};

/**
 * Whether an override made the gate EASIER to get past, HARDER, or changed
 * something orthogonal (modality, language). `null` when the knob is not in the
 * table — the analysis can still see `path`/`from`/`to`, it just gets no free
 * label. Knobs that only affect the comprehension model, not permission, are
 * `neutral` except `thresholds.validateDim`, which sets how easily a component
 * reads as validated (= unlocked without the ledger).
 */
export const OverrideDirectionSchema = z.enum(['loosen', 'tighten', 'neutral']);
export type OverrideDirection = z.infer<typeof OverrideDirectionSchema>;

/** One leaf of the effective config changed. One row per leaf, never per save. */
export const ConfigChangeRowSchema = z.object({
  ...base,
  type: z.literal('config_change'),
  /** Dotted leaf path in the effective config, e.g. `gate.enforcement`. */
  path: z.string(),
  from: z.unknown(),
  to: z.unknown(),
  /** Where the write came from. */
  source: z.enum(['cli', 'web']),
  /**
   * True when this change REMOVED a personal override, letting the team
   * default (or schema default) show through again — the S4 reset affordance.
   */
  reset: z.boolean(),
  /** The team-policy value for this path at the time, or null if policy is silent. */
  policyValue: z.unknown().nullable(),
  direction: OverrideDirectionSchema.nullable(),
});

/**
 * Why a gate decision landed on this component. `drift_*` means the territory
 * had been unlocked and was re-locked by a collaborator's (or own) changes.
 */
export const GateCauseSchema = z.enum(['locked', 'drift_foreign', 'drift_self']);

/**
 * A gate decision that DID something. Plain allows are not rows — they are
 * every edit — and are counted in `session_end` instead.
 */
export const GateRowSchema = z.object({
  ...base,
  type: z.literal('gate'),
  decision: z.enum(['deny', 'redeny', 'advisory']),
  component: z.string(),
  cause: GateCauseSchema,
  enforcement: z.enum(['advisory', 'soft', 'hard']),
  assessment: z.enum(['sync', 'async']),
  modality: z.enum(['quiz', 'socratic']),
  /** Interruptions spent this period AFTER this decision, vs the cap. */
  budgetUsed: z.number().int().nonnegative(),
  budgetMax: z.number().int().nonnegative(),
});

/** `scale gate defer`: the user (or the agent) skipped the check. */
export const SkipRowSchema = z.object({
  ...base,
  type: z.literal('skip'),
  component: z.string(),
  by: z.enum(['user', 'agent']),
  enforcement: z.enum(['advisory', 'soft', 'hard']),
  /** Time since the most recent deny in this period, or null if none was recorded. */
  msSinceDeny: z.number().nonnegative().nullable(),
});

/**
 * REDIRECT — the first shape of avoidance the gate can see itself: while a
 * deny is still outstanding (no check passed, no skip), an edit was ALLOWED
 * somewhere else. `editedInstead` names the components that edit landed on;
 * `unanchoredFiles` counts files no paper anchors, which the gate cannot
 * attribute at all. A redirect is not proof of avoidance — the user may have
 * legitimately moved on — which is why the row records the gap and the target
 * and leaves the judgement to the analysis.
 */
export const RedirectRowSchema = z.object({
  ...base,
  type: z.literal('redirect'),
  denied: z.string(),
  editedInstead: z.array(z.string()),
  unanchoredFiles: z.number().int().nonnegative(),
  msSinceDeny: z.number().nonnegative(),
});

/**
 * OUT-OF-BAND — the second shape, measured at period end from git: a LOCKED
 * component's sources changed during the period (committed by the user, or
 * sitting in the working tree) while no Edit/Write ever reached the gate for
 * it. That is an edit that went around Claude Code's tools (a shell command,
 * another editor). PLAN-GATE §6 says such edits cannot be gated and ARE the
 * signal; this is that signal.
 */
export const OutOfBandRowSchema = z.object({
  ...base,
  type: z.literal('out_of_band'),
  component: z.string(),
  /** How the change was seen: in commits authored by the user, or uncommitted. */
  seenIn: z.enum(['commits', 'worktree', 'both']),
  /** A deny for this component was recorded this period. */
  deniedThisSession: z.boolean(),
});

/** The ledger unlocked a component after a passed check. */
export const UnlockRowSchema = z.object({
  ...base,
  type: z.literal('unlock'),
  component: z.string(),
  via: z.enum(['record', 'quiz', 'socratic']),
  meanScore: z.number().min(0).max(1),
  checks: z.number().int().positive(),
  /** How long the component sat as an owed check (async), or null if it never did. */
  owedMs: z.number().nonnegative().nullable(),
  /** The unlock recovered a re-locked (drifted) territory. */
  recovery: z.boolean(),
});

/** Drift re-locked a component. Authors are COUNTED, never named. */
export const RelockRowSchema = z.object({
  ...base,
  type: z.literal('relock'),
  component: z.string(),
  cause: z.enum(['foreign', 'self']),
  foreignAuthors: z.number().int().nonnegative(),
});

/** Per-period counters, written when the last window closes. */
export const SessionEndRowSchema = z.object({
  ...base,
  type: z.literal('session_end'),
  startedAt: z.string(),
  durationMs: z.number().nonnegative(),
  edits: z.number().int().nonnegative(),
  allows: z.number().int().nonnegative(),
  denies: z.number().int().nonnegative(),
  redenies: z.number().int().nonnegative(),
  advisories: z.number().int().nonnegative(),
  redirects: z.number().int().nonnegative(),
  skips: z.number().int().nonnegative(),
  /** Ledger state at close. */
  unlocked: z.number().int().nonnegative(),
  owed: z.number().int().nonnegative(),
  components: z.number().int().nonnegative(),
});

export const TelemetryRowSchema = z.discriminatedUnion('type', [
  ConfigChangeRowSchema,
  GateRowSchema,
  SkipRowSchema,
  RedirectRowSchema,
  OutOfBandRowSchema,
  UnlockRowSchema,
  RelockRowSchema,
  SessionEndRowSchema,
]);
export type TelemetryRow = z.infer<typeof TelemetryRowSchema>;
export type ConfigChangeRow = z.infer<typeof ConfigChangeRowSchema>;
export type GateRow = z.infer<typeof GateRowSchema>;
export type SkipRow = z.infer<typeof SkipRowSchema>;
export type RedirectRow = z.infer<typeof RedirectRowSchema>;
export type OutOfBandRow = z.infer<typeof OutOfBandRowSchema>;
export type UnlockRow = z.infer<typeof UnlockRowSchema>;
export type RelockRow = z.infer<typeof RelockRowSchema>;
export type SessionEndRow = z.infer<typeof SessionEndRowSchema>;

// ---------------------------------------------------------------------------
// Override direction
// ---------------------------------------------------------------------------

const ENFORCEMENT_RANK: Record<string, number> = { advisory: 0, soft: 1, hard: 2 };

function numeric(from: unknown, to: unknown): [number, number] | null {
  return typeof from === 'number' && typeof to === 'number' && Number.isFinite(from) && Number.isFinite(to)
    ? [from, to]
    : null;
}

/** `lowerLoosens`: a smaller value makes the gate easier to pass. */
function byNumber(from: unknown, to: unknown, lowerLoosens: boolean): OverrideDirection | null {
  const n = numeric(from, to);
  if (!n) return null;
  if (n[0] === n[1]) return 'neutral';
  const wentDown = n[1] < n[0];
  return wentDown === lowerLoosens ? 'loosen' : 'tighten';
}

/**
 * Classify one override. The table is the study's operational definition of
 * "loosening", so it is deliberately small and literal; anything not listed
 * returns null rather than guessing.
 */
export function overrideDirection(path: string, from: unknown, to: unknown): OverrideDirection | null {
  switch (path) {
    case 'gate.enabled':
      if (from === to) return 'neutral';
      return to === false ? 'loosen' : 'tighten';
    case 'gate.enforcement': {
      const a = ENFORCEMENT_RANK[String(from)];
      const b = ENFORCEMENT_RANK[String(to)];
      if (a === undefined || b === undefined) return null;
      return a === b ? 'neutral' : b < a ? 'loosen' : 'tighten';
    }
    case 'gate.assessment':
    case 'gate.modality':
    case 'drift.digest':
    case 'drift.shareDiff':
    case 'budgets.sessionIdleResetMinutes':
    case 'language':
    case 'user':
      return 'neutral';
    case 'budgets.maxPerSession':
      return byNumber(from, to, true);
    case 'budgets.cooldownMinutes':
      return byNumber(from, to, false);
    case 'unlock.passBar':
    case 'unlock.checksRequired':
    case 'thresholds.validateDim':
      return byNumber(from, to, true);
    case 'drift.foreignRatio':
    case 'drift.selfRatio':
      return byNumber(from, to, false);
    case 'drift.trigger':
      if (from === to) return 'neutral';
      return to === 'ratio' ? 'loosen' : 'tighten';
    case 'exempt.paths': {
      const a = Array.isArray(from) ? from.length : null;
      const b = Array.isArray(to) ? to.length : null;
      if (a === null || b === null) return null;
      return a === b ? 'neutral' : b > a ? 'loosen' : 'tighten';
    }
    default:
      if (path.startsWith('models.') || path.startsWith('identity.') || path.startsWith('thresholds.')) {
        return 'neutral';
      }
      return null;
  }
}

/**
 * Leaf paths of a config-shaped object. Arrays are leaves (an exempt list is one
 * setting, not N), so are null/primitives. Sorted for stable diffs.
 */
export function flattenLeaves(obj: unknown, prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    if (prefix) out[prefix] = obj;
    return out;
  }
  for (const k of Object.keys(obj as Record<string, unknown>).sort()) {
    Object.assign(out, flattenLeaves((obj as Record<string, unknown>)[k], prefix ? `${prefix}.${k}` : k));
  }
  return out;
}

/** Deep-equal for JSON-shaped values (what a config holds). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Diff two EFFECTIVE configs into config_change rows. `policyLeaves` is the
 * flattened policy-only effective config (schema defaults + team policy, no
 * user file) so each row can say what the team would have had — and so `reset`
 * rows can be recognised by the reader even without the flag: after a reset,
 * `to` equals `policyValue`.
 */
export function configChangeRows(
  before: unknown,
  after: unknown,
  policyLeaves: Record<string, unknown>,
  policyPaths: ReadonlySet<string>,
  meta: { ts: string; user: string; sessionId: string | null; source: 'cli' | 'web'; reset: boolean },
): ConfigChangeRow[] {
  const a = flattenLeaves(before);
  const b = flattenLeaves(after);
  const rows: ConfigChangeRow[] = [];
  for (const path of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (jsonEqual(a[path], b[path])) continue;
    rows.push({
      v: 1,
      type: 'config_change',
      ts: meta.ts,
      user: meta.user,
      sessionId: meta.sessionId,
      path,
      from: a[path] ?? null,
      to: b[path] ?? null,
      source: meta.source,
      reset: meta.reset,
      policyValue: policyPaths.has(path) ? (policyLeaves[path] ?? null) : null,
      direction: overrideDirection(path, a[path], b[path]),
    });
  }
  return rows;
}
