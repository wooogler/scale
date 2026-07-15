/**
 * Higher-level coverage state operations (PLAN §5 / §5.1) — the junior-side
 * COVERAGE ENGINE. Everything here is PURE and DETERMINISTIC: no git, no fs, no
 * Date/random. Churn and file sizes are INJECTED by the caller (the CLI), so the
 * same evidence + options always fold to a byte-identical UserCoverage.
 */
import type { ScaleConfig } from './schema/config.js';
import type { EvidenceEntry } from './schema/evidence.js';
import {
  UserCoverageSchema,
  type ComponentCoverage,
  type Dimensions,
  type UserCoverage,
} from './schema/coverage.js';
import type { MapJson } from './schema/map.js';
import { classifyState, computeLoyalty, DEFAULT_CONSTANTS, emaUpdate } from './coverage-model.js';

/**
 * Small structure credit granted per passive touch/prompt. Repeated passive
 * contact climbs toward `passiveStructureCap` but never past it.
 */
const PASSIVE_STRUCTURE_CREDIT = 0.1;
/** Small per-dim credit granted per paper_read, capped at `paperReadCap`. */
const PAPER_READ_CREDIT = 0.1;

/** A fresh, never-explored coverage record. */
export function emptyComponentCoverage(): ComponentCoverage {
  return {
    state: 'fog',
    dims: { structure: 0, concepts: 0, rationale: 0 },
    lastValidatedSha: null,
    loyalty: 1,
  };
}

/**
 * Fold context threaded through a `materializeCoverage` run. `activeValidations`
 * is a caller-owned accumulator (componentId → cumulative active-validation
 * count) that survives across entries — the ComponentCoverage schema has no such
 * field, so it lives here as a side map and is fed into `classifyState`.
 */
export interface ApplyContext {
  /**
   * Fallback HEAD sha, used as the validation anchor ONLY when an active
   * evidence entry carries no `sha` of its own (backward compat). Prefer the
   * entry's own `sha`, which pins the validation to when it was recorded.
   */
  headSha?: string;
  /** componentId → cumulative active-validation count (mutated as the fold runs). */
  activeValidations?: Record<string, number>;
  /**
   * componentId → sha of the MOST RECENT active-validation entry applied to it
   * (entry.sha when present, else ctx.headSha). Caller-owned accumulator that
   * survives across entries; feeds `lastValidatedSha` when a component is
   * validated, so the anchor reflects the real validation point and stays stable
   * across re-materializations.
   */
  lastActiveSha?: Record<string, string>;
}

/**
 * Fold a single evidence entry into a user's coverage, returning a NEW
 * UserCoverage (input untouched). Per §5.1:
 *
 *  - `touch`/`prompt` (passive) — fog→explored + small structure credit, capped
 *    at `passiveStructureCap`; passive signal alone can never push structure past
 *    the cap (active validation can).
 *  - `paper_read` (passive) — fog→explored + small bump to all three dims, each
 *    capped at `paperReadCap`.
 *  - `diff_review` — v1 LOGGED ONLY: latency is kept as raw evidence but is NOT
 *    modeled into dims in v1. No coverage change.
 *  - `quiz_result` (active) — EMA-update the tagged dim; +1 active validation.
 *  - `socratic_result` (active) — EMA-update every scored dim; +1 active validation.
 *  - `intervention` — accounting only (shown/deferred/completed); no dim change.
 *
 * After updating dims the state is recomputed via `classifyState` using the
 * accumulated active-validation count. While `validated`, `lastValidatedSha` is
 * anchored to the component's most recent active-validation sha (`ctx.lastActiveSha`,
 * derived from each entry's own `sha` — the HEAD at record time — falling back to
 * `ctx.headSha`), NOT the current HEAD; loyalty resets to 1 only on first entry.
 */
