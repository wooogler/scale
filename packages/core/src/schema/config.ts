import { z } from 'zod';

/** Comprehension-check modality. */
export const ModalitySchema = z.enum(['quiz', 'socratic']);
export type Modality = z.infer<typeof ModalitySchema>;

/**
 * WHEN the comprehension check happens once the edit gate denies (PLAN-GATE §1).
 * Both values gate identically and both get the same teaching moment — the only
 * difference is where the check itself runs:
 *  - `sync`  — the tutor runs the check right there in chat; passing unlocks.
 *  - `async` — the agent only TEACHES at deny time; the junior passes the check
 *    later (map viewer, or /scale-study in a later session) to unlock.
 */
export const AssessmentSchema = z.enum(['sync', 'async']);
export type Assessment = z.infer<typeof AssessmentSchema>;

/**
 * How hard the gate holds (PLAN-GATE §2.1). There is deliberately no absolute
 * lock: `hard` removes the skip escape from the deny text, but a member may
 * still override their own `gate.enforcement` — that override is the sanctioned
 * pressure valve, and the override delta is study data, not a violation.
 */
export const EnforcementSchema = z.enum(['advisory', 'soft', 'hard']);
export type Enforcement = z.infer<typeof EnforcementSchema>;

/** The edit gate itself. Every field is team-policy-defaultable (PLAN-GATE §2). */
export const GateConfigSchema = z
  .object({
    /**
     * Master switch. A team lead who wants to exempt THEMSELVES sets this false
     * in their own user config — there is no separate lead-exemption knob.
     */
    enabled: z.boolean().default(true),
    modality: ModalitySchema.default('quiz'),
    assessment: AssessmentSchema.default('sync'),
    enforcement: EnforcementSchema.default('soft'),
  })
  .default({});
export type GateConfig = z.infer<typeof GateConfigSchema>;

/**
 * What it takes to durably unlock a component (PLAN-GATE §3.1). Deliberately
 * SEPARATE from thresholds.validateDim: the coverage model's `validated` bar is
 * cumulative (EMA from zero cannot cross it in one sitting, by design), while a
 * lock opens on passed CHECKS — the permission ledger and the comprehension
 * model must not be entangled, or the study's DV inherits the IV's mechanics.
 */
export const UnlockConfigSchema = z
  .object({
    /** A single check's mean score must reach this to count as passed. */
    passBar: z.number().min(0).max(1).default(0.6),
    /** Passed checks needed before the component unlocks. */
    checksRequired: z.number().int().min(1).default(1),
  })
  .default({});
export type UnlockConfig = z.infer<typeof UnlockConfigSchema>;

/**
 * How DRIFT fires — the re-lock trigger (PLAN-GATE §4 S2).
 *
 * `ratio` (default) compares churn since the component's `lastValidatedSha`
 * against its size. `any-foreign-commit` re-locks on a single foreign commit,
 * which sounds principled and is a trap: measured on this repo, one commit
 * touches a mean of 7.9 of 37 components and the busiest are touched by ~60% of
 * commits, so on a team merging a few PRs a day it would re-lock the same
 * territory daily forever. It stays available for a lead who wants maximum
 * strictness on a small, well-partitioned codebase.
 */
export const DriftTriggerSchema = z.enum(['ratio', 'any-foreign-commit']);
export type DriftTrigger = z.infer<typeof DriftTriggerSchema>;

export const DriftConfigSchema = z
  .object({
    trigger: DriftTriggerSchema.default('ratio'),
    /**
     * Foreign churn ÷ component size at or above which the territory re-locks.
     *
     * Deliberately LOWER than `selfRatio`: a teammate's change is code the user
     * has never seen, so a quarter of the component being rewritten by someone
     * else is already reason to re-check. Over-firing is cheap — re-locking is
     * not itself an interruption, it only becomes one if the user edits that
     * territory, and the deny budget still caps that at `maxPerSession`.
     */
    foreignRatio: z.number().min(0).max(1).default(0.25),
    /**
     * Self churn ÷ size. Much higher, because the edit gate already cleared the
     * user BEFORE they wrote this code — re-locking them on their own work
     * mostly measures how much they typed. It is not zero, though: it closes
     * the one real hole, where a user unlocks a component with a single check
     * and then rewrites it wholesale over weeks with the agent.
     */
    selfRatio: z.number().min(0).max(1).default(0.8),
    /** How often SessionStart mentions drifted territory. `off` never mentions them. */
    digest: z.enum(['daily', 'session', 'off']).default('daily'),
  })
  .default({});
export type DriftConfig = z.infer<typeof DriftConfigSchema>;

/**
 * Who the user is IN GIT — the identity drift attribution compares against.
 * Personal, never team policy.
 *
 * `git config user.email` is the base answer; `emails` adds the other addresses
 * that are also this person (a work address, a GitHub `users.noreply` address).
 * When NO identity can be resolved at all, attribution fails toward SELF, so a
 * misconfigured git never locks anyone out of their own codebase.
 */
export const IdentityConfigSchema = z
  .object({
    emails: z.array(z.string()).default([]),
  })
  .default({});
