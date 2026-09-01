/**
 * The EDIT GATE — the deterministic lock decision (PLAN-GATE §3).
 *
 * A single, PURE, side-effect-free function decides whether an
 * Edit/Write/MultiEdit that reaches into locked territory is denied. No git, no
 * fs, no clock, no LLM — every input (touched components, coverage snapshot,
 * effective config, the unlock ledger, session skips, budget accounting, and
 * `now`) is INJECTED by the caller (the CLI), so the same inputs always yield
 * the same decision and the policy is fully unit-testable.
 *
 * What "locked" means (PLAN-GATE §3.1):
 *   a component is locked unless it is in the durable unlock ledger
 *   (`locks.json` — a passed check put it there) OR its coverage state is
 *   `validated` (grandfathered: comprehension already demonstrated under the
 *   old model must not re-lock on migration).
 *
 * Budget guarantees (constants live in the effective config):
 *   - one deny per component per work stretch — after a deny the component is
 *     either unlocked (check passed), session-skipped (defer), or in
 *     `recentlyAddressed` (marker TTL), all of which clear it from candidacy,
 *     so the retried edit passes.
 *   - ≤ maxPerSession denies per budget period (hard counter).
 *   - ≥ cooldownMinutes between denies.
 *   - budget exhaustion fails OPEN (allow) — over-interrupting is the failure
 *     this gate exists to prevent; S3 will queue the missed check instead.
 */
import type { Language, ScaleConfig } from './schema/config.js';
import type { UserCoverage } from './schema/coverage.js';
import { meanDims } from './coverage-model.js';

/** Session budget-accounting record threaded into the gate (mutated by the CLI). */
export interface GateSession {
  /** Denies already fired this budget period (vs config.budgets.maxPerSession). */
  interventionsThisSession: number;
  /** ISO timestamp of the last fired deny, or null if none yet. */
  lastInterventionAt: string | null;
  /** Component the last deny asked about (cleared once its retry passes). */
  pendingComponent: string | null;
}

/** Fully-injected inputs to {@link gateEditDecision}. Pure — no I/O implied. */
export interface GateEditInput {
  /**
   * Component ids the edited file(s) map to — EXACT index matches only, exempt
   * paths already filtered out. The nearest-directory fallback is banned here:
   * it sprays a new file across every component in the directory (PLAN-GATE
   * §3.2-1), which would gate file creation on up to 11 unrelated unlocks.
   */
  touched: string[];
  /**
   * Materialized coverage SNAPSHOT (coverage.json). Deliberately not a
   * recompute — edits are far too frequent for per-edit git churn scans; the
   * snapshot is refreshed by SessionStart/record/status.
   */
  coverage: UserCoverage;
  /** The EFFECTIVE config (schema defaults < team policy < user overrides). */
  config: ScaleConfig;
  session: GateSession;
  /** Durably unlocked component ids (the locks.json ledger). */
  unlocked: string[];
  /** Components the user deferred THIS budget period (skip = session unlock). */
  sessionSkips: string[];
  /**
   * Components handled within the marker TTL — a fresh check result or a
   * deferred/completed intervention. This is what makes the retried edit pass
   * right after the tutor records, before the ledger read would even matter.
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
  /** The territory the decision targets (deny, or advisory allow). */
  component?: string;
  /** Agent-facing instruction (deny) or a short allow rationale. */
  reason?: string;
  /** True only on a deny that actually consumes a budget slot. */
  spendBudget?: boolean;
  /**
   * True on an `advisory`-enforcement allow that matched locked territory: the
   * CLI records it (rate-limited via recentlyAddressed) but never blocks.
   */
  advisory?: boolean;
}

