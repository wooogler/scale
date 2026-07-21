import { z } from 'zod';

/** The manipulated 2×2 condition. */
export const ConditionSchema = z.object({
  timing: z.enum(['inflow', 'postsession']),
  modality: z.enum(['quiz', 'socratic']),
});
export type Condition = z.infer<typeof ConditionSchema>;

/**
 * Interaction language — everything SCALE says TO the junior: the serve web UI,
 * quiz items, Socratic dialogue, and in-flow check instructions.
 *
 * `.scale/` papers are deliberately NOT affected: the coverage memory is
 * repo-shared state (one build serves every user of the repo) and stays English,
 * while `language` lives in per-user config. In either language, code
 * identifiers — function/variable names, file paths, established dev terms —
 * stay English.
 */
export const LanguageSchema = z.enum(['en', 'ko']);
export type Language = z.infer<typeof LanguageSchema>;

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
 * Model tier selection.
 *
 * Only the INTERVENTION tier (quiz/socratic tutor, quest generation, socratic
 * proxy) is configurable here, because it is the only one SCALE actually calls:
 * these run through the API, from the CLI and the serve process.
 *
 * There is deliberately NO `build` setting. The Mode B `scale-map` build runs
 * *inside a Claude Code session*, so the model doing the work is whatever that
 * session is on — a config key could only state an intention it cannot enforce.
 * The build model is chosen with `/model` before running `/scale-map`, and the
 * skill's confirm gate checks it.
 *
 * These are neutral choice tokens; the concrete model ids live in
 * {@link MODEL_IDS} / {@link OPENAI_INTERVENTION_IDS} so a model bump is a
 * one-line edit and the same token works across providers.
 *
 * `haiku` was the old cheap tier; configs written before the change are migrated
 * in place rather than failing validation — an unparseable config falls back to
 * defaults everywhere, which would silently discard the junior's whole condition
 * assignment mid-study.
 */
export const InterventionModelSchema = z.preprocess(
  (v) => (v === 'haiku' ? 'sonnet' : v),
  z.enum(['sonnet', 'opus']),
);
export type InterventionModel = 'sonnet' | 'opus';

/**
 * Which API backs the INTERVENTION calls (quest generation + the web socratic
 * proxy). The BUILD tier is Claude-only (Opus/Fable) — a coverage-memory build
 * is a long-horizon reasoning job the model policy pins deliberately.
 */
export const LlmProviderSchema = z.enum(['anthropic', 'openai']);
export type LlmProvider = z.infer<typeof LlmProviderSchema>;

/**
 * The value `openaiModel` used to DEFAULT to, back when it was a required
 * free-form field. Every config written then has it persisted on disk, where it
 * would now read as a deliberate override and quietly defeat the tier mapping —
 * so a config carrying exactly the old default is treated as "unset".
 */
const LEGACY_OPENAI_DEFAULT = 'gpt-4o-mini';

export const ModelsConfigSchema = z
  .preprocess((v) => {
    if (!v || typeof v !== 'object') return v;
    const m = v as Record<string, unknown>;
    if (m.openaiModel !== LEGACY_OPENAI_DEFAULT) return v;
    const { openaiModel: _drop, ...rest } = m;
    return rest;
  }, z.object({
    /** Intervention tier. Resolves per provider — see {@link resolveInterventionModel}. */
    intervention: InterventionModelSchema.default('sonnet'),
    /** Which provider serves interventions. */
    provider: LlmProviderSchema.default('anthropic'),
    /**
     * Explicit OpenAI model id. Normally left unset: the `intervention` tier
     * maps to a GPT model via {@link OPENAI_INTERVENTION_IDS}. Set it only to
     * point at a model this build doesn't know about.
     */
    openaiModel: z.string().min(1).optional(),
  }))
  .default({});
export type ModelsConfig = z.infer<typeof ModelsConfigSchema>;

/** Intervention token → concrete Claude model id. Re-map here on a model bump. */
export const MODEL_IDS = {
  sonnet: 'claude-sonnet-5',
  opus: 'claude-opus-4-8',
} as const satisfies Record<InterventionModel, string>;
export type ModelChoice = keyof typeof MODEL_IDS;

/**
 * The same intervention tier, expressed in OpenAI models. One token drives both
 * providers so switching provider doesn't silently change the tier you chose.
 */
export const OPENAI_INTERVENTION_IDS = {
  sonnet: 'gpt-5.6-terra',
  opus: 'gpt-5.6-sol',
} as const satisfies Record<InterventionModel, string>;

/**
 * Concrete model id for the INTERVENTION tier, honoring the configured provider.
 * An explicit `openaiModel` overrides the tier mapping. Callers should prefer
 * this over `resolveModelId` so a provider switch needs no call-site change.
 */
export function resolveInterventionModel(models: ModelsConfig): string {
  if (models.provider === 'openai') {
    return models.openaiModel ?? OPENAI_INTERVENTION_IDS[models.intervention];
  }
  return MODEL_IDS[models.intervention];
}

/**
 * Resolve an intervention token to its concrete Claude model id. Prefer
 * {@link resolveInterventionModel}, which also honors the configured provider.
 */
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
  language: LanguageSchema.default('en'),
  condition: ConditionSchema.default({ timing: 'inflow', modality: 'quiz' }),
  inflow: InflowConfigSchema.default({ triggers: ['pre-commit'] }),
  budgets: BudgetsSchema.default({}),
  thresholds: ThresholdsSchema.default({}),
  models: ModelsConfigSchema,
});
export type ScaleConfig = z.infer<typeof ScaleConfigSchema>;
