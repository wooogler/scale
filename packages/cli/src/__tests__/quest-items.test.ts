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
import { loadScaleDir, type LoadedScale } from '@scale/core';
import { deterministicQuizItems } from '../quest.js';

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
