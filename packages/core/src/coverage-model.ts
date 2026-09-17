import type { ComponentCoverage, CoverageState, Dimensions, UserCoverage } from './schema/coverage.js';
import type { MapNode } from './schema/map.js';

/** Tunable constants for the v1 coverage model (§5.1). */
export interface CoverageConstants {
  /** EMA weight on the newest active score. */
  emaAlpha: number;
  /** Weighted-dims bar for `validated`. */
  validateDim: number;
  /** Minimum number of active validations before a component can be validated. */
  minActiveValidations: number;
  /** Relative weights of the three dims in the weighted mean. */
  dimWeights: Record<keyof Dimensions, number>;
}

/**
 * Default constants. Kept as a single exported object so they can be overridden
 * per-config or re-fit later without touching call sites.
 */
export const DEFAULT_CONSTANTS: CoverageConstants = {
  emaAlpha: 0.5,
  validateDim: 0.6,
  minActiveValidations: 2,
  dimWeights: { structure: 1, concepts: 1, rationale: 1 },
};

/** EMA update for a single dimension: dim ← (1-alpha)*prev + alpha*score. */
export function emaUpdate(prev: number, score: number, alpha: number = DEFAULT_CONSTANTS.emaAlpha): number {
  return (1 - alpha) * prev + alpha * score;
}

/** loyalty = 1 − min(1, churn/size). A size of 0 yields loyalty 0 (fully churned). */
export function computeLoyalty(churnLines: number, componentSize: number): number {
  if (componentSize <= 0) return 0;
  return 1 - Math.min(1, churnLines / componentSize);
}

/** Weighted mean of a component's three dims. */
export function meanDims(dims: Dimensions, weights = DEFAULT_CONSTANTS.dimWeights): number {
  const wSum = weights.structure + weights.concepts + weights.rationale;
  if (wSum <= 0) return 0;
  return (
    (dims.structure * weights.structure +
      dims.concepts * weights.concepts +
      dims.rationale * weights.rationale) /
    wSum
  );
}

/**
 * Unification progress = Σ(importance × mean(dims)) / Σ(importance) over all
 * mapped nodes. Nodes with no coverage record contribute mean-dims 0.
 */
export function unificationProgress(nodes: MapNode[], coverage: UserCoverage): number {
  let weighted = 0;
  let totalImportance = 0;
  for (const node of nodes) {
    totalImportance += node.importance;
    const comp = coverage.components[node.id];
    if (comp) weighted += node.importance * meanDims(comp.dims);
  }
  if (totalImportance <= 0) return 0;
  return weighted / totalImportance;
}

/** Inputs to state classification beyond the component's own record. */
export interface ClassifyOpts {
  /** True if a passive signal (touch/prompt/doc_read) just landed. */
  hadPassiveSignal?: boolean;
  /** Count of active validations (quiz/socratic) accrued for this component. */
  activeValidations?: number;
  /** Overrides for the model constants. */
  constants?: Partial<CoverageConstants>;
}

/**
 * Classify a component's coverage state from its (already-updated) record.
 *
 *  - `validated` when weighted dims ≥ validateDim AND ≥ minActiveValidations.
 *  - `explored` once any passive signal has landed (or it was already beyond fog).
 *  - `fog` otherwise.
 *
 * `stale` is deliberately NOT decided here. Rebellion needs authorship-split
 * churn, which only {@link recomputeDrift} is given, and this function used to
 * derive it a second way (from `loyalty`) — two rules for one state, able to
 * disagree. It never actually fired, because inside the evidence fold loyalty is
 * always 1 and drift runs afterwards, so the branch was dead code pretending to
 * be policy. Drift is now the single authority, and because the fold rebuilds
 * state from scratch every run, `stale` is never sticky: a recovered component
 * comes out of the fold `validated` and drift decides again.
 */
export function classifyState(prev: ComponentCoverage, opts: ClassifyOpts = {}): CoverageState {
  const k = { ...DEFAULT_CONSTANTS, ...opts.constants };
  const activeValidations = opts.activeValidations ?? 0;
  const weighted = meanDims(prev.dims, k.dimWeights);

  // Conquest: enough weighted comprehension plus enough active validations.
  if (weighted >= k.validateDim && activeValidations >= k.minActiveValidations) {
    return 'validated';
  }

  // Scouted: any passive contact, or already past fog.
  if (
    opts.hadPassiveSignal ||
    prev.state === 'explored' ||
    prev.state === 'validated' ||
    prev.state === 'stale' ||
    weighted > 0
  ) {
    return 'explored';
  }

  return 'fog';
}
