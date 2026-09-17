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
/** Small per-dim credit granted per doc_read, capped at `docReadCap`. */
const DOC_READ_CREDIT = 0.1;

/** A fresh, never-explored coverage record. */
export function emptyComponentCoverage(): ComponentCoverage {
  return {
    state: 'fog',
    dims: { structure: 0, concepts: 0, rationale: 0 },
    lastValidatedSha: null,
    loyalty: 1,
    driftCause: null,
    driftAuthors: [],
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
 *  - `doc_read` (passive) — fog→explored + small bump to all three dims, each
 *    capped at `docReadCap`. The legacy `paper_read` rows still on disk are the
 *    same signal under the old name and are credited identically.
 *    ('paper_read' is the legacy literal — see schema/evidence.ts.)
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
    entry.type === 'touch' ||
    entry.type === 'prompt' ||
    entry.type === 'doc_read' ||
    entry.type === 'paper_read';

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
    } else if (entry.type === 'doc_read' || entry.type === 'paper_read') {
      // Both literals, identically: `paper_read` is what the same event was
      // called before the rename, and the log it lives in is append-only.
      const cap = config.thresholds.docReadCap;
      dims = {
        structure: passiveBump(dims.structure, DOC_READ_CREDIT, cap),
        concepts: passiveBump(dims.concepts, DOC_READ_CREDIT, cap),
        rationale: passiveBump(dims.rationale, DOC_READ_CREDIT, cap),
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
      constants: { validateDim: config.thresholds.validateDim },
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

    // Drift fields are recomputed wholly by `recomputeDrift` after this fold,
    // so the fold clears them: a component the evidence has re-validated must
    // not carry the previous run's "who took it" into the new verdict.
    next.components[id] = {
      state,
      dims,
      lastValidatedSha,
      loyalty,
      driftCause: null,
      driftAuthors: [],
    };
  }

  return next;
}

/**
 * Churn on one component since its `lastValidatedSha`, SPLIT BY AUTHORSHIP.
 *
 * The split is the whole point of the drift split: a teammate's change is code this
 * user has never read, while their own change was already gated before they
 * wrote it. Measured by the CLI (git); injected here so this stays pure.
 */
export interface ComponentChurn {
  /** Lines (added + deleted) from commits authored by someone else. */
  foreign: number;
  /** Lines from commits authored by this user. */
  self: number;
  /** Distinct foreign author identities, sorted — for the digest and grounding. */
  foreignAuthors?: string[];
  /** How many foreign commits touched it (drives `any-foreign-commit`). */
  foreignCommits?: number;
  /**
   * A foreign commit changed a file git reports no line counts for (it decided
   * the file is binary — a single stray NUL byte in a source file is enough).
   * The change is real but unmeasurable, so the ratio can never see it; treated
   * as cause on its own rather than silently scoring zero.
   */
  unmeasurableForeign?: boolean;
}

const NO_CHURN: ComponentChurn = { foreign: 0, self: 0 };

/** Options for {@link recomputeDrift}: injected churn/size per component. */
export interface DriftOpts {
  /** componentId → authorship-split churn since its lastValidatedSha. */
  churn: Record<string, ComponentChurn>;
  /** componentId → component size in lines (default 0 → unknown). */
  sizes: Record<string, number>;
  config: ScaleConfig;
}

/** Why a component drifted, or null when it did not. */
export type DriftCause = 'foreign' | 'self' | null;

/**
 * Decide whether a component has DRIFTED. The SINGLE drift rule — see the
 * note on {@link classifyState} for why it is not also derived from loyalty.
 *
 * `ratio` mode compares each side's churn against the component's size, with a
 * deliberately lower bar for foreign churn than for self churn. When the size is
 * unknown (0) any churn at all counts as total, which errs toward re-checking
 * rather than toward silently trusting an unmeasurable component.
 */
export function causeOfDrift(
  churn: ComponentChurn,
  size: number,
  config: ScaleConfig,
): DriftCause {
  const reb = config.drift;
  if (reb.trigger === 'any-foreign-commit') {
    return (churn.foreignCommits ?? 0) > 0 ? 'foreign' : null;
  }
  // A foreign change we cannot measure counts on its own — otherwise a binary-
  // classified source file is a permanent blind spot.
  if (churn.unmeasurableForeign) return 'foreign';
  const ratio = (lines: number): number => (lines <= 0 ? 0 : size > 0 ? lines / size : 1);
  if (ratio(churn.foreign) >= reb.foreignRatio) return 'foreign';
  if (ratio(churn.self) >= reb.selfRatio) return 'self';
  return null;
}

/**
 * Recompute loyalty/staleness for every component from INJECTED churn/sizes
 * (PLAN §5.1, PLAN-GATE §4 S2). PURE — no git/fs. For each component with a
 * `lastValidatedSha`:
 *
 *   loyalty = 1 − min(1, (foreign + self) / size)      // display: how far it moved
 *   stale   = it was `validated` AND {@link causeOfDrift} fires
 *
 * Components never validated (lastValidatedSha null) keep loyalty 1 and their
 * fog/explored state — you cannot lose ground you never held. With empty churn,
 * loyalty stays 1 and nothing goes stale.
 */
export function recomputeDrift(coverage: UserCoverage, opts: DriftOpts): UserCoverage {
  const next: UserCoverage = { ...coverage, components: { ...coverage.components } };

  for (const [id, comp] of Object.entries(coverage.components)) {
    if (comp.lastValidatedSha === null) continue; // never validated → untouched

    const churn = opts.churn[id] ?? NO_CHURN;
    const size = opts.sizes[id] ?? 0;
    const total = churn.foreign + churn.self;
    // No churn measured → no drift (this is the empty-defaults path). Otherwise
    // fall back to "fully churned" when the size is unknown (0-safe): a real
    // caller always supplies sizes, so this only bites on malformed input.
    const loyalty = total <= 0 ? 1 : size > 0 ? computeLoyalty(total, size) : 0;

    const cause = comp.state === 'validated' ? causeOfDrift(churn, size, opts.config) : null;
    const state = cause !== null ? 'stale' : comp.state;
    next.components[id] = {
      ...comp,
      loyalty,
      state,
      // Carried on the record so the viewer can tell the two kinds apart without
      // a second endpoint, and cleared the moment a component is no longer stale
      // — a recovered territory must not still say who took it.
      driftCause: cause,
      driftAuthors: cause === 'foreign' ? (churn.foreignAuthors ?? []) : [],
    };
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
  churn?: Record<string, ComponentChurn>;
  /** componentId → component size in lines (default empty). */
  sizes?: Record<string, number>;
  /** Timestamp for `updatedAt`; caller supplies it to keep this pure/testable. */
  now?: string;
}

/**
 * PHASE 1 of materialization: seed every map node and fold the evidence, with
 * NO drift applied. The result's `lastValidatedSha` values are the anchors the
 * caller must measure churn from.
 *
 * Split out of {@link materializeCoverage} because the two phases have a real
 * data dependency the single-call form could not express: churn has to be
 * measured from the anchor this fold PRODUCES, not from the one the previous
 * run persisted. Measuring from the stale anchor made recovery take two
 * recomputes — a component that had just been re-validated was still compared
 * against the pre-drift sha, so it flipped straight back to `stale` (and,
 * once the edit gate re-locks on drift, straight back to LOCKED) in the very
 * same command that recorded the passing check.
 *
 * Deterministic: evidence is sorted by `ts` ascending, ties keeping input order.
 */
export function foldEvidence(
  evidence: EvidenceEntry[],
  opts: Pick<MaterializeOpts, 'map' | 'config' | 'user' | 'headSha'>,
): UserCoverage {
  const components: Record<string, ComponentCoverage> = {};
  for (const node of opts.map.nodes) components[node.id] = emptyComponentCoverage();

  let cov: UserCoverage = { user: opts.user, updatedAt: '', components };

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
  return cov;
}

/**
 * Deterministically fold raw evidence into a materialized UserCoverage (§5.1):
 *
 *   1. {@link foldEvidence} — seed + fold,
 *   2. apply {@link recomputeDrift} with the injected churn/sizes,
 *   3. stamp `updatedAt = opts.now ?? ''` (never reads the clock here),
 *   4. validate against UserCoverageSchema before returning.
 *
 * Same evidence + opts → identical UserCoverage. Callers that need churn
 * measured from THIS run's anchors (the CLI does) should instead run the two
 * phases themselves: `foldEvidence` → read anchors → measure → `recomputeDrift`
 * → {@link finalizeCoverage}.
 */
export function materializeCoverage(
  evidence: EvidenceEntry[],
  opts: MaterializeOpts,
): UserCoverage {
  const cov = recomputeDrift(foldEvidence(evidence, opts), {
    churn: opts.churn ?? {},
    sizes: opts.sizes ?? {},
    config: opts.config,
  });
  return finalizeCoverage(cov, opts.now);
}

/** Stamp `updatedAt` and validate — the tail both materialization paths share. */
export function finalizeCoverage(coverage: UserCoverage, now?: string): UserCoverage {
  return UserCoverageSchema.parse({ ...coverage, updatedAt: now ?? '' });
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
    case 'doc_read':
    case 'paper_read':
    case 'quiz_result':
    case 'socratic_result':
    case 'intervention':
      return [entry.componentId];
    case 'diff_review':
      return [];
  }
}
