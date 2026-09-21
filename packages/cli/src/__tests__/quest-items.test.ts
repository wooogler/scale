/**
 * Item-construction invariants (PLAN §6.2).
 *
 * These guard the two ways a quiz can record a score the learner never earned:
 * an answer key that does not point at the correct option, and a distractor set
 * so uniform that the answer is findable as the odd one out. Both used to hold —
 * 36 of 37 components received byte-identical distractors, and a malformed
 * `correctIndex` silently made option A the key — and both are invisible in the
 * data afterwards, so they have to be caught here.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadScaleDir,
  QuizConfigSchema,
  type LoadedDoc,
  type LoadedScale,
  type QuestItem,
  type QuizConfig,
  type QuizFocus,
} from '@scale/core';
import { deterministicQuizItems } from '../quest.js';

/** A quiz shape with only the named leaves changed from the schema defaults. */
function quiz(over: Partial<QuizConfig> = {}): QuizConfig {
  return QuizConfigSchema.parse(over);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

function loadRepo(): LoadedScale | null {
  const loaded = loadScaleDir(REPO_ROOT);
  return loaded.docs.length > 0 ? loaded : null;
}

describe('deterministicQuizItems', () => {
  const loaded = loadRepo();
  // The repo's own .scale/ is the only realistic multi-doc corpus available;
  // skip rather than fail if it is ever removed.
  const maybe = loaded ? it : it.skip;

  maybe('never offers the correct answer twice, and keys it correctly', () => {
    for (const doc of loaded!.docs) {
      for (const item of deterministicQuizItems(doc, loaded!, 'en')) {
        const options = item.options;
        const correctIndex = item.correctIndex;
        expect(options, `${doc.id}: quiz item has no options`).toBeDefined();
        expect(correctIndex, `${doc.id}: quiz item has no correctIndex`).toBeTypeOf('number');
        if (!options || typeof correctIndex !== 'number') continue;

        expect(options, `${doc.id}: expected 4 options`).toHaveLength(4);
        expect(
          new Set(options).size,
          `${doc.id}: duplicate option in ${JSON.stringify(options)}`,
        ).toBe(4);
        expect(
          options[correctIndex],
          `${doc.id}: correctIndex does not point at answer`,
        ).toBe(item.answer);
      }
    }
  });

  maybe('varies distractors across components', () => {
    const sets = new Set<string>();
    let items = 0;
    for (const doc of loaded!.docs) {
      for (const item of deterministicQuizItems(doc, loaded!, 'en')) {
        if (!item.options) continue;
        items += 1;
        sets.add(
          item.options
            .filter((o) => o !== item.answer)
            .slice()
            .sort()
            .join('\u0000'),
        );
      }
    }
    // The regression this pins: two distinct sets across 74 items. Requiring a
    // majority to be distinct is loose enough to survive docs being edited.
    expect(items).toBeGreaterThan(10);
    expect(sets.size).toBeGreaterThan(items / 2);
  });

  maybe('is deterministic — same corpus, same items', () => {
    const render = (l: LoadedScale) =>
      l.docs
        .flatMap((p) => deterministicQuizItems(p, l, 'en'))
        .map((i) => (i.options ?? []).join('|'));
    expect(render(loaded!)).toEqual(render(loadScaleDir(REPO_ROOT)));
  });
});

// ---------------------------------------------------------------------------
// Quiz SHAPE — quiz.items / quiz.focus (schema/config.ts QuizConfigSchema).
//
// Synthetic docs rather than the repo's own `.scale/`: the point here is what
// happens at the EDGES — a doc with one concept and no rationale asked for five
// items, a `focus` the doc has no material for — and the repo's real docs are
// uniformly rich enough to never reach them.
// ---------------------------------------------------------------------------

function doc(
  id: string,
  over: Partial<LoadedDoc['frontmatter']> = {},
): LoadedDoc {
  return {
    id,
    path: `/tmp/.scale/p/${id}`,
    dir: `p/${id}`,
    province: 'p',
    parentId: null,
    body: '',
    frontmatter: {
      id,
      title: id,
      sources: [`src/${id}.ts`],
      concepts: [],
      rationale: [],
      ...over,
    },
  };
}

/** One concept, one source, no rationale — the thinnest doc a build emits. */
const THIN = doc('thin', {
  concepts: [{ id: 'c1', name: 'the only idea it names' }],
});

/** Several of everything — the shape a real Mode B build produces. */
const RICH = doc('rich', {
  sources: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
  concepts: [
    { id: 'c1', name: 'first idea' },
    { id: 'c2', name: 'second idea' },
    { id: 'c3', name: 'third idea' },
    { id: 'c4', name: 'fourth idea' },
    { id: 'c5', name: 'fifth idea' },
    { id: 'c6', name: 'sixth idea' },
  ],
  rationale: [
    { decision: 'd1', why: 'because of the first reason', provenance: 'inferred' },
    { decision: 'd2', why: 'because of the second reason', provenance: 'inferred' },
    { decision: 'd3', why: 'because of the third reason', provenance: 'inferred' },
    { decision: 'd4', why: 'because of the fourth reason', provenance: 'inferred' },
    { decision: 'd5', why: 'because of the fifth reason', provenance: 'inferred' },
    { decision: 'd6', why: 'because of the sixth reason', provenance: 'inferred' },
  ],
});

/** Corpus the distractor pools are drawn from (`loaded.docs` minus the target). */
const CORPUS: LoadedScale = {
  docs: [
    THIN,
    RICH,
    doc('other-a', {
      concepts: [{ id: 'oa', name: 'a neighbouring idea' }],
      rationale: [{ decision: 'od', why: 'a neighbouring reason', provenance: 'inferred' }],
    }),
    doc('other-b', {
      concepts: [{ id: 'ob', name: 'another neighbouring idea' }],
      rationale: [{ decision: 'ob', why: 'another neighbouring reason', provenance: 'inferred' }],
    }),
  ],
  provinces: [],
  edges: [],
};

/** Four distinct options and a `correctIndex` that really points at `answer`. */
function expectWellFormedMcq(item: QuestItem): void {
  const options = item.options;
  const correctIndex = item.correctIndex;
  expect(options).toHaveLength(4);
  expect(correctIndex).toBeTypeOf('number');
  if (!options || typeof correctIndex !== 'number') return;
  expect(new Set(options).size).toBe(4);
  expect(options[correctIndex]).toBe(item.answer);
}

describe('deterministicQuizItems — quiz.items', () => {
  for (const n of [1, 2, 3, 4, 5]) {
    it(`yields exactly ${n} item(s) from a RICH doc`, () => {
      const items = deterministicQuizItems(RICH, CORPUS, 'en', undefined, quiz({ items: n }));
      expect(items).toHaveLength(n);
      // Every one of them is still a well-formed, correctly-keyed MCQ.
      for (const q of items) expectWellFormedMcq(q);
    });

    it(`yields exactly ${n} item(s) from a THIN doc (one concept, no rationale)`, () => {
      const items = deterministicQuizItems(THIN, CORPUS, 'en', undefined, quiz({ items: n }));
      expect(items).toHaveLength(n);
      for (const q of items) expectWellFormedMcq(q);
    });
  }

  it('the default shape is byte-identical to the pre-setting 2-item check', () => {
    const before = deterministicQuizItems(RICH, CORPUS, 'en');
    const after = deterministicQuizItems(RICH, CORPUS, 'en', undefined, quiz());
    expect(after).toEqual(before);
    expect(before).toHaveLength(2);
    expect(before.map((i) => i.dim)).toEqual(['concepts', 'rationale']);
  });

  it('a doc with NOTHING but sources still yields at least one item', () => {
    const bare = doc('bare', { sources: ['src/bare.ts'] });
    const items = deterministicQuizItems(bare, CORPUS, 'en', undefined, quiz({ items: 5 }));
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items[0]!.dim).toBe('structure');
  });

  it('stays deterministic at every item count', () => {
    for (const n of [1, 3, 5]) {
      const render = () =>
        deterministicQuizItems(RICH, CORPUS, 'en', undefined, quiz({ items: n })).map((i) =>
          (i.options ?? []).join('|'),
        );
      expect(render()).toEqual(render());
    }
  });
});

