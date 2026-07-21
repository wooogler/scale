/**
 * In-flow intervention GATE — the deterministic pre-commit decision (PLAN §6.1).
 *
 * This is the beating heart of Principle 2 ("Minimal interruption"): a single,
 * PURE, side-effect-free function that decides whether a pre-commit intervention
 * is allowed to fire. No git, no fs, no clock, no LLM — every input (touched
 * components, coverage, config, session budget accounting, changed-line count,
 * the recently-addressed marker set, and `now`) is INJECTED by the caller (the
 * CLI). The same inputs always yield the same decision, so the budget policy is
 * provably honored and fully unit-testable.
 *
 * The budget guarantees (all constants in config.json):
 *   - ≤ 1 intervention per commit — realized by the `recentlyAddressed` retry
 *     mechanic, NOT a counter: after a deny the tutor records a validation (or the
 *     user defers), the touched candidate enters `recentlyAddressed` within the
 *     marker TTL, and the retried commit therefore hits the recentlyAddressed
 *     allow-path. One commit can thus fire at most once.
 *   - ≤ maxPerSession interventions per session (a hard counter).
 *   - ≥ cooldownMinutes between interventions.
 *   - never on trivial diffs (< minChangedLines).
 *   - defer = DROP: a deferred component is recorded as an intervention marker,
 *     which puts it in `recentlyAddressed`, so the immediate retry passes and the
 *     item is never re-raised this commit. Nothing crosses into a queue (§6.3).
 */
import type { ScaleConfig } from './schema/config.js';
import type { UserCoverage } from './schema/coverage.js';
import { meanDims } from './coverage-model.js';

/** Session budget-accounting record threaded into the gate (mutated by the CLI). */
export interface GateSession {
  /** Interventions already fired this session (vs config.budgets.maxPerSession). */
  interventionsThisSession: number;
  /** ISO timestamp of the last fired intervention, or null if none yet. */
  lastInterventionAt: string | null;
  /** Component the last deny asked about (cleared once its retry passes). */
  pendingComponent: string | null;
}

/** Fully-injected inputs to {@link gateDecision}. Pure — no I/O implied. */
export interface GateInput {
  /** Component ids touched by the staged diff (already file→component mapped). */
  touched: string[];
  /** Materialized coverage (states + dims). */
  coverage: UserCoverage;
  config: ScaleConfig;
  session: GateSession;
  /** Total added+deleted lines in the staged diff (trivial-diff gate). */
  changedLines: number;
  /**
   * Components already handled within the marker TTL — either a fresh active
   * validation OR a deferred/completed intervention. Their presence is BOTH the
   * retry-passes path (tutor recorded → retry allows) AND the defer=drop path
   * (user skipped → retry allows, item dropped). See PLAN §6.1.
   */
  recentlyAddressed: string[];
  /** Decision time (ISO), for the cooldown comparison. */
  now: string;
  /**
   * Optional componentId → importance (from map.json) for candidate ranking.
   * When absent/empty the gate falls back to lowest-mean-then-state ranking.
   */
  importance?: Record<string, number>;
}

/** The gate's verdict. `spendBudget` tells the CLI to charge the session budget. */
export interface GateDecision {
  action: 'allow' | 'deny';
  /** The territory the intervention targets (deny only). */
  component?: string;
  /** Agent-facing instruction (deny) or a short allow rationale. */
  reason?: string;
  /** True only on a deny that actually consumes a budget slot. */
  spendBudget?: boolean;
}

/** A touched component that is worth a check: fog / stale / explored-below-bar. */
interface Candidate {
  id: string;
  /** 0=fog, 1=stale, 2=explored (lower = higher priority). */
  stateRank: number;
  /** Weighted comprehension mean of its dims. */
  mean: number;
}

const STATE_RANK: Record<string, number> = { fog: 0, stale: 1, explored: 2 };

/** Whole minutes between two ISO timestamps; NaN-safe (returns Infinity). */
function minutesBetween(nowIso: string, thenIso: string): number {
  const a = Date.parse(nowIso);
  const b = Date.parse(thenIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Infinity;
  return (a - b) / 60000;
}

/**
 * Collect the touched components that warrant an intervention:
 *   - `fog`                          — never explored,
 *   - `stale`                        — rebellion, needs re-validation,
 *   - `explored` with mean < validateDim — scouted but not yet conquered.
 * `validated` (and the degenerate explored-at-or-above-bar) are NOT candidates.
 * A touched id with no coverage record is treated as fog.
 */
function candidatesOf(input: GateInput): Candidate[] {
  const bar = input.config.thresholds.validateDim;
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const id of input.touched) {
    if (seen.has(id)) continue;
    seen.add(id);
    const comp = input.coverage.components[id];
    const state = comp?.state ?? 'fog';
    const mean = comp ? meanDims(comp.dims) : 0;
    if (state === 'fog' || state === 'stale') {
      out.push({ id, stateRank: STATE_RANK[state]!, mean });
    } else if (state === 'explored' && mean < bar) {
      out.push({ id, stateRank: STATE_RANK.explored!, mean });
    }
    // validated, or explored ≥ bar: comprehension already demonstrated, skip.
  }
  return out;
}

