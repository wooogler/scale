/**
 * Paper grounding (PLAN §6.2).
 *
 * Two regressions are pinned here. `paper.body` was loaded and thrown away, so
 * the generator was asked to tag items `structure` with no structural material
 * in the prompt at all; and the web Socratic path dropped `alternatives`, which
 * the rationale rubric's top band explicitly asks the junior to explain.
 */
import { describe, it, expect } from 'vitest';
import { paperGrounding, DEFAULT_MAX_BODY_CHARS } from '../grounding.js';
import type { LoadedPaper } from '../paper-loader.js';

const paper = (body: string): LoadedPaper =>
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
    expect(paperGrounding(paper('## Description\nprose'))).toContain('JWT-in-cookie');
  });

  it('carries the prose body, so a structure item has material to come from', () => {
    const out = paperGrounding(paper('## Description\nThe gate decides then writes.'));
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
    const out = paperGrounding(paper(body));
    expect(out).not.toContain('../other/');
    expect(out).toContain('real prose');
  });

  it('caps an unusually long paper instead of dominating the request', () => {
    const out = paperGrounding(paper('## Description\n' + 'x'.repeat(DEFAULT_MAX_BODY_CHARS * 2)));
    expect(out).toContain('[paper truncated]');
    expect(out.length).toBeLessThan(DEFAULT_MAX_BODY_CHARS + 2_000);
  });

  it('can still render frontmatter only', () => {
    const out = paperGrounding(paper('## Description\nprose here'), { includeBody: false });
    expect(out).not.toContain('prose here');
    expect(out).toContain('JWT-in-cookie');
  });
});
