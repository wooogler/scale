import { ScaleConfigSchema, migrateLegacyConfig, type ScaleConfig } from './config.js';

/**
 * Team policy — the lead's DEFAULTS, not rules (PLAN-GATE §0-6, §2).
 *
 * `.scale/policy.json` is committed to the repo, so it distributes with the
 * coverage memory, its history is git history, and "who may change it" is
 * whatever the team's own review process says (CODEOWNERS on the file). Every
 * key a member sets in their own `~/.scale/<repo-id>/config.json` overrides the
 * policy value — legitimately. That is why there is no tamper detection: there
 * is nothing to tamper with, only defaults to differ from, and the differing
 * itself is study data.
 *
 * `identity` is deliberately NOT policy-settable: which git addresses are ME is
 * a personal fact, and a policy that could set it could hand one member another
 * member's attribution.
 *
 * Precedence, leaf-key deep merge:
 *
 *   schema defaults  <  .scale/policy.json  <  user config.json
 *
 * This only works if the user file is SPARSE (stores only explicit choices) —
 * a fully materialized user file would shadow every policy default forever.
 * The CLI/serve writers are responsible for keeping it sparse.
 */

/** The config sections a team policy may default. Everything else is personal. */
export const POLICY_SECTIONS = [
  'gate',
  'unlock',
  'exempt',
  'drift',
  'budgets',
  'thresholds',
] as const;
export type PolicySection = (typeof POLICY_SECTIONS)[number];

export interface ResolvedConfig {
  config: ScaleConfig;
  /** True when a policy overlay contributed to `config`. */
  policyApplied: boolean;
  /**
   * Why the policy was ignored (never thrown — a broken policy.json must fail
   * open to user-only behavior, PLAN-GATE §5-1). Null when applied or absent.
   */
  policyError: string | null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Leaf-key deep merge: objects merge recursively, everything else replaces. */
export function deepMerge(base: unknown, over: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(over)) return over === undefined ? base : over;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out;
}

/**
 * Layer a raw (sparse) user config over a raw team policy and validate the
 * result. The policy is reduced to its allowed sections first, so a policy file
 * can never set personal keys (`user`, `language`, `models`). Any validation
 * failure of the merged shape falls back to the user-only parse — one bad
 * policy value ignores the whole policy, predictably, rather than silently
 * half-applying it.
 *
 * Throws only if the USER config itself does not validate (same contract as
 * `ScaleConfigSchema.parse`); callers with a fail-open need wrap it.
 */
export function resolveConfig(userRaw: unknown, policyRaw?: unknown): ResolvedConfig {
  const user = migrateLegacyConfig(userRaw);

  let policyError: string | null = null;
  if (policyRaw !== undefined && policyRaw !== null) {
    if (!isPlainObject(policyRaw)) {
      policyError = 'policy.json is not a JSON object';
    } else {
      const overlay: Record<string, unknown> = {};
      for (const s of POLICY_SECTIONS) {
        if (policyRaw[s] !== undefined) overlay[s] = policyRaw[s];
      }
      const merged = deepMerge(overlay, user); // user wins
      const parsed = ScaleConfigSchema.safeParse(merged);
      if (parsed.success) {
        return { config: parsed.data, policyApplied: true, policyError: null };
      }
      const issue = parsed.error.issues[0];
      policyError = issue
        ? `${issue.path.join('.') || '(root)'}: ${issue.message}`
        : 'invalid policy values';
    }
  }
  return { config: ScaleConfigSchema.parse(user), policyApplied: false, policyError };
}

// ---------------------------------------------------------------------------
// exempt-path matching (globish: `*` within a segment, `**` across segments)
// ---------------------------------------------------------------------------

