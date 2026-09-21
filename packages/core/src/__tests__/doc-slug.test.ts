/**
 * The anchor half of `#/c/<component-id>/<section>`.
 *
 * These slugs are written into links that outlive the docs they point at — a
 * tutor's "read more", a gate denial, a message in someone's chat log — so the
 * cases pinned here are the ones where a small change of heading would silently
 * move an anchor.
 */
import { describe, expect, it } from 'vitest';
import {
  PANEL_SECTION_IDS,
  bodyHeadings,
  headingSlugs,
  isSlug,
  slugify,
} from '../doc-slug.js';
import { SECTIONS } from '../schema/sections.js';

describe('slugify', () => {
  it('kebab-cases the canonical section headings', () => {
    expect(SECTIONS.map((s) => slugify(s.heading))).toEqual([
      'summary',
      'what-it-does',
      'related-components',
      'how-it-works',
      'design-decisions',
      'where-it-sits',
    ]);
  });

  it('drops markdown inline markers instead of turning them into dashes', () => {
    expect(slugify('The `gate` decision')).toBe('the-gate-decision');
    expect(slugify('**Why** it is *this* way')).toBe('why-it-is-this-way');
  });

  it('collapses punctuation and trims the edges', () => {
    expect(slugify('Where it sits — and why')).toBe('where-it-sits-and-why');
    expect(slugify('  Summary (tl;dr)  ')).toBe('summary-tl-dr');
    expect(slugify('#1: how?')).toBe('1-how');
  });

  it('answers empty for a heading with no ASCII to anchor', () => {
    expect(slugify('설계 결정')).toBe('');
    expect(slugify('———')).toBe('');
  });

  it('produces only strings isSlug accepts', () => {
    for (const h of ['Summary', 'The `gate` decision', '#1: how?']) {
      expect(isSlug(slugify(h))).toBe(true);
    }
    expect(isSlug('')).toBe(false);
    expect(isSlug('Design-Decisions')).toBe(false);
    expect(isSlug('a--b')).toBe(false);
  });
});

describe('bodyHeadings', () => {
  it('reads h2 and h3 in document order', () => {
    const body = ['# Title', '## Summary', 'prose', '### A detail', '## How it works'].join('\n');
    expect(bodyHeadings(body)).toEqual(['Summary', 'A detail', 'How it works']);
  });

  it('ignores `## ` inside a fenced block', () => {
    const body = ['## Summary', '```md', '## Not a section', '```', '## How it works'].join('\n');
    expect(bodyHeadings(body)).toEqual(['Summary', 'How it works']);
  });
});

describe('headingSlugs', () => {
  it('gives a canonical doc the slugs the CLI and the skills print', () => {
    const body = SECTIONS.map((s) => `## ${s.heading}\n\nprose\n`).join('\n');
    expect(headingSlugs(body)).toEqual([
      'summary',
      'what-it-does',
      'related-components',
      'how-it-works',
      'design-decisions',
      'where-it-sits',
    ]);
  });

  it('never collides with the reserved panel sections', () => {
    const body = '## Concepts\n\n## Decisions\n';
    expect(headingSlugs(body)).toEqual(['concepts-2', 'decisions-2']);
    for (const id of PANEL_SECTION_IDS) expect(headingSlugs(body)).not.toContain(id);
  });

  it('disambiguates repeated headings rather than emitting a duplicate id', () => {
    expect(headingSlugs('## Notes\n## Notes\n## Notes\n')).toEqual([
      'notes',
      'notes-2',
      'notes-3',
    ]);
  });

  it('falls back to a positional anchor when a heading has no ASCII', () => {
    expect(headingSlugs('## Summary\n## 설계 결정\n')).toEqual(['summary', 'section-2']);
  });

  it('stays positional across a translated body of the same shape', () => {
    const en = '## Summary\n\nprose\n\n## How it works\n\nprose\n';
    const ko = '## 요약\n\n산문\n\n## 동작 방식\n\n산문\n';
    // The viewer maps English slugs onto the translated headings BY POSITION;
    // this is the property that makes that safe.
    expect(bodyHeadings(ko)).toHaveLength(bodyHeadings(en).length);
  });
});
