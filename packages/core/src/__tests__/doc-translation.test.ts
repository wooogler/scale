/**
 * The committed-rendering file format (`README.<lang>.md`) and the one property
 * that makes committing it safe: no doc scanner mistakes it for a component.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  committedTranslationState,
  isTranslationFileName,
  parseCommittedTranslation,
  renderCommittedTranslation,
  translationFileName,
  loadScaleDir,
  componentSourcesIndex,
  type CommittedTranslation,
  type DocFrontmatter,
} from '../index.js';

const SHA = 'a'.repeat(64);

const english: DocFrontmatter = {
  id: 'alpha',
  title: 'Alpha',
  sources: ['src/alpha.ts', 'src/alpha-util.ts'],
  concepts: [
    { id: 'first', name: 'The first idea' },
    { id: 'second', name: 'The second: with a colon' },
  ],
  rationale: [
    { decision: 'Do it', why: 'Because', alternatives: 'Not doing it', provenance: 'inferred' },
    { decision: 'Bare', provenance: 'prompt:abc' },
  ],
};

function rendering(body: string): CommittedTranslation {
  return {
    meta: {
      lang: 'ko',
      sourceLang: 'en',
      sourceSha: SHA,
      model: 'claude-sonnet-4-5',
      translatedAt: '2026-10-11T00:00:00.000Z',
    },
    frontmatter: {
      ...english,
      title: '알파: 첫 문서',
      concepts: [
        { id: 'first', name: '첫 번째 아이디어' },
        { id: 'second', name: '두 번째: 콜론 포함' },
      ],
      rationale: [
        { decision: '이렇게 한다', why: '왜냐하면', alternatives: '안 하기', provenance: 'inferred' },
        { decision: '단순', provenance: 'prompt:abc' },
      ],
    },
    body,
  };
}

describe('README.<lang>.md — render/parse', () => {
  it('round-trips exactly, including YAML-hostile Korean values', () => {
    const t = rendering('\n# 알파\n\n```ts\nconst x: 1 = 1; // ## not a heading\n```\n');
    const text = renderCommittedTranslation(t);
    expect(parseCommittedTranslation(text)).toEqual(t);
  });

  it('reads as a normal doc: frontmatter first, the doc keys in the English order', () => {
    const text = renderCommittedTranslation(rendering('\n본문.\n'));
    expect(text.startsWith('---\nid: alpha\ntitle:')).toBe(true);
    const keys = [...text.split('\n---\n')[0]!.matchAll(/^([a-z_]+):/gm)].map((m) => m[1]);
    expect(keys).toEqual([
      'id',
      'title',
      'sources',
      'concepts',
      'rationale',
      'lang',
      'source_lang',
      'source_sha',
      'model',
      'translated_at',
    ]);
    expect(text).toContain('  - src/alpha.ts');
    expect(text).toContain(`source_sha: ${SHA}`);
  });

  it('adds the blank line after the frontmatter when the body lacks one', () => {
    const text = renderCommittedTranslation(rendering('본문.'));
    expect(text).toContain('---\n\n본문.');
    expect(parseCommittedTranslation(text)!.body).toBe('\n본문.');
  });

  it('a file that is not a rendering parses to null, never a throw', () => {
    expect(parseCommittedTranslation('# no frontmatter')).toBeNull();
    expect(parseCommittedTranslation('---\nid: alpha\ntitle: x\n---\nbody')).toBeNull();
    expect(parseCommittedTranslation('---\n: : :\n---\n')).toBeNull();
    const bad = renderCommittedTranslation(rendering('x')).replace(SHA, 'not-a-sha');
    expect(parseCommittedTranslation(bad)).toBeNull();
  });

  it('names', () => {
    expect(translationFileName('ko')).toBe('README.ko.md');
    expect(isTranslationFileName('README.ko.md')).toBe(true);
    expect(isTranslationFileName('readme.KO.md')).toBe(true);
    expect(isTranslationFileName('README.md')).toBe(false);
    expect(isTranslationFileName('README.ko.md.tmp')).toBe(false);
  });
});

describe('committedTranslationState', () => {
  const parsed = parseCommittedTranslation(renderCommittedTranslation(rendering('x')));

  it('current only for the same language and the same English sha', () => {
    expect(committedTranslationState(parsed, english, 'ko', SHA)).toBe('current');
    expect(committedTranslationState(parsed, english, 'ko', 'b'.repeat(64))).toBe('stale');
    expect(committedTranslationState(parsed, english, 'ja', SHA)).toBe('stale');
    expect(committedTranslationState(null, english, 'ko', SHA)).toBe('stale');
  });

  it('a hand-edit that breaks the machine fields is stale even with a matching sha', () => {
    const renamed = { ...english, concepts: [english.concepts[1]!, english.concepts[0]!] };
    expect(committedTranslationState(parsed, renamed, 'ko', SHA)).toBe('stale');
    const fewer = { ...english, rationale: english.rationale.slice(0, 1) };
    expect(committedTranslationState(parsed, fewer, 'ko', SHA)).toBe('stale');
  });
});

describe('the doc scanner ignores README.<lang>.md', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const sample = join(here, '..', '..', 'fixtures', 'scale-sample');
  let tmp: string | undefined;
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  it('a tree with renderings beside every doc yields the same components, sources and edges', () => {
    tmp = mkdtempSync(join(tmpdir(), 'scale-rendered-'));
    cpSync(join(sample, '.scale'), join(tmp, '.scale'), { recursive: true });
    const before = loadScaleDir(tmp);

    // A rendering beside every component doc — and one in a folder with NO
    // English doc, which must not conjure a component either. Each carries the
    // same id as its English doc, so a scanner that read it would double-count.
    for (const d of before.docs) {
      writeFileSync(
        join(d.path, 'README.ko.md'),
        renderCommittedTranslation({
          ...rendering('\n## 관련 컴포넌트\n\n- [x](../elsewhere/)\n'),
          frontmatter: { ...d.frontmatter, title: `${d.frontmatter.title} (ko)` },
        }),
      );
    }
    const orphan = join(tmp, '.scale', 'auth', 'orphan');
    mkdirSync(orphan, { recursive: true });
    writeFileSync(
      join(orphan, 'README.ko.md'),
      renderCommittedTranslation({
        ...rendering('x'),
        frontmatter: { ...english, id: 'orphan', sources: ['src/orphan.ts'] },
      }),
    );

    const after = loadScaleDir(tmp);
    expect(after.docs.map((d) => d.id).sort()).toEqual(before.docs.map((d) => d.id).sort());
    expect(after.docs.map((d) => d.frontmatter.title).sort()).toEqual(
      before.docs.map((d) => d.frontmatter.title).sort(),
    );
    expect(componentSourcesIndex(after)).toEqual(componentSourcesIndex(before));
    expect(after.edges).toEqual(before.edges);
    expect(after.provinces).toEqual(before.provinces);
  });
});