export function applyEvidence(
  coverage: UserCoverage,
  entry: EvidenceEntry,
  config: ScaleConfig,
  ctx: ApplyContext = {},
): UserCoverage {
  const next: UserCoverage = {
    ...coverage,
    updatedAt: entry.ts,
    components: { ...coverage.components },
  };

  // diff_review: v1 records that a review happened (raw evidence, appended
  // elsewhere) but deliberately does NOT model proposal→execution latency into
  // dims. No coverage change.
  if (entry.type === 'diff_review') return next;
  // intervention: tracked for accounting only. No dim change.
  if (entry.type === 'intervention') return next;

  const av = ctx.activeValidations ?? {};
  const las = ctx.lastActiveSha ?? {};
  // Config-tunable EMA weight on the newest active score (higher → faster, more
  // visible per-session movement). Falls back to the model default.
  const alpha = config.thresholds.emaAlpha ?? DEFAULT_CONSTANTS.emaAlpha;
  const isPassive =
    entry.type === 'touch' || entry.type === 'prompt' || entry.type === 'paper_read';

  for (const id of componentIdsOf(entry)) {
    const prev = next.components[id] ?? emptyComponentCoverage();
    let dims = prev.dims;
    let lastValidatedSha = prev.lastValidatedSha;
    let loyalty = prev.loyalty;

    if (entry.type === 'touch' || entry.type === 'prompt') {
      dims = {
        ...dims,
        structure: passiveBump(
          dims.structure,
          PASSIVE_STRUCTURE_CREDIT,
          config.thresholds.passiveStructureCap,
        ),
      };
    } else if (entry.type === 'paper_read') {
      const cap = config.thresholds.paperReadCap;
      dims = {
        structure: passiveBump(dims.structure, PAPER_READ_CREDIT, cap),
        concepts: passiveBump(dims.concepts, PAPER_READ_CREDIT, cap),
        rationale: passiveBump(dims.rationale, PAPER_READ_CREDIT, cap),
      };
    } else if (entry.type === 'quiz_result') {
      dims = withDim(
        dims,
        entry.dim,
        emaUpdate(prev.dims[entry.dim], entry.score, alpha),
      );
      av[id] = (av[id] ?? 0) + 1;
      // Anchor the validation point to when THIS entry was recorded (entry.sha),
      // falling back to the run's HEAD only when the entry predates the field.
      const sha = entry.sha ?? ctx.headSha;
      if (sha !== undefined) las[id] = sha;
    } else if (entry.type === 'socratic_result') {
      dims = { ...dims };
      for (const [dim, score] of Object.entries(entry.dims)) {
        if (score === undefined) continue;
        const d = dim as keyof Dimensions;
        dims = withDim(dims, d, emaUpdate(prev.dims[d], score, alpha));
      }
      av[id] = (av[id] ?? 0) + 1;
      const sha = entry.sha ?? ctx.headSha;
      if (sha !== undefined) las[id] = sha;
    }

    const candidate: ComponentCoverage = { ...prev, dims, lastValidatedSha, loyalty };
    const state = classifyState(candidate, {
      hadPassiveSignal: isPassive,
      activeValidations: av[id] ?? 0,
      constants: {
        validateDim: config.thresholds.validateDim,
        staleLoyalty: config.thresholds.staleLoyalty,
      },
    });

    // Being `validated` anchors `lastValidatedSha` to the component's most recent
    // active-validation sha (WHEN it was recorded) — NOT the current, possibly
    // already-drifted HEAD. This is what makes staleness persist: across a
    // re-materialization the anchor re-derives to the same past sha, so churn is
    // still measured from the real validation point instead of collapsing to 0.
    // Entering `validated` additionally resets loyalty (fresh until code moves).
    if (state === 'validated') {
      lastValidatedSha = las[id] ?? prev.lastValidatedSha;
      if (prev.state !== 'validated') loyalty = 1;
    }

    next.components[id] = { state, dims, lastValidatedSha, loyalty };
  }

  return next;
}

/** Options for {@link recomputeDrift}: injected churn/size per component. */
export interface DriftOpts {
  /** componentId → churned lines since its lastValidatedSha (default 0). */
  churn: Record<string, number>;
  /** componentId → component size in lines (default 0 → unknown). */
  sizes: Record<string, number>;
  config: ScaleConfig;
}

/**
 * Recompute loyalty/staleness for every component from INJECTED churn/sizes
 * (PLAN §5.1). PURE — no git/fs. For each component with a `lastValidatedSha`:
 *
 *   loyalty = 1 − min(1, churn / size)
 *
 * and a previously-`validated` component whose loyalty drops below
 * `staleLoyalty` flips to `stale`. Components never validated (lastValidatedSha
 * null) keep loyalty 1 and their fog/explored state. With empty churn/sizes,
 * loyalty stays 1 and nothing goes stale.
 */