describe('deterministicQuizItems — quiz.focus', () => {
  for (const focus of ['structure', 'concepts', 'rationale'] as QuizFocus[]) {
    it(`draws every item from "${focus}" when the doc has the material`, () => {
      const items = deterministicQuizItems(
        RICH,
        CORPUS,
        'en',
        undefined,
        quiz({ items: 3, focus }),
      );
      expect(items).toHaveLength(3);
      expect(items.map((i) => i.dim)).toEqual([focus, focus, focus]);
    });
  }

  it('auto keeps the varied draw — concepts, then rationale', () => {
    const items = deterministicQuizItems(RICH, CORPUS, 'en', undefined, quiz({ items: 3 }));
    expect(items.map((i) => i.dim).slice(0, 2)).toEqual(['concepts', 'rationale']);
  });

  it('a focus the doc cannot feed falls back rather than returning a short check', () => {
    // THIN has no rationale at all. The count is the promise; the dimension is
    // a preference, so it degrades to whatever the doc does say.
    const items = deterministicQuizItems(
      THIN,
      CORPUS,
      'en',
      undefined,
      quiz({ items: 2, focus: 'rationale' }),
    );
    expect(items).toHaveLength(2);
    expect(items.some((i) => i.dim !== 'rationale')).toBe(true);
  });
});