/** A locked, touched component. */
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
 * Build the agent-facing deny instruction (PLAN-GATE §3.2-6).
 *
 * This text is read by the AGENT, not by the junior — which is exactly why it
 * has to be emphatic about handing the moment over. An earlier commit-gate
 * version listed `scale gate defer` as a co-equal option and agents skipped
 * silently; the junior never learned a check was due while the log recorded one
 * as delivered. Skipping is the JUNIOR's call, so the agent must present the
 * moment and may only skip when told to — and an unasked skip must be labeled
 * `--by agent` so it stays out of the study's user-choice data.
 *
 * Three axes shape the text:
 *  - assessment `sync`  — run the check now, in chat; passing unlocks durably.
 *  - assessment `async` — do NOT quiz now: TEACH, then point the junior at the
 *    map viewer / a later /scale-study to unlock; the edit stays denied unless
 *    they choose to skip.
 *  - enforcement `hard` — the skip paragraph is replaced: team policy disables
 *    skipping (the member's own enforcement override is the sanctioned valve).
 *
 * The instruction itself always stays English (it addresses the AGENT); when
 * the junior's `language` is 'ko' one extra sentence tells the agent to DELIVER
 * everything junior-facing in Korean (code identifiers stay English).
 */
export function gateDenyReason(component: string, config: ScaleConfig): string {
  const { modality, assessment, enforcement } = config.gate;
  const language: Language = config.language;

  const head =
    `SCALE edit gate — the '${component}' territory is LOCKED for this user ` +
    `(comprehension not yet demonstrated), and this edit reaches into it. ` +
    `This moment is for the JUNIOR, not for you to resolve.`;

  const body =
    assessment === 'sync'
      ? `Run the ${modality} comprehension check on '${component}' using the ` +
        `scale-tutor skill and put it in front of them now. After they complete ` +
        `it (scale record), retry the edit — a passing check unlocks this ` +
        `territory durably.`
      : `This user is on ASYNC assessment: do NOT quiz them now. Briefly TEACH ` +
        `instead — explain what '${component}' does and why, grounded in its ` +
        `paper under .scale/ and in what this edit is trying to change. Then ` +
        `tell the junior the territory stays locked until they pass its check ` +
        `later (in the SCALE map viewer, or with /scale-study ${component} in a ` +
        `coming session). The edit itself stays blocked for now.`;

  const skip =
    enforcement === 'hard'
      ? `Skipping is disabled by team policy (enforcement: hard) — do not look ` +
        `for a way around the lock; work elsewhere or unlock it properly.`
      : `Do NOT skip on their behalf. If — and only if — the junior says to ` +
        `skip, run \`scale gate defer ${component}\` (this unlocks it for THIS ` +
        `SESSION only), then retry the edit. If you skip without asking (e.g. ` +
        `no junior is in the loop), you MUST run \`scale gate defer ` +
        `${component} --by agent\` and say so in your reply.`;

  const ko =
    language === 'ko'
      ? ` The junior's interaction language is KOREAN: deliver everything ` +
        `junior-facing entirely in Korean, keeping code identifiers and ` +
        `technical terms in English.`
      : '';

  return `${head}\n${body}\n${skip}${ko}`;
}

/**
 * The deterministic edit-gate decision (PLAN-GATE §3.2). Conditions are
 * evaluated IN ORDER; the first match wins. Every allow-path documents WHY it
 * lets the edit through, so the interruption audit can read the trace.
 */
export function gateEditDecision(input: GateEditInput): GateDecision {
  const { config, session } = input;

  // 0. Gate switched off (a lead exempting themselves, or a member override).
  if (!config.gate.enabled) {
    return { action: 'allow', reason: 'gate disabled for this user' };
  }

  // 1. Candidates: touched components that are still locked and not otherwise
  //    cleared this session. `validated` is grandfathered as unlocked.
  const cleared = new Set([
    ...input.unlocked,
    ...input.sessionSkips,
    ...input.recentlyAddressed,
  ]);
  const cands: Candidate[] = [];
  const seen = new Set<string>();
  for (const id of input.touched) {
    if (seen.has(id) || cleared.has(id)) continue;
    seen.add(id);
    const comp = input.coverage.components[id];
    const state = comp?.state ?? 'fog';
    if (state === 'validated') continue;
    cands.push({ id, stateRank: STATE_RANK[state] ?? 0, mean: comp ? meanDims(comp.dims) : 0 });
  }
  if (cands.length === 0) {
    return { action: 'allow', reason: 'no locked territory touched' };
  }

  // 2. Advisory enforcement: never block — surface and record instead. The
  //    evidence row the CLI writes enters recentlyAddressed, which is what
  //    keeps one component from producing an advisory row on every keystroke.
  if (config.gate.enforcement === 'advisory') {
    const target = topCandidate(cands, input.importance);
    return {
      action: 'allow',
      component: target.id,
      reason: `advisory: '${target.id}' is locked territory (not enforced)`,
      advisory: true,
    };
  }

  // 3. The component the last deny targeted stays denied until it is addressed
  //    (checked, deferred, or unlocked — all of which clear it from candidacy).
  //    Without this, a bare retry inside the cooldown window walked straight
  //    through the lock, making it a one-shot nudge instead of a lock. No
  //    budget is spent on the re-deny — the slot was charged when it fired.
  const pending = session.pendingComponent;
  if (pending && cands.some((c) => c.id === pending)) {
    return {
      action: 'deny',
      component: pending,
      reason: gateDenyReason(pending, config),
    };
  }

  // 4. Session deny budget already spent — fail open (S3 queues instead).
  if (session.interventionsThisSession >= config.budgets.maxPerSession) {
    return { action: 'allow', reason: 'session intervention budget spent' };
  }

  // 5. Cooldown — too soon since the last deny (of a DIFFERENT component).
  if (
    session.lastInterventionAt !== null &&
    minutesBetween(input.now, session.lastInterventionAt) < config.budgets.cooldownMinutes
  ) {
    return { action: 'allow', reason: 'within cooldown window' };
  }

  // 6. Fire: deny, targeting the highest-priority locked candidate.
  const target = topCandidate(cands, input.importance);
  return {
    action: 'deny',
    component: target.id,
    reason: gateDenyReason(target.id, config),
    spendBudget: true,
  };
}
