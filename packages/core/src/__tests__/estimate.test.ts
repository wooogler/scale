/**
 * The sizing contract (stage 1). What this pins down is not arithmetic for its
 * own sake: `partitionTarget` is the number a build is approved against and
 * later held to, so its edges — which limit binds, and what it reports when the
 * two disagree — are the behaviour under test.
 */
import { describe, it, expect } from 'vitest';
import {
  partitionTarget,
  estimateBuild,
  PER_LOC,
  LEAF_CLAMP,
  FLAT_MAX_LEAVES,
  CHILDREN_PER_NODE,
  SURVEY_TOLERANCE,
  checkPartition,
  partitionPasses,
} from '../estimate.js';

describe('partitionTarget — which limit binds, and saying so', () => {
  it('uses LOC when files leave room', () => {
    // 15 files is more than enough to resolve 2760/276 = 10 components.
    const p = partitionTarget({ loc: 2760, files: 15 });
    expect(p.byLoc).toBe(10);
    expect(p.byFiles).toBe(15);
    expect(p.target).toBe(10);
    expect(p.granularityLimited).toBe(false);
  });

  it('caps at file count and flags it, rather than silently rounding', () => {
    // The commander.js shape: plenty of code, very few files to anchor it to.
    const p = partitionTarget({ loc: 4180, files: 6 });
    expect(p.byLoc).toBe(15);
    expect(p.byFiles).toBe(6);
    expect(p.target).toBe(6);
    expect(p.granularityLimited).toBe(true);
  });

  it('reproduces the koa target the build ignored', () => {
    // The real measurement: 2,066 LOC over 7 source files. The estimator said
    // this; the skill's hard floor of 20 produced 36.
    const p = partitionTarget({ loc: 2066, files: 7 });
    expect(p.target).toBe(7);
    expect(p.max).toBeLessThan(36);
  });

  it('the survey band is the tolerance, in both directions', () => {
    const p = partitionTarget({ loc: 276 * 40, files: 200 });
    expect(p.target).toBe(40);
    expect(p.max).toBe(Math.round(40 * SURVEY_TOLERANCE));
    expect(p.min).toBe(Math.round(40 / SURVEY_TOLERANCE));
  });

  it('a two-file repo gets two components, not the floor', () => {
    // The floor used to win here, forcing 5 components onto 2 files — a density
    // `checkPartition` then always rejected, so no such repo could ever pass.
    const p = partitionTarget({ loc: 40, files: 2 });
    expect(p.target).toBe(2);
    expect(p.demand).toBe(LEAF_CLAMP.min);
    expect(p.boundBy).toBe('files');
    expect(p.granularityLimited).toBe(true);
    expect(p.min).toBeLessThanOrEqual(p.target);
  });

  it('names which of the three limits bound the target', () => {
    expect(partitionTarget({ loc: 2760, files: 15 }).boundBy).toBe('loc');
    expect(partitionTarget({ loc: 4180, files: 6 }).boundBy).toBe('files');
    expect(partitionTarget({ loc: 100, files: 40 }).boundBy).toBe('floor');
  });

  it('non-finite input reads as zero rather than poisoning every comparison', () => {
    for (const shape of [
      { loc: NaN, files: 5 },
      { loc: 1000, files: NaN },
      { loc: Infinity, files: 5 },
    ]) {
      const p = partitionTarget(shape);
      expect(Number.isFinite(p.target)).toBe(true);
      expect(Number.isFinite(p.min)).toBe(true);
      expect(Number.isFinite(p.max)).toBe(true);
      // A NaN band made every checkPartition comparison false — a pass by
      // incomparability.
      expect(partitionPasses(checkPartition({ components: 9999, anchoredFiles: 1, groupSizes: [9999] }, p)))
        .toBe(false);
    }
  });

  it('is total on degenerate input', () => {
    for (const shape of [
      { loc: 0, files: 0 },
      { loc: -100, files: -3 },
      { loc: 1.9, files: 2.7 },
    ]) {
      const p = partitionTarget(shape);
      expect(p.target).toBeGreaterThanOrEqual(1);
      expect(Number.isInteger(p.target)).toBe(true);
      expect(Number.isInteger(p.depth)).toBe(true);
      expect(p.depth).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('grouping depth — the tree the target implies', () => {
  const depthFor = (target: number): ReturnType<typeof partitionTarget> =>
    partitionTarget({ loc: target * PER_LOC.locPerComponent, files: 1_000_000 });

  it('one province layer while the leaves fit under one node', () => {
    expect(depthFor(7).depth).toBe(1);
    expect(depthFor(7).topGroups).toBe(1);
  });

  it('still one layer at the scale this repo was built at', () => {
    const p = depthFor(37);
    expect(p.depth).toBe(1);
    expect(p.topGroups).toBe(5); // 37 leaves over ≤9-child provinces
    expect(p.needsHierarchy).toBe(false);
  });

  it('adds a level exactly when a flat layer would overflow', () => {
    expect(depthFor(81).depth).toBe(1); // 9 provinces × 9 = the last flat size
    expect(depthFor(82).depth).toBe(2);
  });

  it('scales to a large monorepo without unbounded fan-out', () => {
    const p = depthFor(1087); // ~300k LOC
    expect(p.depth).toBe(3);
    expect(p.topGroups).toBeLessThanOrEqual(CHILDREN_PER_NODE.max);
    expect(p.needsHierarchy).toBe(true);
  });

  it('no node ever exceeds the branching factor, at any size', () => {
    for (const n of [5, 9, 10, 60, 61, 100, 500, 1000, 5000]) {
      const p = depthFor(n);
      expect(p.topGroups).toBeLessThanOrEqual(CHILDREN_PER_NODE.max);
      // Each level divides by at most the branching factor, so the tree spanned
      // by `depth` levels must cover every leaf.
      expect(p.topGroups * Math.pow(CHILDREN_PER_NODE.max, p.depth)).toBeGreaterThanOrEqual(p.target);
    }
  });

  it('flags hierarchy exactly above the flat ceiling', () => {
    expect(depthFor(FLAT_MAX_LEAVES).needsHierarchy).toBe(false);
    expect(depthFor(FLAT_MAX_LEAVES + 1).needsHierarchy).toBe(true);
  });
});

describe('estimateBuild — the count and the cost move together', () => {
  it('carries the partition reasoning, not just a number', () => {
    const e = estimateBuild({ loc: 2066, files: 7 });
    expect(e.components).toBe(e.partition.target);
    expect(e.files).toBe(7);
    expect(e.loc).toBe(2066);
  });

  it('cost scales with LOC and is model-ranged for thinking models', () => {
    const small = estimateBuild({ loc: 2000, files: 50 });
    const big = estimateBuild({ loc: 20000, files: 500 });
    expect(big.models[0]!.costLow).toBeGreaterThan(small.models[0]!.costLow * 5);
    for (const m of big.models) expect(m.costHigh).toBeGreaterThanOrEqual(m.costLow);
  });

  it('two repos of equal LOC differ in target when their file counts differ', () => {
    const spread = estimateBuild({ loc: 8000, files: 60 });
    const lumpy = estimateBuild({ loc: 8000, files: 5 });
    expect(spread.components).toBe(29);
    expect(lumpy.components).toBe(5);
    expect(lumpy.partition.granularityLimited).toBe(true);
    // Same code, same price — only the shape of the map changes.
    expect(lumpy.models[0]!.costLow).toBeCloseTo(spread.models[0]!.costLow, 6);
  });
});

describe('checkPartition — holding a build to its estimate', () => {
  const koa = partitionTarget({ loc: 2066, files: 7 });

  it('fails the koa build the way it was actually built', () => {
    // 36 components over 7 anchored files, 8 provinces of ~4-5.
    const f = checkPartition(
      { components: 36, anchoredFiles: 9, groupSizes: [6, 5, 5, 4, 4, 4, 4, 4] },
      koa,
    );
    const codes = f.filter((x) => x.level === 'fail').map((x) => x.code).sort();
    expect(codes).toEqual(['too-fine', 'unresolvable-anchors']);
    expect(partitionPasses(f)).toBe(false);
  });

  it('passes the partition the estimate asked for', () => {
    // Seven components in one province: within the band, one per file, and a
    // group of seven sits inside the 5-9 rule.
    const f = checkPartition({ components: 7, anchoredFiles: 7, groupSizes: [7] }, koa);
    expect(partitionPasses(f)).toBe(true);
    expect(f).toEqual([]);
  });

  it('fails a partition that is too coarse, not only too fine', () => {
    const f = checkPartition({ components: 2, anchoredFiles: 7, groupSizes: [2] }, koa);
    expect(f.map((x) => x.code)).toContain('too-coarse');
    expect(partitionPasses(f)).toBe(false);
  });

  it('catches unresolvable anchors even when the SIZE is fine', () => {
    // Inside the band, but every component piled onto two files: the size check
    // alone would wave this through.
    const f = checkPartition({ components: 8, anchoredFiles: 2, groupSizes: [4, 4] }, koa);
    expect(f.filter((x) => x.level === 'fail').map((x) => x.code)).toEqual(['unresolvable-anchors']);
  });

  it('a legitimately shared file does not trip the density check', () => {
    // 7 components, 6 files: one helper genuinely shared. 1.17 < 1.5.
    const f = checkPartition({ components: 7, anchoredFiles: 6, groupSizes: [4, 3] }, koa);
    expect(partitionPasses(f)).toBe(true);
  });

  it('an oversized group warns without blocking the build', () => {
    const f = checkPartition({ components: 7, anchoredFiles: 7, groupSizes: [7] }, koa);
    expect(partitionPasses(f)).toBe(true);
    const g = checkPartition({ components: 12, anchoredFiles: 12, groupSizes: [12] },
      partitionTarget({ loc: 276 * 12, files: 40 }));
    expect(g.map((x) => x.code)).toContain('oversized-group');
    expect(partitionPasses(g)).toBe(true); // shape advice, not a broken index
  });

  it('a granularity-limited repo is warned, not failed, when it builds to the cap', () => {
    const commander = partitionTarget({ loc: 4180, files: 6 });
    const f = checkPartition({ components: 6, anchoredFiles: 6, groupSizes: [6] }, commander);
    expect(partitionPasses(f)).toBe(true);
    expect(f.map((x) => x.code)).toEqual(['granularity-limited']);
  });

  it('reports no anchored files as unresolvable rather than dividing by zero', () => {
    const f = checkPartition({ components: 5, anchoredFiles: 0, groupSizes: [5] }, koa);
    expect(f.map((x) => x.code)).toContain('unresolvable-anchors');
    expect(partitionPasses(f)).toBe(false);
  });
});

describe('the band never authorizes a map that cannot be drawn', () => {
  it('clamps the upper bound to the flat ceiling', () => {
    // 70 leaves: 1.5x would be 105, past the 81 one flat province layer holds.
    const p = partitionTarget({ loc: 276 * 70, files: 1000 });
    expect(p.target).toBe(70);
    expect(p.needsHierarchy).toBe(false);
    expect(p.max).toBe(FLAT_MAX_LEAVES);
    expect(FLAT_MAX_LEAVES).toBe(CHILDREN_PER_NODE.max ** 2);
  });

  it('leaves the band alone once the repo is already past that ceiling', () => {
    const p = partitionTarget({ loc: 276 * 200, files: 5000 });
    expect(p.needsHierarchy).toBe(true);
    expect(p.max).toBe(300);
  });

  it('needsHierarchy is exactly "more than one grouping level"', () => {
    for (const n of [5, 40, 81, 82, 200, 1000]) {
      const p = partitionTarget({ loc: 276 * n, files: 100000 });
      expect(p.needsHierarchy).toBe(p.depth > 1);
    }
  });

  it('never inverts the band, at any size', () => {
    for (const n of [5, 7, 40, 59, 60, 61, 90, 400, 2000]) {
      const p = partitionTarget({ loc: 276 * n, files: 100000 });
      expect(p.min).toBeLessThanOrEqual(p.target);
      expect(p.max).toBeGreaterThanOrEqual(p.target);
    }
  });

  it('a build at the top of the band still fits a flat map', () => {
    for (const n of [10, 30, 50, 60, 81]) {
      const p = partitionTarget({ loc: 276 * n, files: 100000 });
      if (!p.needsHierarchy) expect(p.max).toBeLessThanOrEqual(FLAT_MAX_LEAVES);
    }
  });
});

describe('the band never authorizes what the check will reject', () => {
  it('a build at the top of the band passes the anchor-density rule', () => {
    // The koa case: target 7 over 7 files used to give a band top of 11, and
    // 11/7 = 1.57 is over the 1.5 the check enforces — approved and rejected at
    // once.
    for (const shape of [
      { loc: 2066, files: 7 },
      { loc: 4180, files: 6 },
      { loc: 40, files: 2 },
      { loc: 100, files: 3 },
      { loc: 17532, files: 54 },
      { loc: 500000, files: 4000 },
    ]) {
      const p = partitionTarget(shape);
      const atMax = checkPartition(
        { components: p.max, anchoredFiles: p.byFiles, groupSizes: [p.max] },
        p,
      );
      expect(atMax.filter((f) => f.code === 'unresolvable-anchors')).toEqual([]);
      expect(atMax.filter((f) => f.code === 'too-fine')).toEqual([]);
    }
  });

  it('a build at the target itself always passes', () => {
    for (let files = 1; files <= 60; files++) {
      for (const loc of [0, 500, 5000, 50000]) {
        const p = partitionTarget({ loc, files });
        const f = checkPartition(
          { components: p.target, anchoredFiles: files, groupSizes: [p.target] },
          p,
        );
        expect(partitionPasses(f)).toBe(true);
      }
    }
  });
});

describe('group-size findings cover both edges of the 5-9 rule', () => {
  const t7 = partitionTarget({ loc: 2066, files: 7 });
  it('warns on groups that are too small, but not on a single group', () => {
    expect(checkPartition({ components: 7, anchoredFiles: 7, groupSizes: [7] }, t7)
      .map((f) => f.code)).not.toContain('undersized-group');
    expect(checkPartition({ components: 7, anchoredFiles: 7, groupSizes: [4, 3] }, t7)
      .map((f) => f.code)).toContain('undersized-group');
  });
  it('a component anchoring nothing fails rather than reporting an infinite ratio', () => {
    const f = checkPartition({ components: 5, anchoredFiles: 0, groupSizes: [5] }, t7);
    const anchors = f.find((x) => x.code === 'unresolvable-anchors')!;
    expect(anchors.level).toBe('fail');
    expect(anchors.message).not.toContain('Infinity');
  });
});
