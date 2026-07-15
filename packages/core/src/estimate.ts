/**
 * Build-cost estimator (pure math) for the Mode B `scale-map` build (PLAN §4.3).
 *
 * Answers "how much will analyzing this codebase cost?" BEFORE the user commits
 * to running the (expensive, LLM-heavy) coverage-memory build. Everything here is
 * pure arithmetic over a single input — measured source LOC — plus a documented
 * calibration block. No fs, no git, no LLM: the CLI does the repo scan and feeds
 * the LOC count in. Rough by design (±~50%); the point is an order-of-magnitude
 * decision aid, not a billing figure.
 */

/** Per-1M-token USD rates for a model (input/output/cache-read/cache-write). */
export interface ModelRate {
  /** Human-facing model name. */
  name: string;
  /** $/1M uncached input tokens. */
  input: number;
  /** $/1M output tokens. */
  output: number;
  /** $/1M cache-read tokens. */
  cacheRead: number;
  /** $/1M cache-write (cache-creation) tokens. */
  cacheWrite: number;
}

/**
 * Published model rates ($/1M tokens), as of the calibration. Kept as data so a
 * re-price is a one-line edit. Fable 5's always-on thinking produces ~1.5× the
 * output of the other models for the same work — see FABLE_THINKING_MULTIPLIER.
 */
export const MODEL_RATES: Record<string, ModelRate> = {
  opus48: { name: 'Opus 4.8', input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  sonnet5: { name: 'Sonnet 5', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  fable5: { name: 'Fable 5', input: 10, output: 50, cacheRead: 1.0, cacheWrite: 12.5 },
  haiku45: { name: 'Haiku 4.5', input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

/**
 * MEASURED CALIBRATION — real commander.js build, single-agent Opus 4.8.
 *
 * This is the ground-truth data point the per-LOC constants below are derived
 * from. Keep it here (not just in comments) so re-calibration as more real builds
 * are measured is a data edit, not code archaeology. Add new measurements and
 * re-fit `PER_LOC` when the sample grows.
 *
 *   source LOC   = 6080  → produced 22 components
 *   tokens:      cache_read = 7,191,702   cache_creation = 390,875
 *                uncached_input = 132     output = 160,386
 *   wall time    = 952 s (~16 min);  Opus 4.8 cost ≈ $10.05
 */
export const MEASURED_BUILD = {
  sourceLoc: 6080,
  components: 22,
  cacheReadTokens: 7_191_702,
  cacheCreationTokens: 390_875,
  uncachedInputTokens: 132,
  outputTokens: 160_386,
  wallSeconds: 952,
  opusCostUsd: 10.05,
} as const;

/**
 * Per-LOC constants fitted from {@link MEASURED_BUILD} (single-agent baseline).
 * Token counts are model-AGNOSTIC (a build does the same work regardless of which
 * model runs it); only the $ rates differ per model.
 */
export const PER_LOC = {
  /** cache-read tokens per source LOC. */
  cacheRead: 1183,
  /** cache-creation (cache-write) tokens per source LOC. */
  cacheCreation: 64,
  /** output tokens per source LOC. */
  output: 26.4,
  /** wall seconds per source LOC (single agent, before province fan-out). */
  seconds: 0.157,
  /** source LOC per produced component (≈ LOC/276). */
  locPerComponent: 276,
} as const;

/** Fable 5 emits ~1.5× the output tokens of peers from always-on thinking. */
export const FABLE_THINKING_MULTIPLIER = 1.5;

/** Estimated component count is clamped to the sane map band. */
export const COMPONENT_CLAMP = { min: 5, max: 80 } as const;

/**
 * The BUILD-tier models shown in the estimate table — Opus 4.8 and Fable 5 ONLY.
 * Sonnet/Haiku are the INTERVENTION tier (quiz/socratic) and are deliberately
 * excluded from the build table; they appear only in the footer note.
 */
export const ESTIMATE_MODEL_KEYS = ['opus48', 'fable5'] as const;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Cost in USD for one model given a token basis. Uncached input is ~0 for a
 * build (the measured 132 tokens are negligible) and intentionally omitted.
 */
export function modelCost(
  rate: ModelRate,
  tokens: { cacheRead: number; cacheCreation: number; output: number },
): number {
  return (
    (tokens.cacheRead * rate.cacheRead +
      tokens.cacheCreation * rate.cacheWrite +
      tokens.output * rate.output) /
    1_000_000
  );
}

/** Per-model cost line: `low` == `high` except Fable (thinking output range). */
export interface ModelEstimate {
  key: string;
  name: string;
  /** Lower-bound cost (baseline output). */
  costLow: number;
  /** Upper-bound cost (== costLow unless the model has a thinking range). */
  costHigh: number;
}

/** The full estimate for a scanned repo of `loc` source lines. */
export interface BuildEstimate {
  loc: number;
  /** Estimated component count (clamped to the map band). */
  components: number;
  /** Model-agnostic token basis. */
  tokens: { cacheRead: number; cacheCreation: number; output: number };
  /** Single-agent wall time. */
  seconds: number;
  minutes: number;
  /** Per-model cost estimates for the BUILD tier (Opus 4.8, Fable 5). */
  models: ModelEstimate[];
}

/**
 * Estimate the Mode B build for `loc` scanned source lines. Pure: the same LOC
 * always yields the same estimate. Token basis is model-agnostic; per-model cost
 * applies that model's rates. Fable is returned as a low–high range reflecting
 * ~1.5× output from always-on thinking.
 */
export function estimateBuild(loc: number): BuildEstimate {
  const l = Math.max(0, loc);
  const components = clamp(Math.round(l / PER_LOC.locPerComponent), COMPONENT_CLAMP.min, COMPONENT_CLAMP.max);
  const tokens = {
    cacheRead: PER_LOC.cacheRead * l,
    cacheCreation: PER_LOC.cacheCreation * l,
    output: PER_LOC.output * l,
  };
  const seconds = PER_LOC.seconds * l;

  const models: ModelEstimate[] = ESTIMATE_MODEL_KEYS.map((key) => {
    const rate = MODEL_RATES[key]!;
    const costLow = modelCost(rate, tokens);
    const costHigh =
      key === 'fable5'
        ? modelCost(rate, { ...tokens, output: tokens.output * FABLE_THINKING_MULTIPLIER })
        : costLow;
    return { key, name: rate.name, costLow, costHigh };
  });

  return { loc: l, components, tokens, seconds, minutes: seconds / 60, models };
}