function globishToRegExp(pattern: string): RegExp {
  // Split on `**` FIRST so the single-`*` pass cannot eat it; each plain part
  // is regex-escaped, single `*` opens within a segment, `**` across segments.
  const source = pattern
    .split('**')
    .map((part) => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
    .join('.*');
  return new RegExp(`^${source}$`);
}

/**
 * True when the repo-relative path matches any exempt pattern.
 *  - A bare pattern with no slash (`*.md`) matches the basename anywhere.
 *  - A leading `**` + slash is also satisfied by zero directories, so a
 *    pattern like `**` + `/*.md` matches a top-level README.md — which is
 *    what authors of such patterns mean.
 */
export function pathMatchesAny(relPath: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return false;
  const normalized = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  const base = normalized.split('/').pop() ?? normalized;
  for (const raw of patterns) {
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const p = raw.replace(/^\.\//, '');
    if (globishToRegExp(p).test(normalized)) return true;
    if (!p.includes('/') && globishToRegExp(p).test(base)) return true;
    if (p.startsWith('**/') && globishToRegExp(p.slice(3)).test(normalized)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Provenance — which layer each effective leaf came from (PLAN-GATE S4)
// ---------------------------------------------------------------------------

export type ConfigSource = 'default' | 'policy' | 'user';

export interface LeafProvenance {
  value: unknown;
  source: ConfigSource;
  /** What the team policy says for this leaf, or undefined if it is silent. */
  policyValue?: unknown;
  /** The schema default. */
  defaultValue: unknown;
}

function leafPaths(obj: unknown, prefix = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  if (!isPlainObject(obj)) {
    if (prefix) out[prefix] = obj;
    return out;
  }
  for (const k of Object.keys(obj)) leafPaths(obj[k], prefix ? `${prefix}.${k}` : k, out);
  return out;
}

function hasPath(raw: unknown, dotted: string): boolean {
  let cur: unknown = raw;
  for (const k of dotted.split('.')) {
    if (!isPlainObject(cur) || !(k in cur)) return false;
    cur = cur[k];
  }
  return cur !== undefined;
}

/**
 * Explain the effective config leaf by leaf: the value the user is actually
 * running under and whether it is theirs, the team's, or the schema's.
 *
 * "Theirs" means the SPARSE user file names that path — even when the value it
 * names equals the team default. That is the honest reading: a member who
 * explicitly set `enforcement: soft` while the policy also says `soft` has
 * pinned it, and a later policy change will not move them. The Settings UI
 * uses this to say so and to offer the way back.
 *
 * A policy that fails to apply (see `resolveConfig`) contributes nothing: every
 * leaf then reads `default` or `user`, matching what is really in force.
 */
export function explainConfig(userRaw: unknown, policyRaw?: unknown): Record<string, LeafProvenance> {
  const user = migrateLegacyConfig(userRaw);
  const userName = isPlainObject(user) && typeof user.user === 'string' ? user.user : 'user';
  const defaults = leafPaths(ScaleConfigSchema.parse({ user: userName }));
  const policyOnly = resolveConfig({ user: userName }, policyRaw);
  const policyLeaves = policyOnly.policyApplied ? leafPaths(policyOnly.config) : defaults;
  const effective = leafPaths(resolveConfig(user, policyRaw).config);

  const overlay: Record<string, unknown> = {};
  if (policyOnly.policyApplied && isPlainObject(policyRaw)) {
    for (const s of POLICY_SECTIONS) if (policyRaw[s] !== undefined) overlay[s] = policyRaw[s];
  }

  const out: Record<string, LeafProvenance> = {};
  for (const path of Object.keys(effective)) {
    const fromUser = hasPath(user, path);
    const fromPolicy = hasPath(overlay, path);
    out[path] = {
      value: effective[path],
      source: fromUser ? 'user' : fromPolicy ? 'policy' : 'default',
      defaultValue: defaults[path],
      ...(fromPolicy ? { policyValue: policyLeaves[path] } : {}),
    };
  }
  return out;
}

/**
 * Remove one dotted path from a sparse raw config, pruning parents that become
 * empty so the file stays sparse. Returns a new object; `user` (the identity
 * field) cannot be unset. No-op when the path is absent.
 */
export function unsetPath(raw: Record<string, unknown>, dotted: string): Record<string, unknown> {
  if (dotted === 'user') return raw;
  const keys = dotted.split('.');
  const out = structuredClone(raw);
  const chain: Record<string, unknown>[] = [out];
  let cur: Record<string, unknown> = out;
  for (let i = 0; i < keys.length - 1; i++) {
    const next = cur[keys[i]!];
    if (!isPlainObject(next)) return raw;
    cur = next;
    chain.push(cur);
  }
  if (!(keys[keys.length - 1]! in cur)) return raw;
  delete cur[keys[keys.length - 1]!];
  for (let i = chain.length - 1; i > 0; i--) {
    if (Object.keys(chain[i]!).length === 0) delete chain[i - 1]![keys[i - 1]!];
  }
  return out;
}
