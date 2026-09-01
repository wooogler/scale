import { describe, it, expect } from 'vitest';
import {
  emaUpdate,
  computeLoyalty,
  meanDims,
  unificationProgress,
  classifyState,
  buildFileComponentIndex,
  componentsForFile,
  type ComponentCoverage,
  type MapNode,
  type UserCoverage,
} from '../index.js';

describe('emaUpdate', () => {
  it('applies dim ← 0.5*prev + 0.5*score by default (α=0.5)', () => {
    expect(emaUpdate(0, 1)).toBeCloseTo(0.5);
    expect(emaUpdate(0.5, 1)).toBeCloseTo(0.75);
  });
  it('respects a custom alpha', () => {
    expect(emaUpdate(0, 1, 0.3)).toBeCloseTo(0.3);
    expect(emaUpdate(0.5, 1, 0.3)).toBeCloseTo(0.65);
  });
});

describe('computeLoyalty', () => {
  it('is 1 with no churn', () => {
    expect(computeLoyalty(0, 100)).toBe(1);
  });
  it('clamps to 0 when churn exceeds size', () => {
    expect(computeLoyalty(200, 100)).toBe(0);
  });
  it('is linear in between', () => {
    expect(computeLoyalty(25, 100)).toBeCloseTo(0.75);
  });
  it('is 0 for a zero-size component', () => {
    expect(computeLoyalty(0, 0)).toBe(0);
  });
});

describe('meanDims', () => {
  it('averages the three dims evenly by default', () => {
    expect(meanDims({ structure: 0.6, concepts: 0.6, rationale: 0.6 })).toBeCloseTo(0.6);
    expect(meanDims({ structure: 0.9, concepts: 0.6, rationale: 0.3 })).toBeCloseTo(0.6);
  });
});

describe('unificationProgress', () => {
  const nodes: MapNode[] = [
    { id: 'a', province: 'p', x: 0, y: 0, importance: 0.8 },
    { id: 'b', province: 'p', x: 0, y: 0, importance: 0.2 },
  ];
  it('is importance-weighted mean of mean-dims', () => {
    const coverage: UserCoverage = {
      user: 'u',
      updatedAt: 'now',
      components: {
        a: { state: 'validated', dims: { structure: 1, concepts: 1, rationale: 1 }, lastValidatedSha: 's', loyalty: 1 },
        b: { state: 'fog', dims: { structure: 0, concepts: 0, rationale: 0 }, lastValidatedSha: null, loyalty: 1 },
      },
    };
    // (0.8*1 + 0.2*0) / (0.8+0.2) = 0.8
    expect(unificationProgress(nodes, coverage)).toBeCloseTo(0.8);
  });
  it('treats missing coverage as zero', () => {
    const coverage: UserCoverage = { user: 'u', updatedAt: 'now', components: {} };
    expect(unificationProgress(nodes, coverage)).toBe(0);
  });
  it('is 0 when total importance is 0', () => {
    const zero: MapNode[] = [{ id: 'a', province: 'p', x: 0, y: 0, importance: 0 }];
    const coverage: UserCoverage = { user: 'u', updatedAt: 'now', components: {} };
    expect(unificationProgress(zero, coverage)).toBe(0);
  });
});

describe('classifyState', () => {
  const base: ComponentCoverage = {
    state: 'fog',
    dims: { structure: 0, concepts: 0, rationale: 0 },
    lastValidatedSha: null,
    loyalty: 1,
  };

  it('stays fog with no signal', () => {
    expect(classifyState(base, {})).toBe('fog');
  });
  it('goes explored on a passive signal', () => {
    expect(classifyState(base, { hadPassiveSignal: true })).toBe('explored');
  });
  it('validates when weighted dims >= bar with >= 2 active validations', () => {
    const c: ComponentCoverage = { ...base, dims: { structure: 0.7, concepts: 0.7, rationale: 0.7 } };
    expect(classifyState(c, { activeValidations: 2 })).toBe('validated');
  });
  it('does not validate with only 1 active validation', () => {
    const c: ComponentCoverage = { ...base, dims: { structure: 0.7, concepts: 0.7, rationale: 0.7 } };
    expect(classifyState(c, { activeValidations: 1 })).toBe('explored');
  });
  it('does NOT decide stale — rebellion belongs to recomputeDrift alone', () => {
    // classifyState used to flip a low-loyalty component to `stale` too, which
    // meant two rules for one state. Rebellion needs authorship-split churn that
    // only drift is given, and this branch never actually fired (loyalty is
    // always 1 inside the fold, and drift runs after), so it was dead code
    // masquerading as policy. Pinned so it does not grow back.
    const c: ComponentCoverage = {
      ...base,
      state: 'validated',
      dims: { structure: 0.7, concepts: 0.7, rationale: 0.7 },
      lastValidatedSha: 'abc',
      loyalty: 0,
    };
    expect(classifyState(c, { activeValidations: 2 })).toBe('validated');
  });

  it('a stale component with fresh passive contact reads as explored', () => {
    const c: ComponentCoverage = {
      ...base,
      state: 'stale',
      dims: { structure: 0.7, concepts: 0.7, rationale: 0.7 },
      lastValidatedSha: 'abc',
      loyalty: 0.1,
    };
    expect(classifyState(c, { activeValidations: 1 })).toBe('explored');
  });
});

describe('file→component index', () => {
  const papers = [
    { id: 'session-management', sources: ['src/server/auth/sessions.ts', 'src/server/middleware/session.ts'] },
    { id: 'document-sharing', sources: ['src/server/sharing/links.ts'] },
  ];
  const index = buildFileComponentIndex(papers);

  it('builds a reverse index', () => {
    expect(index['src/server/auth/sessions.ts']).toEqual(['session-management']);
  });
  it('resolves an exact match', () => {
    expect(componentsForFile(index, 'src/server/sharing/links.ts')).toEqual(['document-sharing']);
  });
  it('normalizes ./ and backslashes', () => {
    expect(componentsForFile(index, './src/server/auth/sessions.ts')).toEqual(['session-management']);
  });
  it('falls back to nearest directory for an unindexed new file', () => {
    const got = componentsForFile(index, 'src/server/auth/tokens.ts');
    expect(got).toEqual(['session-management']);
  });
  it('returns [] when nothing shares a top-level directory', () => {
    expect(componentsForFile(index, 'docs/readme.md')).toEqual([]);
  });
});
