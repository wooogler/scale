import { z } from 'zod';

/** Dimension name a signal can target. */
export const DimNameSchema = z.enum(['structure', 'concepts', 'rationale']);
export type DimName = z.infer<typeof DimNameSchema>;

/** Fields present on every evidence entry. */
const baseEvidence = {
  /** ISO-8601 timestamp. */
  ts: z.string(),
  user: z.string(),
};

/**
 * Where a validation came from (PLAN §6.3): `session` for system-initiated
 * checks (in-flow gate / post-session quest), `voluntary` for user-initiated
 * conquests (/scale-study, map Challenge). Accounting metadata only — the
 * coverage model treats both identically. Optional for backward compat.
 */
export const ValidationOriginSchema = z.enum(['session', 'voluntary']);
export type ValidationOrigin = z.infer<typeof ValidationOriginSchema>;

/** Component mentioned in a prompt (via keyword/slug match). */
export const PromptEvidenceSchema = z.object({
  ...baseEvidence,
  type: z.literal('prompt'),
  componentIds: z.array(z.string()),
  text: z.string().optional(),
});

/** Files edited → components via the file→component index. */
export const TouchEvidenceSchema = z.object({
  ...baseEvidence,
  type: z.literal('touch'),
  files: z.array(z.string()),
  componentIds: z.array(z.string()),
});

/** Diff-review latency: proposal → execution per Edit (logged only in v1). */
export const DiffReviewEvidenceSchema = z.object({
  ...baseEvidence,
  type: z.literal('diff_review'),
  file: z.string(),
  proposeToExecuteMs: z.number(),
});

/** A paper was opened/read in the web app. */
export const PaperReadEvidenceSchema = z.object({
  ...baseEvidence,
  type: z.literal('paper_read'),
  componentId: z.string(),
});

/** A quiz item was graded on a single dimension. */
export const QuizResultEvidenceSchema = z.object({
  ...baseEvidence,
  type: z.literal('quiz_result'),
  componentId: z.string(),
  dim: DimNameSchema,
  score: z.number().min(0).max(1),
  /**
   * Git sha that was HEAD when this validation was RECORDED. Anchors
   * `lastValidatedSha` to the real validation point so it stays fixed across
   * re-materializations (rather than drifting forward to the current HEAD).
   * Optional for backward compat — pre-existing evidence without it still parses.
   */
  sha: z.string().optional(),
  /** Origin of the validation (see ValidationOriginSchema). */
  origin: ValidationOriginSchema.optional(),
  /**
   * Who authored this record. The tutor protocol says the check belongs to the
   * JUNIOR, but the agent runs the CLI, so an agent that finds the check
   * inconvenient can satisfy the gate with a `record` of its own — an easier
   * bypass than `gate defer`, and one with a more legitimate-looking trail.
   * Mirrors {@link InterventionEvidenceSchema}'s `by` so agent-authored results
   * can be excluded from the junior's comprehension data. Absent on older logs.
   */
  by: z.enum(['user', 'agent']).optional(),
});

/** A Socratic session yielded per-dim rubric scores. */
export const SocraticResultEvidenceSchema = z.object({
  ...baseEvidence,
  type: z.literal('socratic_result'),
  componentId: z.string(),
  dims: z.record(DimNameSchema, z.number().min(0).max(1)),
  /**
   * Git sha that was HEAD when this validation was RECORDED. Anchors
   * `lastValidatedSha` to the real validation point so it stays fixed across
   * re-materializations (rather than drifting forward to the current HEAD).
   * Optional for backward compat — pre-existing evidence without it still parses.
   */
  sha: z.string().optional(),
  /** Origin of the validation (see ValidationOriginSchema). */
  origin: ValidationOriginSchema.optional(),
  /**
   * Who authored this record. The tutor protocol says the check belongs to the
   * JUNIOR, but the agent runs the CLI, so an agent that finds the check
   * inconvenient can satisfy the gate with a `record` of its own — an easier
   * bypass than `gate defer`, and one with a more legitimate-looking trail.
   * Mirrors {@link InterventionEvidenceSchema}'s `by` so agent-authored results
   * can be excluded from the junior's comprehension data. Absent on older logs.
   */
  by: z.enum(['user', 'agent']).optional(),
});

/**
 * An intervention's lifecycle. The distinction between the first two matters for
 * study validity:
 *
 *  - `requested` — the gate fired and asked the agent to run a check. This is
 *    ALL the gate can honestly claim: it does not present anything itself.
 *  - `shown` — the check actually reached the junior.
 *  - `completed` / `attempted` / `deferred` — how it ended. A recorded check
 *    passes the gate whatever it scored, because the gate's job is to put the
 *    check in front of the junior, not to hold their commit hostage to getting
 *    it right (PLAN §6.1). But a check that was FAILED is not a check that was
 *    passed, and the two were previously indistinguishable in the accounting
 *    stream: `attempted` marks a result below the validation bar so an
 *    interruption audit can separate "delivered and understood" from
 *    "delivered and not yet understood".
 *  - `by` records who ended it, so an agent acting on the junior's behalf never
 *    pollutes user-choice data.
 *
 * `shown` is also accepted from older logs, where the gate wrote it at fire time.
 */
export const InterventionEvidenceSchema = z.object({
  ...baseEvidence,
  type: z.literal('intervention'),
  componentId: z.string(),
  timing: z.enum(['inflow', 'postsession']),
  modality: z.enum(['quiz', 'socratic']),
  /**
   * `advisory` — the edit gate matched locked territory but enforcement was
   * `advisory`, so it recorded instead of denying (PLAN-GATE §3.2-3). These
   * rows also serve as the advisory rate-limit: they enter recentlyAddressed.
   */
  outcome: z.enum(['requested', 'shown', 'deferred', 'completed', 'attempted', 'advisory']),
  /**
   * What fired it: `edit` (the PreToolUse edit gate) or `commit` (the removed
   * pre-commit gate — historical rows only). Absent on older logs.
   */
  trigger: z.enum(['edit', 'commit']).optional(),
  /** Who ended it. Absent on `requested`/`shown` and on pre-`by` logs. */
  by: z.enum(['user', 'agent']).optional(),
});

/** Append-only raw signal, discriminated on `type`. */
export const EvidenceEntrySchema = z.discriminatedUnion('type', [
  PromptEvidenceSchema,
  TouchEvidenceSchema,
  DiffReviewEvidenceSchema,
  PaperReadEvidenceSchema,
  QuizResultEvidenceSchema,
  SocraticResultEvidenceSchema,
  InterventionEvidenceSchema,
]);
export type EvidenceEntry = z.infer<typeof EvidenceEntrySchema>;

export type PromptEvidence = z.infer<typeof PromptEvidenceSchema>;
export type TouchEvidence = z.infer<typeof TouchEvidenceSchema>;
export type DiffReviewEvidence = z.infer<typeof DiffReviewEvidenceSchema>;
export type PaperReadEvidence = z.infer<typeof PaperReadEvidenceSchema>;
export type QuizResultEvidence = z.infer<typeof QuizResultEvidenceSchema>;
export type SocraticResultEvidence = z.infer<typeof SocraticResultEvidenceSchema>;
export type InterventionEvidence = z.infer<typeof InterventionEvidenceSchema>;
