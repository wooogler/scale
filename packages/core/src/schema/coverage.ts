import { z } from 'zod';

/** Coverage state of a component. UI skin (web only): fog/scouted/conquered/fallen-or-rebuilt. */
export const CoverageStateSchema = z.enum(['fog', 'explored', 'validated', 'stale']);
export type CoverageState = z.infer<typeof CoverageStateSchema>;

/** The three comprehension dimensions ("dev stats"), each in [0,1]. */
export const DimensionsSchema = z.object({
  structure: z.number().min(0).max(1),
  concepts: z.number().min(0).max(1),
  rationale: z.number().min(0).max(1),
});
export type Dimensions = z.infer<typeof DimensionsSchema>;

/**
 * Who moved the code out from under a `stale` component.
 *
 * Neutral on purpose; the viewer skins it (a `foreign` drift reads as the
 * territory having FALLEN to whoever changed it, a `self` drift as the user
 * having REBUILT it themselves). The distinction is not cosmetic — one says
 * someone else's work outran your understanding, the other says your own did,
 * and they carry different bars and different recovery framing.
 */
export const DriftCauseSchema = z.enum(['foreign', 'self']);
export type DriftCause = z.infer<typeof DriftCauseSchema>;

/** Per-component coverage record. */
export const ComponentCoverageSchema = z.object({
  state: CoverageStateSchema,
  dims: DimensionsSchema,
  /** SHA at which this component was last validated; null if never. */
  lastValidatedSha: z.string().nullable(),
  /** 1 − churn/size since lastValidatedSha; low loyalty → drift/stale. */
  loyalty: z.number().min(0).max(1),
  /** Why it is `stale`, when it is. Null otherwise. */
  driftCause: DriftCauseSchema.nullable().default(null),
  /**
   * Mailmap-canonical author emails behind a `foreign` drift, sorted. Empty for
   * a self-caused one. Lives here so the viewer can name them without a second
   * endpoint; the state dir is per-user and never in the repo.
   */
  driftAuthors: z.array(z.string()).default([]),
});
export type ComponentCoverage = z.infer<typeof ComponentCoverageSchema>;

/** Whole per-user coverage state (`~/.scale/<repo-id>/coverage.json`). */
export const UserCoverageSchema = z.object({
  user: z.string(),
  updatedAt: z.string(),
  /** componentId -> coverage record. */
  components: z.record(z.string(), ComponentCoverageSchema),
});
export type UserCoverage = z.infer<typeof UserCoverageSchema>;
