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

/**
 * Interruption budget constants (all tunable). Every field is a non-negative
 * count: 0 is a meaningful "off" (never interrupt on commit, no cooldown,
 * interrupt on any change) but a negative value is nonsense the gate would
 * silently misread, so the schema rejects it — these are user-editable from the
 * settings modal, not just the CLI.
 */
export const BudgetsSchema = z.object({
  maxPerCommit: z.number().int().min(0).default(1),
  maxPerSession: z.number().int().min(0).default(2),
  cooldownMinutes: z.number().min(0).default(15),
  minChangedLines: z.number().int().min(0).default(20),
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

/**
 * Which API backs the INTERVENTION calls (quest generation + the web socratic
 * proxy). The BUILD tier is Claude-only (Opus/Fable) — a coverage-memory build
 * is a long-horizon reasoning job the model policy pins deliberately.
 */
export const LlmProviderSchema = z.enum(['anthropic', 'openai']);
export type LlmProvider = z.infer<typeof LlmProviderSchema>;

export const ModelsConfigSchema = z
  .object({
    /** Drives the build-cost estimator's default and the scale-map build. */
    build: BuildModelSchema.default('opus'),
    /** Claude intervention tier, used when provider === 'anthropic'. */
    intervention: InterventionModelSchema.default('haiku'),
    /** Which provider serves interventions. */
    provider: LlmProviderSchema.default('anthropic'),
    /**
     * Model id used when provider === 'openai'. Free-form so you can point it at
     * whatever your key can call without waiting on a code change.
     */
    openaiModel: z.string().min(1).default('gpt-4o-mini'),
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

/**
 * Concrete model id for the INTERVENTION tier, honoring the configured provider:
 * the free-form OpenAI id when provider === 'openai', otherwise the Claude
 * intervention token. Callers should prefer this over `resolveModelId` so a
 * provider switch needs no call-site change.
 */
export function resolveInterventionModel(models: ModelsConfig): string {
  return models.provider === 'openai' ? models.openaiModel : MODEL_IDS[models.intervention];
}

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