/**
 * Rank candidates and return the single highest-priority one.
 *  - With importance data: maximize importance × (1 − mean) (big, under-covered
 *    territory first). Ties → lower mean → lower stateRank → id, for determinism.
 *  - Without importance: lowest mean first, then fog > stale > explored, then id.
 */
function topCandidate(cands: Candidate[], importance?: Record<string, number>): Candidate {
  const hasImportance =
    importance !== undefined && cands.some((c) => importance[c.id] !== undefined);

  const sorted = [...cands].sort((a, b) => {
    if (hasImportance) {
      const sa = (importance![a.id] ?? 0) * (1 - a.mean);
      const sb = (importance![b.id] ?? 0) * (1 - b.mean);
      if (sa !== sb) return sb - sa; // higher score first
    }
    if (a.mean !== b.mean) return a.mean - b.mean; // lower mean first
    if (a.stateRank !== b.stateRank) return a.stateRank - b.stateRank;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return sorted[0]!;
}

/**
 * Build the agent-facing deny instruction for a target component + modality.
 *
 * This text is read by the AGENT, not by the junior — which is exactly why it
 * has to be emphatic about handing the check over. An earlier version listed
 * `scale gate defer` as a co-equal option, and an agent that found the check
 * inconvenient could skip it silently: the junior never learned an intervention
 * was due, while the evidence log recorded one as delivered and spent a budget
 * slot. Deferring is the JUNIOR's call (PLAN §6.1 "defer = drop, their choice"),
 * so the agent must present the check and may only skip when told to — and when
 * it skips anyway, `--by agent` keeps that out of the study's user-choice data.
 */
export function gateDenyReason(component: string, modality: string): string {
  return (
    `SCALE in-flow check — this is for the JUNIOR, not for you to resolve.\n` +
    `Run the ${modality} comprehension check on the '${component}' territory ` +
    `using the scale-tutor skill and put it in front of them now (it's ` +
    `fog/stale/low-coverage and they just changed it). After they complete it ` +
    `(scale record), retry the commit.\n` +
    `Do NOT skip this on their behalf. If — and only if — they say to skip, run ` +
    `\`scale gate defer ${component}\`, then retry. If you skip without asking ` +
    `(e.g. you authored this commit yourself), you MUST run ` +
    `\`scale gate defer ${component} --by agent\` and say so in your reply.`
  );
}

/**
 * The deterministic pre-commit gate decision (PLAN §6.1). Conditions are
 * evaluated IN ORDER; the first match wins. Every allow-path documents WHY it
 * lets the commit through, so the interruption audit (Phase 6) can read the trace.
 */
export function gateDecision(input: GateInput): GateDecision {
  const { config, session } = input;

  // 0. Post-session conditions never gate in-flow (hooks only collect evidence).
  if (config.condition.timing !== 'inflow') {
    return { action: 'allow', reason: 'post-session condition — gate is a no-op' };
  }

  // 1. pre-commit trigger disabled for this user.
  if (!config.inflow.triggers.includes('pre-commit')) {
    return { action: 'allow', reason: 'pre-commit trigger not enabled' };
  }

  // 2. Nothing under-covered was touched → nothing to check.
  const cands = candidatesOf(input);
  if (cands.length === 0) {
    return { action: 'allow', reason: 'no fog/stale/low-coverage territory touched' };
  }

  // 3. A touched candidate was already addressed within the marker TTL — the
  //    tutor just validated it, OR the user just deferred it (defer = drop).
  //    Either way the retried commit passes and the item is not re-raised.
  const addressed = new Set(input.recentlyAddressed);
  if (cands.some((c) => addressed.has(c.id))) {
    return { action: 'allow', reason: 'candidate recently addressed (retry/defer)' };
  }

  // 4. Trivial diff — below the changed-line floor, never interrupt.
  if (input.changedLines < config.budgets.minChangedLines) {
    return { action: 'allow', reason: 'trivial diff below minChangedLines' };
  }

  // 5. Session intervention budget already spent.
  if (session.interventionsThisSession >= config.budgets.maxPerSession) {
    return { action: 'allow', reason: 'session intervention budget spent' };
  }

  // 6. Cooldown — too soon since the last intervention.
  if (
    session.lastInterventionAt !== null &&
    minutesBetween(input.now, session.lastInterventionAt) < config.budgets.cooldownMinutes
  ) {
    return { action: 'allow', reason: 'within cooldown window' };
  }

  // 7. Fire: deny with a reason, targeting the highest-priority candidate.
  const target = topCandidate(cands, input.importance);
  return {
    action: 'deny',
    component: target.id,
    reason: gateDenyReason(target.id, config.condition.modality),
    spendBudget: true,
  };
}
