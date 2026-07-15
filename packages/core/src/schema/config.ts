import { z } from 'zod';

/** The manipulated 2×2 condition. */
export const ConditionSchema = z.object({
  timing: z.enum(['inflow', 'postsession']),
  modality: z.enum(['quiz', 'socratic']),
});
export type Condition = z.infer<typeof ConditionSchema>;

/** In-flow trigger kinds. The gate accepts new kinds without schema changes. */
export const InflowTriggerSchema = z.enum(['pre-commit', 'post-task']);
export type InflowTrigger = z.infer<typeof InflowTriggerSchema>;

export const InflowConfigSchema = z.object({
  triggers: z.array(InflowTriggerSchema).default(['pre-commit']),
});
export type InflowConfig = z.infer<typeof InflowConfigSchema>;

/** Interruption budget constants (all tunable). */
export const BudgetsSchema = z.object({
  maxPerCommit: z.number().default(1),
  maxPerSession: z.number().default(2),
  cooldownMinutes: z.number().default(15),
  minChangedLines: z.number().default(20),
});
export type Budgets = z.infer<typeof BudgetsSchema>;

/**
 * Model tier selection (fixed policy).
 *   - BUILD (Mode B `scale-map`)      → Opus or Fable ONLY (high-capability).
 *   - INTERVENTION (quiz/socratic tutor, quest generation, socratic proxy)
 *                                     → Sonnet or Haiku ONLY (cheap, fast).
 * These are neutral choice tokens; the concrete Claude model ids live in
 * {@link MODEL_IDS} / {@link resolveModelId} so a model bump is a one-line edit.
 */
export const BuildModelSchema = z.enum(['opus', 'fable']);
export type BuildModel = z.infer<typeof BuildModelSchema>;

export const InterventionModelSchema = z.enum(['sonnet', 'haiku']);
export type InterventionModel = z.infer<typeof InterventionModelSchema>;

export const ModelsConfigSchema = z
  .object({
    /** Drives the build-cost estimator's default and the scale-map build. */
    build: BuildModelSchema.default('opus'),
    /** Drives quest generation + the web socratic proxy (intervention tier). */
    intervention: InterventionModelSchema.default('haiku'),
  })
  .default({});
export type ModelsConfig = z.infer<typeof ModelsConfigSchema>;

/** Choice token → concrete Claude model id. Re-map here on a model bump. */
export const MODEL_IDS = {
  opus: 'claude-opus-4-8',
  fable: 'claude-fable-5',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5',
} as const;
export type ModelChoice = keyof typeof MODEL_IDS;

/** Resolve a build/intervention choice token to its concrete Claude model id. */
export function resolveModelId(choice: ModelChoice): string {
  return MODEL_IDS[choice];
}

/** Coverage-model thresholds (all tunable). */
export const ThresholdsSchema = z.object({
  /** EMA weight on the newest active score (higher → faster, more visible movement). */
  emaAlpha: z.number().min(0).max(1).default(0.5),
  /** Weighted-dims bar for `validated`. */
  validateDim: z.number().default(0.6),
  /** Loyalty below this → `stale` (rebellion). */
  staleLoyalty: z.number().default(0.5),
  /** Cap on structure credit from passive touch/prompt alone. */
  passiveStructureCap: z.number().default(0.3),
  /** Cap on structure credit from paper_read. */
  paperReadCap: z.number().default(0.4),
});
export type Thresholds = z.infer<typeof ThresholdsSchema>;

export const ScaleConfigSchema = z.object({
  user: z.string(),
  condition: ConditionSchema.default({ timing: 'inflow', modality: 'quiz' }),
  inflow: InflowConfigSchema.default({ triggers: ['pre-commit'] }),
  budgets: BudgetsSchema.default({}),
  thresholds: ThresholdsSchema.default({}),
  models: ModelsConfigSchema,
});
export type ScaleConfig = z.infer<typeof ScaleConfigSchema>;
