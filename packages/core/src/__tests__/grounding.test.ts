/**
 * Paper grounding (PLAN §6.2).
 *
 * Two regressions are pinned here. `paper.body` was loaded and thrown away, so
 * the generator was asked to tag items `structure` with no structural material
 * in the prompt at all; and the web Socratic path dropped `alternatives`, which
 * the rationale rubric's top band explicitly asks the junior to explain.
 */
import { describe, it, expect } from 'vitest';
import { paperGrounding, neighbourIndex, DEFAULT_MAX_BODY_CHARS } from '../grounding.js';
import type { LoadedPaper } from '../paper-loader.js';

const paperFixture = (body: string): LoadedPaper =>
  ({
    id: 'demo',
    path: '/tmp/demo',
    province: 'p',
    parentId: null,
    body,
    frontmatter: {
      id: 'demo',
      title: 'Demo',
      sources: ['src/demo.ts'],
      concepts: [{ id: 'c1', name: 'The store is server-side' }],
      rationale: [
        {
          decision: 'Sessions are server-side',
          why: 'Revocation must be immediate',
          alternatives: 'JWT-in-cookie (rejected — revocation complexity)',
          provenance: 'inferred',
        },
      ],
    },
  }) as unknown as LoadedPaper;

describe('paperGrounding', () => {
  it('carries the rejected alternatives the rationale rubric grades on', () => {
    expect(paperGrounding(paperFixture('## Description\nprose'))).toContain('JWT-in-cookie');
  });

  it('carries the prose body, so a structure item has material to come from', () => {
    const out = paperGrounding(paperFixture('## Description\nThe gate decides then writes.'));
    expect(out).toContain('The gate decides then writes.');
  });

  it('drops Related Work — a neighbour list is lookup-item material', () => {
    const body = [
      '## Abstract',
      'a',
      '## Related Work',
      '- [Other](../other/)',
      '## Description',
      'real prose',
    ].join('\n');
    const out = paperGrounding(paperFixture(body));
    expect(out).not.toContain('../other/');
    expect(out).toContain('real prose');
  });

  it('caps an unusually long paper instead of dominating the request', () => {
    const out = paperGrounding(paperFixture('## Description\n' + 'x'.repeat(DEFAULT_MAX_BODY_CHARS * 2)));
    expect(out).toContain('[paper truncated]');
    expect(out.length).toBeLessThan(DEFAULT_MAX_BODY_CHARS + 2_000);
  });

  it('can still render frontmatter only', () => {
    const out = paperGrounding(paperFixture('## Description\nprose here'), { includeBody: false });
    expect(out).not.toContain('prose here');
    expect(out).toContain('JWT-in-cookie');
  });
});

describe('neighbourIndex', () => {
  const map = (edges: { from: string; to: string; kind: string }[]) =>
    ({ nodes: [], provinces: [], edges }) as never;

  it('indexes depends_on in both directions', () => {
    const idx = neighbourIndex(map([{ from: 'a', to: 'b', kind: 'depends_on' }]));
    expect(idx.get('a')).toEqual({ dependsOn: ['b'], dependedOnBy: [] });
    expect(idx.get('b')).toEqual({ dependsOn: [], dependedOnBy: ['a'] });
  });

  it('ignores reference edges — the LLM link graph is ~24% dense and no signal', () => {
    expect(neighbourIndex(map([{ from: 'a', to: 'b', kind: 'reference' }])).size).toBe(0);
  });

  it('is empty for a map with no depends_on, so callers behave as before', () => {
    expect(neighbourIndex(map([{ from: 'a', to: 'b', kind: 'hierarchy' }])).size).toBe(0);
  });

  it('drops self-edges and de-duplicates, and sorts for stable prompts', () => {
    const idx = neighbourIndex(
      map([
        { from: 'a', to: 'a', kind: 'depends_on' },
        { from: 'a', to: 'z', kind: 'depends_on' },
        { from: 'a', to: 'b', kind: 'depends_on' },
        { from: 'a', to: 'b', kind: 'depends_on' },
      ]),
    );
    expect(idx.get('a')?.dependsOn).toEqual(['b', 'z']);
  });
});

describe('paperGrounding with neighbours', () => {
  const p = paperFixture('## Description\nprose');

  it('renders both directions and forbids using them as a lookup', () => {
    const out = paperGrounding(p, {
      neighbours: { dependsOn: ['coverage-model'], dependedOnBy: ['gate-enforcement'] },
    });
    expect(out).toContain('reaches into: coverage-model');
    expect(out).toContain('reaches into it: gate-enforcement');
    expect(out).toContain('never to ask which name is connected to which');
  });

  it('adds nothing when the component has no measured neighbours', () => {
    const out = paperGrounding(p, { neighbours: { dependsOn: [], dependedOnBy: [] } });
    expect(out).not.toContain('Measured dependencies');
    expect(out).toEqual(paperGrounding(p));
  });
});
