/**
 * Build-cost estimator (pure math) for the Mode B `scale-map` build (PLAN §4.3).
 *
 * Answers two questions BEFORE the user commits to running the (expensive,
 * LLM-heavy) coverage-memory build: how much it will cost, and — the part that
 * is not a guess — how many components the partition should have.
 *
 * Everything here is pure arithmetic over the repo's measured shape: source LOC
 * and source FILE count, plus a documented calibration block. No fs, no git, no
 * LLM; the CLI does the scan and feeds both numbers in.
 *
 * The two halves have different standing and should be read differently. The
 * cost is rough by design (±~50%) — an order-of-magnitude decision aid, not a
 * billing figure. The component target is exact arithmetic and is a contract:
 * the survey is approved against it and {@link checkPartition} holds the built
 * partition to it afterwards. Before that was true, a skill-side range silently
 * overrode this number and a repo sized for 8 components was built with 36.
 *
 * The halves are also INDEPENDENT, which is easy to misread: the cost basis is
 * projected from LOC alone and does not move with the component target, so two
 * repos of equal size price identically however differently they partition.
 *
 * MEASURED, so the effect is not overstated: koa was built twice from the same
 * commit, once at 36 components and once at 8. The 36-component build spent
 * about 1.4x the tokens of the 8-component one — more, because the docs are
 * the output, but nowhere near the 4.5x its component count overshot by. Most of
 * a build's cost is reading the same source, which is why pricing from LOC alone
 * turns out to be a fair basis and why the count has to be enforced on its own
 * terms rather than through the bill.
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
 * re-price is a one-line edit. A model that thinks by default produces ~1.5× the
 * output of one that does not, for the same work — see
 * THINKING_OUTPUT_MULTIPLIER and THINKING_BY_DEFAULT.
 */
