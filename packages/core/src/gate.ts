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
import type { Language, QuizConfig, ScaleConfig } from './schema/config.js';
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
   * componentId → why it was re-locked, for components locked by drift.
   * Only shapes the deny wording; absence just means "never demonstrated".
   */
  drifted?: Record<string, DriftNote>;
  /**
   * Components handled within the marker TTL — a fresh check result or a
   * deferred/completed intervention. This is what makes the retried edit pass
   * right after the tutor records, before the ledger read would even matter.
   */
  recentlyAddressed: string[];
  /** Decision time (ISO), for the cooldown comparison. */
  now: string;
  /**
   * componentId → a clickable deep link into the running map viewer's panel
   * for that component. Injected rather than built here because only the CLI
   * knows where the viewer is (and whether its URL carries a `?token=`); core
   * stays pure and browser-safe. Absent → the deny reason simply omits the
   * access line, which is a cosmetic loss, never a behavioral one.
   */
  viewerUrlFor?: (component: string) => string;
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

/**
 * Why a locked component is locked, when it is locked because it DRIFTED
 * rather than because it was never checked. Supplied by the CLI from the lock
 * ledger's drift notes.
 */
export interface DriftNote {
  cause: 'foreign' | 'self';
  /** Author emails of the foreign commits; empty for a self-caused drift. */
  authors: string[];
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
 * The quiz SHAPE, as one line the agent can read without another CLI call.
 *
 * The tutor skill needs the item count and the theme at the exact moment the
 * deny lands, and the deny is the only thing it is guaranteed to have read —
 * making it run `scale config get quiz.items` first would put a subprocess
 * between the junior and their interruption for three scalars. So the same
 * line is emitted in both places the agent looks: the deny reason and the
 * SessionStart context block.
 *
 * Shape is fixed and parse-friendly: `quiz: 2 item(s), focus auto, grounding
 * balanced`.
 */
export function quizSpecLine(quiz: QuizConfig): string {
  return `quiz: ${quiz.items} item(s), focus ${quiz.focus}, grounding ${quiz.grounding}`;
}

/**
 * WHY a comprehension check is being asked for — the ONE axis on which the
 * in-flow gate deny and the post-session chat review differ.
 *
 *  - `gate`   — an edit was just denied (optionally because the territory
 *               DRIFTED under the junior).
 *  - `review` — the junior is working through `/scale-review` after the fact:
 *               either they OWE this check (an async deny recorded it in
 *               `locks.pendingUnlocks`) or they TOUCHED the territory since it
 *               was last checked/skipped and its comprehension is still low.
 */
export type CheckCause =
  | { kind: 'gate'; drift?: DriftNote }
  | {
      kind: 'review';
      reason: 'owed' | 'touched';
      /** ISO timestamp the reason dates from (the deny, or the first touch). */
      since: string;
      /** Repo-relative files touched in that window (may be empty). */
      files: string[];
    };

/** The date half of an ISO timestamp; the raw string when it is not one. */
function isoDay(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : iso;
}

/**
 * Build the agent-facing instruction for ONE comprehension check — the single
 * generator behind BOTH the in-flow gate deny and the post-session review
 * (PLAN-GATE §3.2-6).
 *
 * WHY ONE FUNCTION: the study manipulates exactly one variable — WHEN the check
 * happens. If the post-session path grew its own copy of this text the two arms
 * would start drifting on wording, emphasis, and eventually on what the tutor
 * actually does, and the timing contrast would be confounded by a prose
 * difference nobody tracked. So the parts are written once here and the cause
 * selects only:
 *   - the HEAD (why this moment exists), and
 *   - what to do AFTER the junior completes the check ("retry the edit" is
 *     meaningless when no edit is pending — the reviewer moves to the next
 *     queue item instead).
 * Everything else — the check instruction itself, the quiz spec line, the skip
 * paragraph, the Korean delivery sentence, the access line — is byte-identical
 * across the two paths by construction, not by convention.
 *
 * A `review` brief always carries the CHECK body, never the async TEACH body:
 * the review IS the check the async deny promised for "later", so teaching-only
 * there would mean the owed check never happens at all.
 *
 * This text is read by the AGENT, not by the junior — which is exactly why it
 * has to be emphatic about handing the moment over. An earlier commit-gate
 * version listed `scale gate defer` as a co-equal option and agents skipped
 * silently; the junior never learned a check was due while the log recorded one
 * as delivered. Skipping is the JUNIOR's call, so the agent must present the
 * moment and may only skip when told to — and an unasked skip must be labeled
 * `--by agent` so it stays out of the study's user-choice data.
 *
 * A quiz-modality deny also carries {@link quizSpecLine}, so the tutor knows
 * how many items to write and on what theme without a second CLI call.
 *
 * Three axes shape the text:
 *  - assessment `sync`  — run the check now, in chat; passing unlocks durably.
 *  - assessment `async` — do NOT quiz now: TEACH, then point the junior at the
 *    map viewer / a later /scale-study to unlock; the edit stays denied unless
 *    they choose to skip.
 *  - enforcement `hard` — the skip paragraph is replaced: team policy disables
 *    skipping (the member's own enforcement override is the sanctioned valve).
 *
 * `viewerUrl`, when the caller knows it, adds a final line with a clickable
 * deep link into the component's panel — see the `access` line below.
 *
 * The instruction itself always stays English (it addresses the AGENT); when
 * the junior's `language` is 'ko' one extra sentence tells the agent to DELIVER
 * everything junior-facing in Korean (code identifiers stay English).
 */
export function checkBrief(
  component: string,
  config: ScaleConfig,
  cause: CheckCause = { kind: 'gate' },
  viewerUrl?: string,
): string {
  const { modality, assessment, enforcement } = config.gate;
  const language: Language = config.language;
  const drift = cause.kind === 'gate' ? cause.drift : undefined;

  // A drift is NOT "you never understood this". The junior demonstrated it;
  // the code moved underneath them. Saying otherwise would be both false and
  // demoralizing, and it would corrupt what the study is measuring — so the
  // deny names the cause and, when someone else caused it, names them.
  const gateHead = drift
    ? drift.cause === 'self'
      ? `SCALE edit gate — the '${component}' territory is locked again. The junior ` +
        `DID demonstrate this component before; since then it has been rewritten ` +
        `far enough (by their own work) that the old check no longer covers it. ` +
        `This moment is for the JUNIOR, not for you to resolve.`
      : `SCALE edit gate — the '${component}' territory REBELLED and is locked again. ` +
        `The junior DID demonstrate this component before; ` +
        `${drift.authors.length > 0 ? drift.authors.join(', ') : 'someone else'} ` +
        `has changed it since, so their understanding is out of date — this is not a ` +
        `failure on their part. This moment is for the JUNIOR, not for you to resolve.`
    : `SCALE edit gate — the '${component}' territory is LOCKED for this user ` +
      `(comprehension not yet demonstrated), and this edit reaches into it. ` +
      `This moment is for the JUNIOR, not for you to resolve.`;

  // The review head names the DEBT instead of the blocked edit. The closing
  // "this moment is for the JUNIOR" sentence is deliberately the same one the
  // gate uses: the agent's temptation to answer the check itself does not
  // weaken just because the check arrives after the fact.
  const reviewHead =
    cause.kind === 'review'
      ? cause.reason === 'owed'
        ? `SCALE review — the '${component}' territory is LOCKED and this user ` +
          `still owes its check (denied under async assessment on ` +
          `${isoDay(cause.since)}). ` +
          `This moment is for the JUNIOR, not for you to resolve.`
        : `SCALE review — the '${component}' territory is LOCKED and this user ` +
          `touched '${component}' (${cause.files.length} file(s)) since ` +
          `${isoDay(cause.since)} and its comprehension is still below the bar. ` +
          `This moment is for the JUNIOR, not for you to resolve.`
      : '';

  const head = cause.kind === 'review' ? reviewHead : gateHead;

  // What to do once the check is done. The ONLY difference between the two
  // paths' bodies: there is no pending edit to retry in a post-session review.
  const afterCheck =
    cause.kind === 'review'
      ? 'move on to the next item in the review queue'
      : 'retry the edit';

  const checkBody =
    `Run the ${modality} comprehension check on '${component}' using the ` +
    `scale-tutor skill and put it in front of them now` +
    (drift
      ? `, focused on WHAT CHANGED since they last validated it rather than ` +
        `re-asking what they already answered`
      : '') +
    `. After they complete it (scale record), ${afterCheck} — a passing ` +
    `check unlocks this territory durably.`;

  // A review is the deferred check ARRIVING, so it never takes the async
  // teach-only branch — that branch is what created the debt in the first place.
  const body =
    cause.kind === 'review' || assessment === 'sync'
      ? checkBody
      : `This user is on ASYNC assessment: do NOT quiz them now. Briefly TEACH ` +
        `instead — explain what '${component}' does and why, grounded in its ` +
        `component doc under .scale/ and in what this edit is trying to change. Then ` +
        `tell the junior the territory stays locked until they pass its check ` +
        `later (with /scale-review in a coming session — the same check, in chat — ` +
        `or in the SCALE map viewer, or with /scale-study ${component}). The edit ` +
        `itself stays blocked for now.`;

  const skip =
    enforcement === 'hard'
      ? `Skipping is disabled by team policy (enforcement: hard) — do not look ` +
        `for a way around the lock; work elsewhere or unlock it properly.`
      : `Do NOT skip on their behalf. If — and only if — the junior says to ` +
        `skip, run \`scale gate defer ${component}\` (this unlocks it for THIS ` +
        `SESSION only), then ${afterCheck}. If you skip without asking (e.g. ` +
        `no junior is in the loop), you MUST run \`scale gate defer ` +
        `${component} --by agent\` and say so in your reply.`;

  const ko =
    language === 'ko'
      ? ` The junior's interaction language is KOREAN: deliver everything ` +
        `junior-facing entirely in Korean, keeping code identifiers and ` +
        `technical terms in English.`
      : '';

  // The quiz shape rides along on every quiz-modality deny — including an
  // `async` one, where the check is run later by the tutor from the SAME skill
  // and the shape is no less binding for happening in the map viewer.
  const spec = modality === 'quiz' ? `\n${quizSpecLine(config.quiz)}` : '';

  // WHERE the junior can act on this, as something clickable. A deny that only
  // names "the map viewer" makes the junior go find a terminal, which is the
  // exact friction the gate cannot afford to add at the moment it interrupts —
  // so the last line is a URL plus the two chat commands that reach the same
  // place. Only present when the caller knows where the viewer is.
  const access = viewerUrl
    ? `\nMap viewer: ${viewerUrl}  ·  or /scale-open ${component}  ·  or /scale-study ${component}`
    : '';

  return `${head}\n${body}${spec}\n${skip}${ko}${access}`;
}

/**
 * The in-flow edit-gate deny instruction — {@link checkBrief} with
 * `cause: 'gate'`.
 *
 * Kept as its own name because the gate is its only caller and a deny reads
 * better at the call site than a cause object; the text is produced by the
 * shared generator, so the two paths cannot drift apart (see `checkBrief`).
 */
export function gateDenyReason(
  component: string,
  config: ScaleConfig,
  drift?: DriftNote,
  viewerUrl?: string,
): string {
  return checkBrief(component, config, { kind: 'gate', ...(drift ? { drift } : {}) }, viewerUrl);
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
      reason: gateDenyReason(pending, config, input.drifted?.[pending], input.viewerUrlFor?.(pending)),
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
    reason: gateDenyReason(target.id, config, input.drifted?.[target.id], input.viewerUrlFor?.(target.id)),
    spendBudget: true,
  };
}
