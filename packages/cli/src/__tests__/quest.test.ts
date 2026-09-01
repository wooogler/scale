import { describe, it, expect } from 'vitest';

import {
  QuestItemSchema,
  ScaleConfigSchema,
  emptyComponentCoverage,
  type LoadedScale,
  type LoadedPaper,
  type MapJson,
  type UserCoverage,
} from '@scale/core';

import { pickComponents, deterministicQuizItems, deterministicSocraticItems } from '../quest.js';

function paper(id: string, title: string): LoadedPaper {
  return {
    id,
    path: `/tmp/.scale/prov/${id}`,
    province: 'prov',
    parentId: null,
    body: '',
    frontmatter: {
      id,
      title,
      sources: [`src/${id}.ts`],
      concepts: [
        { id: `${id}-c1`, name: `${title} core concept` },
        { id: `${id}-c2`, name: `${title} secondary idea` },
      ],
      rationale: [
        {
          decision: `${title} is designed a certain way`,
          why: `because ${title} needs it`,
          provenance: 'inferred',
        },
      ],
    },
  };
}

const loaded: LoadedScale = {
  papers: [paper('alpha', 'Alpha'), paper('beta', 'Beta'), paper('gamma', 'Gamma')],
  provinces: [{ id: 'prov', name: 'Prov' }],
  edges: [],
};

function mapOf(ids: { id: string; importance: number }[]): MapJson {
  return {
    version: 1,
    builtFromSha: 'abc',
    provinces: [{ id: 'prov', name: 'Prov' }],
    nodes: ids.map((n) => ({ id: n.id, province: 'prov', x: 0.5, y: 0.5, importance: n.importance })),
    edges: [],
  };
}

function coverageOf(overrides: Record<string, Partial<ReturnType<typeof emptyComponentCoverage>>>): UserCoverage {
  const components: UserCoverage['components'] = {};
  for (const id of ['alpha', 'beta', 'gamma']) {
    components[id] = { ...emptyComponentCoverage(), ...(overrides[id] ?? {}) };
  }
  return { user: 'u', updatedAt: '', components };
}

const config = ScaleConfigSchema.parse({ user: 'u', condition: { timing: 'postsession', modality: 'quiz' } });

describe('pickComponents', () => {
  it('prefers touched × low-coverage, ranked by importance', () => {
    const map = mapOf([
      { id: 'alpha', importance: 0.9 },
      { id: 'beta', importance: 0.2 },
      { id: 'gamma', importance: 0.5 },
    ]);
    // all fog (low coverage); alpha + beta touched this session
    const cov = coverageOf({});
    const touched = new Set(['alpha', 'beta']);
    const picked = pickComponents(cov, map, touched, config, 3);
    // gamma not touched → excluded; alpha (0.9) ranks above beta (0.2)
    expect(picked).toEqual(['alpha', 'beta']);
  });

  it('falls back to the K lowest-coverage components when nothing was touched', () => {
    const map = mapOf([
      { id: 'alpha', importance: 0.5 },
      { id: 'beta', importance: 0.5 },
      { id: 'gamma', importance: 0.5 },
    ]);
    const cov = coverageOf({
      alpha: { state: 'validated', dims: { structure: 0.9, concepts: 0.9, rationale: 0.9 } },
      beta: { state: 'explored', dims: { structure: 0.2, concepts: 0.1, rationale: 0.0 } },
      gamma: { state: 'explored', dims: { structure: 0.4, concepts: 0.4, rationale: 0.4 } },
    });
    const picked = pickComponents(cov, map, new Set(), config, 2);
    // lowest mean-dims first: beta (0.1) then gamma (0.4); alpha excluded
    expect(picked).toEqual(['beta', 'gamma']);
  });
});

describe('deterministic quiz items (offline fallback)', () => {
  it('produces exactly 2 valid 4-option MCQ items with a correct answer', () => {
    const items = deterministicQuizItems(loaded.papers[0]!, loaded);
    expect(items).toHaveLength(2);
    for (const item of items) {
      const parsed = QuestItemSchema.parse(item); // schema-valid
      expect(parsed.options).toHaveLength(4);
      const idx = (item as Record<string, unknown>).correctIndex as number;
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(4);
      // the recorded answer matches the correct option slot
      expect(parsed.options![idx]).toBe(item.answer);
      expect(['structure', 'concepts', 'rationale']).toContain(parsed.dim);
    }
  });
});

describe('deterministic socratic items (offline fallback)', () => {
  it('produces a single grounded seed question', () => {
    const items = deterministicSocraticItems(loaded.papers[0]!);
    expect(items).toHaveLength(1);
    const parsed = QuestItemSchema.parse(items[0]);
    expect(parsed.prompt).toContain('Alpha');
    expect(parsed.prompt.length).toBeGreaterThan(10);
  });
});

describe('pickComponents — pending unlocks come first', () => {
  const cfg = ScaleConfigSchema.parse({ user: 'u' });
  const map: MapJson = {
    version: 1,
    builtFromSha: 'x',
    provinces: [{ id: 'p', name: 'P' }],
    nodes: ['a', 'b', 'c', 'd'].map((id, i) => ({ id, province: 'p', x: 0, y: 0, importance: 1 - i * 0.1 })),
    edges: [],
  };
  const coverage: UserCoverage = { user: 'u', updatedAt: '', components: {} };

  it('puts the denied territory ahead of anything touched or ranked', () => {
    // A denied edit writes no `touch`, so `c` would otherwise be invisible here
    // while `a` and `b` (touched, fog) took the slots.
    const picked = pickComponents(coverage, map, new Set(['a', 'b']), cfg, 3, ['c']);
    expect(picked[0]).toBe('c');
    expect(picked).toHaveLength(3);
    expect(new Set(picked).size).toBe(3); // no duplicates
  });

  it('caps at k and ignores ids the map does not know', () => {
    const picked = pickComponents(coverage, map, new Set(), cfg, 2, ['ghost', 'd', 'c', 'b']);
    expect(picked).toEqual(['d', 'c']);
  });

  it('with nothing pending, ranking is unchanged', () => {
    expect(pickComponents(coverage, map, new Set(['a']), cfg, 1)).toEqual(['a']);
  });
});