export function recomputeDrift(coverage: UserCoverage, opts: DriftOpts): UserCoverage {
  const next: UserCoverage = { ...coverage, components: { ...coverage.components } };

  for (const [id, comp] of Object.entries(coverage.components)) {
    if (comp.lastValidatedSha === null) continue; // never validated → untouched

    const churn = opts.churn[id] ?? 0;
    const size = opts.sizes[id] ?? 0;
    // No churn measured → no drift (this is the empty-defaults path). Otherwise
    // fall back to "fully churned" when the size is unknown (0-safe): a real
    // caller always supplies sizes, so this only bites on malformed input.
    const loyalty = churn <= 0 ? 1 : size > 0 ? computeLoyalty(churn, size) : 0;

    let state = comp.state;
    if (comp.state === 'validated' && loyalty < opts.config.thresholds.staleLoyalty) {
      state = 'stale';
    }
    next.components[id] = { ...comp, loyalty, state };
  }

  return next;
}

/** Options for {@link materializeCoverage}. */
export interface MaterializeOpts {
  /** Frozen map — seeds a coverage record for every node id. */
  map: MapJson;
  config: ScaleConfig;
  user: string;
  /** HEAD sha stamped onto components that reach `validated` this run. */
  headSha: string;
  /** componentId → churned lines since lastValidatedSha (default empty). */
  churn?: Record<string, number>;
  /** componentId → component size in lines (default empty). */
  sizes?: Record<string, number>;
  /** Timestamp for `updatedAt`; caller supplies it to keep this pure/testable. */
  now?: string;
}

/**
 * Deterministically fold raw evidence into a materialized UserCoverage (§5.1):
 *
 *   1. seed `emptyComponentCoverage()` for every map node id,
 *   2. sort evidence by `ts` ascending and fold through {@link applyEvidence}
 *      (threading `headSha` for lastValidatedSha stamping + a side
 *      activeValidations accumulator),
 *   3. apply {@link recomputeDrift} with the injected churn/sizes,
 *   4. stamp `updatedAt = opts.now ?? ''` (never reads the clock here),
 *   5. validate against UserCoverageSchema before returning.
 *
 * Same evidence + opts → identical UserCoverage.
 */
export function materializeCoverage(
  evidence: EvidenceEntry[],
  opts: MaterializeOpts,
): UserCoverage {
  const components: Record<string, ComponentCoverage> = {};
  for (const node of opts.map.nodes) components[node.id] = emptyComponentCoverage();

  let cov: UserCoverage = { user: opts.user, updatedAt: '', components };

  // Stable ascending sort by ISO-8601 timestamp; ties keep input order.
  const ordered = [...evidence].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

  const activeValidations: Record<string, number> = {};
  const lastActiveSha: Record<string, string> = {};
  for (const entry of ordered) {
    cov = applyEvidence(cov, entry, opts.config, {
      headSha: opts.headSha,
      activeValidations,
      lastActiveSha,
    });
  }

  cov = recomputeDrift(cov, {
    churn: opts.churn ?? {},
    sizes: opts.sizes ?? {},
    config: opts.config,
  });

  cov = { ...cov, updatedAt: opts.now ?? '' };
  return UserCoverageSchema.parse(cov);
}

/** Raise a dim toward `cap` by `credit`, never lowering an already-higher value. */
function passiveBump(current: number, credit: number, cap: number): number {
  if (current >= cap) return current;
  return Math.min(cap, current + credit);
}

function withDim(dims: Dimensions, dim: keyof Dimensions, value: number): Dimensions {
  return { ...dims, [dim]: Math.max(0, Math.min(1, value)) };
}

function componentIdsOf(entry: EvidenceEntry): string[] {
  switch (entry.type) {
    case 'prompt':
    case 'touch':
      return entry.componentIds;
    case 'paper_read':
    case 'quiz_result':
    case 'socratic_result':
    case 'intervention':
      return [entry.componentId];
    case 'diff_review':
      return [];
  }
}