export type IdentityConfig = z.infer<typeof IdentityConfigSchema>;

/**
 * Files the gate never fires on, as globish patterns over repo-relative paths
 * (`*` = within a segment, `**` = across segments). New files are ALREADY
 * exempt by construction — the gate maps files to components through the exact
 * index only (the nearest-directory fallback sprays a new file across every
 * component in the directory, measured at up to 11 here — PLAN-GATE §3.2).
 */
export const ExemptConfigSchema = z
  .object({
    paths: z.array(z.string()).default([]),
  })
  .default({});
export type ExemptConfig = z.infer<typeof ExemptConfigSchema>;

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

/**
 * Interruption budget constants (all tunable). Every field is a non-negative
 * count: 0 is a meaningful "off" (never deny, no cooldown) but a negative value
 * is nonsense the gate would silently misread, so the schema rejects it — these
 * are user-editable from the settings modal, not just the CLI.
 *
 * The commit-era knobs are gone: `maxPerCommit` was read by no decision code
 * (the ≤1-per-commit guarantee came from the recentlyAddressed retry mechanic),
 * and `minChangedLines` measured a staged diff the edit gate never has. Old
 * configs carrying them parse fine — unknown keys are stripped.
 */
export const BudgetsSchema = z.object({
  maxPerSession: z.number().int().min(0).default(2),
  cooldownMinutes: z.number().min(0).default(15),
  /**
   * Backstop for deciding a budget period has ended, in minutes of no activity.
   *
   * The period normally ends when the last Claude Code window attached to the
   * repo closes (SessionEnd decrements an open-window count). This only recovers
   * the case where that signal is lost — a crash, a killed terminal — which
   * would otherwise pin the count above zero and suppress the gate forever.
   *
   * It is therefore deliberately much longer than a working day: it must never
   * be the thing that ends a session, or a long quiet stretch of work would
   * silently refill the budget. 12 hours.
   */
  sessionIdleResetMinutes: z.number().min(0).default(720),
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
  /** Cap on structure credit from passive touch/prompt alone. */
  passiveStructureCap: z.number().default(0.3),
  /** Cap on structure credit from paper_read. */
  paperReadCap: z.number().default(0.4),
});
export type Thresholds = z.infer<typeof ThresholdsSchema>;

/**
 * Migrate a pre-edit-gate config in place (PLAN-GATE §2.1). Idempotent, and it
 * never clobbers an explicit new-style key — a legacy `condition` was the
 * user's explicit choice, so it becomes an explicit `gate.*` override, but only
 * where `gate.*` doesn't already say otherwise.
 *
 *   condition.timing  inflow→gate.assessment 'sync', postsession→'async'
 *   condition.modality → gate.modality
 *   inflow.triggers    → gate.enabled (did they have pre-commit on at all?)
 *
 * A legacy `postsession` user therefore gains a gate they never had — intended:
 * under the new design BOTH assessments gate, and only the check's venue
 * differs. Dropped budget knobs (maxPerCommit, minChangedLines) need no
 * handling — unknown object keys are stripped at parse.
 */
export function migrateLegacyConfig(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  let cfg = raw as Record<string, unknown>;

  // `drift` shipped briefly as `rebellion` — a UI skin word in a config key,
  // which the neutral-terms rule forbids. An explicit `drift` always wins.
  if (cfg.rebellion !== undefined) {
    const { rebellion, ...rest } = cfg;
    cfg = cfg.drift === undefined ? { ...rest, drift: rebellion } : rest;
  }

  if (cfg.condition === undefined && cfg.inflow === undefined) return cfg;

  const { condition, inflow, ...rest } = cfg;
  const gate: Record<string, unknown> =
    rest.gate && typeof rest.gate === 'object' && !Array.isArray(rest.gate)
      ? { ...(rest.gate as Record<string, unknown>) }
      : {};

  if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
    const c = condition as Record<string, unknown>;
    if (gate.assessment === undefined && (c.timing === 'inflow' || c.timing === 'postsession')) {
      gate.assessment = c.timing === 'inflow' ? 'sync' : 'async';
    }
    if (gate.modality === undefined && (c.modality === 'quiz' || c.modality === 'socratic')) {
      gate.modality = c.modality;
    }
  }
  if (inflow && typeof inflow === 'object' && !Array.isArray(inflow)) {
    const triggers = (inflow as Record<string, unknown>).triggers;
    if (gate.enabled === undefined && Array.isArray(triggers)) {
      gate.enabled = triggers.includes('pre-commit');
    }
  }
  return { ...rest, gate };
}

export const ScaleConfigSchema = z.preprocess(
  migrateLegacyConfig,
  z.object({
    user: z.string(),
    language: LanguageSchema.default('en'),
    identity: IdentityConfigSchema,
    gate: GateConfigSchema,
    unlock: UnlockConfigSchema,
    exempt: ExemptConfigSchema,
    drift: DriftConfigSchema,
    budgets: BudgetsSchema.default({}),
    thresholds: ThresholdsSchema.default({}),
    models: ModelsConfigSchema,
  }),
);
export type ScaleConfig = z.infer<typeof ScaleConfigSchema>;
