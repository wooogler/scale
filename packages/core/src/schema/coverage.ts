import { z } from 'zod';

/** Coverage state of a component. UI skin: fog/scouted/conquered/rebellion. */
export const CoverageStateSchema = z.enum(['fog', 'explored', 'validated', 'stale']);
export type CoverageState = z.infer<typeof CoverageStateSchema>;

/** The three comprehension dimensions ("dev stats"), each in [0,1]. */
export const DimensionsSchema = z.object({
  structure: z.number().min(0).max(1),
  concepts: z.number().min(0).max(1),
  rationale: z.number().min(0).max(1),
});
export type Dimensions = z.infer<typeof DimensionsSchema>;

/** Per-component coverage record. */
export const ComponentCoverageSchema = z.object({
  state: CoverageStateSchema,
  dims: DimensionsSchema,
  /** SHA at which this component was last validated; null if never. */
  lastValidatedSha: z.string().nullable(),
  /** 1 − churn/size since lastValidatedSha; low loyalty → rebellion/stale. */
  loyalty: z.number().min(0).max(1),
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