export const MODEL_RATES: Record<string, ModelRate> = {
  opus5: { name: 'Opus 5', input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  // Retained at its own rates: no longer a BUILD choice, but still the `opus`
  // INTERVENTION tier, whose footnote prices itself from this entry.
  opus48: { name: 'Opus 4.8', input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  sonnet5: { name: 'Sonnet 5', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  fable5: { name: 'Fable 5', input: 10, output: 50, cacheRead: 1.0, cacheWrite: 12.5 },
};

/**
 * MEASURED CALIBRATION — real commander.js build, single-agent Opus 4.8 with
 * thinking off (4.8's default). Treat the output figure as a floor for any model
 * that thinks by default — see THINKING_BY_DEFAULT.
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
  /**
   * NOT RECORDED. The one calibration run predates file count being a sizing
   * input, so there is no way to tell whether its 22 components were what the
   * code deserved or what its file count allowed. Any re-fit of
   * {@link PER_LOC.locPerComponent} must record this, or it will re-fit against
   * a point whose binding constraint is unknown — and `locPerComponent` was
   * itself derived under the old hard 20–60 band, so it is a measurement of a
   * build that was pushed toward that range.
   */
  files: null,
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

/**
 * A model that thinks by default emits ~1.5× the output tokens of one that does
 * not, for the same work. {@link MEASURED_BUILD} was recorded on Opus 4.8, which
 * does NOT think unless asked — so for the models below the measurement is a
 * FLOOR, and their estimate is reported as a low–high band rather than a point.
 */
export const THINKING_OUTPUT_MULTIPLIER = 1.5;

/**
 * BUILD models whose thinking is on by default: Fable 5's is always on, and
 * Opus 5 runs adaptive thinking unless explicitly disabled. Opus 4.8 is absent
 * on purpose — omitting `thinking` there means no thinking, which is the
 * condition {@link MEASURED_BUILD} was measured under.
 */
export const THINKING_BY_DEFAULT: ReadonlySet<string> = new Set(['fable5', 'opus5']);

/**
 * Children per node the map layout and the survey step both assume. A province
 * holding fewer than `min` is not pulling its weight as a grouping; one holding
 * more than `max` is a list, not a group. Grouping depth is derived from these
 * rather than fixed, so the same rule sizes a 2k-LOC library and a 1M-LOC
 * monorepo.
 */
export const CHILDREN_PER_NODE = { min: 5, max: 9 } as const;

/**
 * Leaves one FLAT province layer holds: at most `max` provinces of at most `max`
 * components each.
 *
 * DERIVED, not chosen. A hand-picked ceiling here was the source of a
 * contradiction: it said hierarchy was needed above 60 while
 * {@link groupingDepth} — applying the same branching factor — happily reported
 * a single grouping level up to 81, so the two guards disagreed about the same
 * map. Deriving it means there is only one rule.
 *
 * The stored layout is comfortable well past this: measured on the frozen
 * layout, the minimum pairwise node distance holds its guarantee to ~180 nodes
 * and only degrades around 243. So this ceiling is about the GROUPING rule and
 * about a map staying readable, not about the geometry giving out.
 */
export const FLAT_MAX_LEAVES = CHILDREN_PER_NODE.max * CHILDREN_PER_NODE.max;

/**
 * Floor on the LEAF count, whatever the arithmetic says: a handful of
 * territories is the least that can carry a map at all.
 *
 * There is deliberately no `max` here any more. The old single
 * `{min: 5, max: 80}` clamp was read downstream as a content rule — a ceiling on
 * how many territories a repo may deserve — and the skill's own hard "20–60"
 * band then overrode the estimate entirely (measured on koa: estimate 8, built
 * 36). A target above {@link FLAT_MAX_LEAVES} is a signal to add a grouping
 * level, not to merge territories that deserve to be separate.
 */
export const LEAF_CLAMP = { min: 5 } as const;

/**
 * Components per ANCHORED source file above which the partition stops being
 * resolvable. Every consumer that turns an edit into a territory — the edit
 * gate, the touch-credit path, drift measurement, and the link metrics in
 * `graphify-check` — is keyed by file, so past this ratio one edit gates,
 * credits and re-locks several territories together. The bar sits just above 1
 * so a handful of legitimately shared files still passes, while a partition
 * built at sub-file granularity does not (koa measured 4.5).
 */
export const GRANULARITY_MAX_PER_FILE = 1.5;

/**
 * How far the survey may land from the target before it must re-estimate and
 * ask for approval again. 1.5× is deliberately generous: the target is
 * arithmetic over LOC and file count, and a cartographer reading the actual
 * code has standing to disagree with it — but not to disagree by 4.5×, which is
 * what happened on koa (estimate 8, built 36) because nothing checked.
 *
 * It is the tolerance BEFORE clipping, not the band. `partitionTarget` then
 * clips the top so it can never authorize what {@link checkPartition} would
 * reject, which means the realized upper tolerance shrinks toward 1× as the
 * target approaches either ceiling. Read the band off the result, never off this
 * constant.
 */
export const SURVEY_TOLERANCE = 1.5;

/**
 * The BUILD-tier models shown in the estimate table — Opus 5 and Fable 5 ONLY.
 * The INTERVENTION tier (quiz/socratic) is a separate, recurring cost and is
 * deliberately excluded from the build table; it appears only in the footer note.
 */
export const ESTIMATE_MODEL_KEYS = ['opus5', 'fable5'] as const;

/** The scanned shape of a repository — the only two inputs sizing needs. */
export interface RepoShape {
  /** Scanned source lines. */
  loc: number;
  /** Scanned source files. */
  files: number;
}

/**
 * How big the partition should be, and why.
 *
 * Two independent limits meet here, and reporting only their minimum would hide
 * which one is binding — which is exactly the information the cartographer and
 * the next stage of work need:
 *
 *  - `byLoc` is what the CONTENT deserves: how many territories' worth of code
 *    there is, at the measured rate of one per {@link PER_LOC.locPerComponent}
 *    lines.
 *  - `byFiles` is what the ANCHORS can express. A component's `sources` names
 *    files, and the file→component index the edit gate, the touch-credit path
 *    and drift measurement all read is keyed by file. One component per file is
 *    therefore the finest partition this anchor model can resolve; past it, N
 *    components share a file and every one of those consumers credits, gates and
 *    re-locks all N together.
 *
 * `granularityLimited` is true whenever the count being resolved exceeds the
 * file count — whether because the content deserves more territories than there
 * are files, or because even the floor cannot be anchored one per file. The
 * honest reading of it is
 * not "this repo deserves fewer territories" but "file-level anchors cannot
 * express the territories this repo deserves" — the case for symbol-level
 * anchors, and a thing worth printing rather than silently rounding away.
 */
export interface PartitionTarget {
  /** Leaves the content deserves, from LOC alone. */
  byLoc: number;
  /** Leaves file-level anchors can resolve: one per source file. */
  byFiles: number;
  /**
   * What the content asks for once floored — `max(byLoc, LEAF_CLAMP.min)`. This
   * is the number to compare the file count against in prose: quoting `byLoc`
   * produced "deserves ~0 components but only 2 files exist" on a tiny repo.
   */
  demand: number;
  /** The count the build should aim for. */
  target: number;
  /** Survey approval band around `target` (see {@link SURVEY_TOLERANCE}). */
  min: number;
  max: number;
  /**
   * Which of the three limits produced `target`. The renderer used to infer this
   * from `granularityLimited` alone and so had no branch for the floor, telling a
   * forty-line repo its target came "from LOC".
   */
  boundBy: 'loc' | 'files' | 'floor';
  /** True when file count is what caps `target` — i.e. `boundBy === 'files'`. */
  granularityLimited: boolean;
  /** Grouping levels above the leaves. 1 = a single province layer. */
  depth: number;
  /** Nodes at the top level (provinces when `depth` is 1). */
  topGroups: number;
  /** True when `target` exceeds what one flat province layer holds. */
  needsHierarchy: boolean;
}

/**
 * Grouping levels needed so that no node exceeds
 * {@link CHILDREN_PER_NODE.max} children. Iterative rather than a logarithm so
 * the answer is exactly the tree that gets built: at each level the count is the
 * previous level divided by the branching factor, rounded up.
 *
 * At least one level always: the store's layout is
 * `.scale/<province>/<component>/`, so even five leaves live inside a province.
 */
function groupingDepth(leaves: number): { depth: number; topGroups: number } {
  const b = CHILDREN_PER_NODE.max;
  let depth = 1;
  while (Math.ceil(leaves / Math.pow(b, depth)) > b) depth++;
  return { depth, topGroups: Math.ceil(leaves / Math.pow(b, depth)) };
}

/**
 * Size the partition for a scanned repo. Pure arithmetic — the same shape always
 * yields the same target, which is what makes it something a build can be held
 * to after the fact (`scale map check`).
 */
export function partitionTarget(shape: RepoShape): PartitionTarget {
  // `Math.max(0, NaN)` is NaN, and NaN propagated through the band made every
  // comparison in `checkPartition` false — a partition that passed by being
  // incomparable rather than by being right. Non-finite input reads as zero.
  const num = (v: number): number => (Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0);
  const loc = num(shape.loc);
  const files = num(shape.files);

  const byLoc = Math.round(loc / PER_LOC.locPerComponent);
  const byFiles = files;

  // What the CONTENT asks for, floored: forty lines still want a few docs
  // rather than none, so long as there are files to anchor them to.
  const demand = Math.max(LEAF_CLAMP.min, byLoc);

  // One component per file is a HARD ceiling — exceeding it is what made koa's
  // map unresolvable — so it bounds the floor too. A two-file repo's honest
  // target is two, not five. Flooring past the file count made the contract
  // unsatisfiable for any repo of three files or fewer: `checkPartition` would
  // reject the very density the floor had forced. With no files recognized there
  // is nothing to bound against, and the caller is expected to say so rather
  // than quote a target at all.
  const target = byFiles > 0 ? Math.max(1, Math.min(demand, byFiles)) : demand;

  // Which limit produced the target. Inferring this from `granularityLimited`
  // alone left no branch for the floor, so a forty-line repo was told its target
  // came "from LOC".
  const boundBy: 'loc' | 'files' | 'floor' =
    byFiles > 0 && byFiles < demand ? 'files' : byLoc < LEAF_CLAMP.min ? 'floor' : 'loc';

  const { depth, topGroups } = groupingDepth(target);
  // Definitional rather than a second threshold: needing more than one grouping
  // level IS what "too big for a flat map" means.
  const needsHierarchy = depth > 1;

  // The band must never authorize a partition `checkPartition` will then reject —
  // an approval the check overrules is worse than no approval. Two ceilings bind
  // it: the flat map's, unless the repo is already past it and has none left to
  // respect; and the anchor density the check enforces. On koa the second one
  // bites — target 7 over 7 files gave a band top of 11, and a build at 11 would
  // have been inside the approved band and over the per-file limit at once.
  const rawMax = Math.round(target * SURVEY_TOLERANCE);
  const ceilings = [rawMax];
  if (!needsHierarchy) ceilings.push(FLAT_MAX_LEAVES);
  if (byFiles > 0) ceilings.push(Math.floor(byFiles * GRANULARITY_MAX_PER_FILE));

  return {
    byLoc,
    byFiles,
    demand,
    target,
    // The floor applies to the band's bottom only where the target itself
    // cleared it; a two-component repo must not be told to build at least five.
    min: Math.min(target, Math.max(LEAF_CLAMP.min, Math.round(target / SURVEY_TOLERANCE))),
    // A ceiling can land below the target (a tiny repo whose rounding collapses
    // the band); the band degenerates to a point rather than inverting.
    max: Math.max(target, Math.min(...ceilings)),
    boundBy,
    granularityLimited: boundBy === 'files',
    depth,
    topGroups,
    needsHierarchy,
  };
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

/** Per-model cost line: `low` == `high` unless the model thinks by default. */
export interface ModelEstimate {
  key: string;
  name: string;
  /** Lower-bound cost (baseline output). */
  costLow: number;
  /** Upper-bound cost (== costLow unless the model has a thinking range). */
  costHigh: number;
}

/** The full estimate for a scanned repo. */
export interface BuildEstimate {
  loc: number;
  files: number;
  /**
   * The count the build should aim for — `partition.target`, surfaced here
   * because it is the number the operator approves and the survey is held to.
   */
  components: number;
  /** How that count was arrived at, and which limit bound it. */
  partition: PartitionTarget;
  /** Model-agnostic token basis. */
  tokens: { cacheRead: number; cacheCreation: number; output: number };
  /** Single-agent wall time. */
  seconds: number;
  minutes: number;
  /** Per-model cost estimates for the BUILD tier (Opus 5, Fable 5). */
  models: ModelEstimate[];
}

/**
 * Estimate the Mode B build for a scanned repo. Pure: the same shape always
 * yields the same estimate. Token basis is model-agnostic; per-model cost
 * applies that model's rates. A model that thinks by default is returned as a
 * low–high range reflecting ~1.5× output (see THINKING_OUTPUT_MULTIPLIER).
 *
 * Takes the whole {@link RepoShape} rather than LOC alone, because the component
 * count is now bounded by file count too. The cost basis is NOT affected by that
 * — it is projected from LOC alone, so two repos of equal size price identically
 * however differently they partition. Overshooting the target does cost more
 * (measured on koa: about 1.4x the tokens for 4.5x the components), but far less
 * than proportionally, because most of the spend is reading the same source. The
 * count is therefore not something the price can police.
 */
export function estimateBuild(shape: RepoShape): BuildEstimate {
  const l = Math.max(0, shape.loc);
  const partition = partitionTarget(shape);
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
      THINKING_BY_DEFAULT.has(key)
        ? modelCost(rate, { ...tokens, output: tokens.output * THINKING_OUTPUT_MULTIPLIER })
        : costLow;
    return { key, name: rate.name, costLow, costHigh };
  });

  return {
    loc: l,
    files: Math.max(0, Math.floor(shape.files)),
    components: partition.target,
    partition,
    tokens,
    seconds,
    minutes: seconds / 60,
    models,
  };
}

// ---------------------------------------------------------------------------
// Holding a built partition to the contract
// ---------------------------------------------------------------------------

/** What a built `.scale/` looks like, reduced to the numbers sizing cares about. */
export interface BuiltPartition {
  /** Component docs written. */
  components: number;
  /** Distinct source files those docs anchor (the index's key set). */
  anchoredFiles: number;
  /** Components per group, e.g. per province. */
  groupSizes: number[];
}

export interface PartitionFinding {
  /** `fail` means the partition breaks a consumer; `warn` means it is worth saying. */
  level: 'fail' | 'warn';
  /** Stable machine-readable reason, so a caller can act without parsing prose. */
  code:
    | 'too-fine'
    | 'too-coarse'
    | 'unresolvable-anchors'
    | 'oversized-group'
    | 'undersized-group'
    | 'granularity-limited'
    /** Emitted by the CLI, which is the layer that can see the filesystem. */
    | 'stale-anchor';
  message: string;
}

/**
 * Judge a built partition against the target its repo sizes to.
 *
 * Kept pure and separate from the CLI because this is the rule, not the report:
 * the same judgement is wanted by `scale map check`, by the skill's own
 * checklist, and by anything that later gates a build. Splitting size from
 * anchor density matters — a partition can sit inside the band and still be
 * unresolvable (many components on few files), and it can sit outside the band
 * for an honest reason while every file still routes cleanly.
 */
export function checkPartition(built: BuiltPartition, target: PartitionTarget): PartitionFinding[] {
  const findings: PartitionFinding[] = [];

  if (built.components > target.max) {
    findings.push({
      level: 'fail',
      code: 'too-fine',
      message:
        `partition is ${built.components} components; this repo sizes to ${target.target} ` +
        `(band ${target.min}–${target.max}). Too fine to route an edit through.`,
    });
  } else if (built.components < target.min) {
    findings.push({
      level: 'fail',
      code: 'too-coarse',
      message:
        `partition is ${built.components} components; this repo sizes to ${target.target} ` +
        `(band ${target.min}–${target.max}). Too coarse to be the unit a check is about.`,
    });
  }

  // Anchor density is its own failure, not a proxy for size: a partition inside
  // the band can still pile every component onto a handful of files.
  if (built.anchoredFiles <= 0) {
    findings.push({
      level: 'fail',
      code: 'unresolvable-anchors',
      message:
        `${built.components} component(s) anchor no source file at all, so no edit can ever ` +
        'route to a territory.',
    });
  } else if (built.components / built.anchoredFiles > GRANULARITY_MAX_PER_FILE) {
    findings.push({
      level: 'fail',
      code: 'unresolvable-anchors',
      message:
        `${(built.components / built.anchoredFiles).toFixed(1)} components per anchored file ` +
        `(max ${GRANULARITY_MAX_PER_FILE}). One edit gates, credits and re-locks every ` +
        'component sharing a file.',
    });
  }

  const overfull = built.groupSizes.filter((n) => n > CHILDREN_PER_NODE.max);
  if (overfull.length > 0) {
    findings.push({
      level: 'warn',
      code: 'oversized-group',
      message:
        `${overfull.length} group(s) hold more than ${CHILDREN_PER_NODE.max} components ` +
        `(largest ${Math.max(...overfull)}). A group that size is a list, not a grouping.`,
    });
  }

  // The lower half of the same rule. Only meaningful once there is more than one
  // group: a repo whose whole partition fits in a single province is not
  // under-grouped, it simply does not need grouping.
  const undersized = built.groupSizes.filter((n) => n < CHILDREN_PER_NODE.min);
  if (built.groupSizes.length > 1 && undersized.length > 0) {
    findings.push({
      level: 'warn',
      code: 'undersized-group',
      message:
        `${undersized.length} group(s) hold fewer than ${CHILDREN_PER_NODE.min} components ` +
        `(smallest ${Math.min(...undersized)}). Merge them; a grouping that small carries no ` +
        'information the component list does not already.',
    });
  }

  if (target.granularityLimited) {
    findings.push({
      level: 'warn',
      code: 'granularity-limited',
      message:
        `file-level anchors bind: this repo wants ~${target.demand} components but only ` +
        `${target.byFiles} source file(s) exist to anchor them to.`,
    });
  }

  return findings;
}

/** True when nothing in `findings` blocks the build. */
export function partitionPasses(findings: readonly PartitionFinding[]): boolean {
  return !findings.some((f) => f.level === 'fail');
}
