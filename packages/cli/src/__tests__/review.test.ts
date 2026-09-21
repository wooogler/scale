/**
 * The post-session CHAT review path (PLAN-GATE §4 S3).
 *
 * These pin the two things the review owns that nothing else does: WHICH
 * territory is owed a check (a pure fold over the evidence log, with no new
 * persistent marker), and the grounding diff's formatting/cap. Ordering is
 * asserted against `pickComponents` — the same picker the web quest path runs —
 * because "the chat arm and the viewer arm queue the same work" is a property
 * of the experiment, not a nicety.
 */
import { describe, it, expect } from 'vitest';

import {
  ScaleConfigSchema,
  emptyComponentCoverage,
  type ComponentCoverage,
  type MapJson,
  type UserCoverage,
} from '@scale/core';

import {
  buildReviewQueue,
  formatReviewDiff,
  filesInTerritory,
  formatReviewItem,
  reviewAlreadyOpened,
  territoryFiles,
  touchedSinceLastCheck,
  truncateDiff,
  type RawEvidence,
} from '../review.js';

const config = ScaleConfigSchema.parse({ user: 'u' });

function mapOf(nodes: { id: string; importance: number }[]): MapJson {
  return {
    version: 1,
    builtFromSha: 'abc',
    provinces: [{ id: 'p', name: 'P' }],
    nodes: nodes.map((n) => ({ id: n.id, province: 'p', x: 0.5, y: 0.5, importance: n.importance })),
    edges: [],
  };
}

function comp(mean: number, state: ComponentCoverage['state'] = 'explored'): ComponentCoverage {
  return {
    ...emptyComponentCoverage(),
    state,
    dims: { structure: mean, concepts: mean, rationale: mean },
  };
}

function coverageOf(components: Record<string, ComponentCoverage>): UserCoverage {
  return { user: 'u', updatedAt: '', components };
}

const touch = (ts: string, ids: string[], files: string[] = []): RawEvidence => ({
  type: 'touch',
  ts,
  user: 'u',
  files,
  componentIds: ids,
});

const quizResult = (ts: string, id: string): RawEvidence => ({
  type: 'quiz_result',
  ts,
  user: 'u',
  componentId: id,
  dim: 'concepts',
  score: 0.8,
});

const deferred = (ts: string, id: string): RawEvidence => ({
  type: 'intervention',
  ts,
  user: 'u',
  componentId: id,
  timing: 'inflow',
  modality: 'quiz',
  outcome: 'deferred',
});

describe('touchedSinceLastCheck — what the user worked on since it was checked', () => {
  it('counts touches AFTER the last graded result, and ignores earlier ones', () => {
    const w = touchedSinceLastCheck([
      touch('2026-09-10T09:00:00.000Z', ['alpha'], ['a.ts']),
      quizResult('2026-09-11T09:00:00.000Z', 'alpha'),
      touch('2026-09-12T09:00:00.000Z', ['alpha'], ['b.ts']),
    ]).get('alpha')!;
    expect(w.since).toBe('2026-09-12T09:00:00.000Z');
    expect(w.files).toEqual(['b.ts']);
  });

  it('a component checked after its last touch is not in the window at all', () => {
    const windows = touchedSinceLastCheck([
      touch('2026-09-10T09:00:00.000Z', ['alpha'], ['a.ts']),
      quizResult('2026-09-11T09:00:00.000Z', 'alpha'),
    ]);
    expect(windows.has('alpha')).toBe(false);
  });

  it('a SKIP closes the window too — a declined check is not re-queued daily', () => {
    const before = touchedSinceLastCheck([
      touch('2026-09-10T09:00:00.000Z', ['alpha'], ['a.ts']),
      deferred('2026-09-11T09:00:00.000Z', 'alpha'),
    ]);
    expect(before.has('alpha')).toBe(false);
    // …until the junior touches it again, which is a new window.
    const after = touchedSinceLastCheck([
      touch('2026-09-10T09:00:00.000Z', ['alpha'], ['a.ts']),
      deferred('2026-09-11T09:00:00.000Z', 'alpha'),
      touch('2026-09-12T09:00:00.000Z', ['alpha'], ['c.ts']),
    ]);
    expect(after.get('alpha')?.files).toEqual(['c.ts']);
  });

  it('never checked → the window is the whole history; files dedupe and sort', () => {
    const w = touchedSinceLastCheck([
      touch('2026-09-12T09:00:00.000Z', ['alpha'], ['b.ts', 'a.ts']),
      touch('2026-09-10T09:00:00.000Z', ['alpha'], ['a.ts']),
    ]).get('alpha')!;
    expect(w.since).toBe('2026-09-10T09:00:00.000Z');
    expect(w.lastTouch).toBe('2026-09-12T09:00:00.000Z');
    expect(w.files).toEqual(['a.ts', 'b.ts']);
    expect(w.sessions).toBe(2); // two distinct UTC days
  });

  it('prompt evidence counts as a touch; a malformed row is skipped, not fatal', () => {
    const windows = touchedSinceLastCheck([
      { type: 'prompt', ts: '2026-09-12T09:00:00.000Z', user: 'u', componentIds: ['beta'] },
      { type: 'touch', ts: 'not-a-date', componentIds: ['gamma'] },
      { type: 'touch', ts: '2026-09-12T09:00:00.000Z' },
    ]);
    expect([...windows.keys()]).toEqual(['beta']);
    expect(windows.get('beta')?.files).toEqual([]);
  });
});

describe('territoryFiles — a touch row is not evidence about every component', () => {
  it('keeps only the files inside the component’s declared sources', () => {
    const touchedFiles = ['packages/core/src/gate.ts', 'packages/web/src/App.tsx'];
    expect(filesInTerritory(touchedFiles, ['packages/core/src/gate.ts'])).toEqual([
      'packages/core/src/gate.ts',
    ]);
    expect(territoryFiles(touchedFiles, ['packages/core'])).toEqual([
      'packages/core/src/gate.ts',
    ]);
  });

  it('falls back to the whole list when nothing matches (index fallback credit)', () => {
    const files = ['packages/cli/src/new-file.ts'];
    expect(filesInTerritory(files, ['packages/core'])).toEqual([]);
    expect(territoryFiles(files, ['packages/core'])).toEqual(files);
  });

  it('a doc with no sources narrows nothing', () => {
    expect(territoryFiles(['a.ts', 'b.ts'], [])).toEqual(['a.ts', 'b.ts']);
  });

  it('a source prefix only matches on a path boundary', () => {
    expect(filesInTerritory(['packages/core-extra/x.ts'], ['packages/core'])).toEqual([]);
  });
});

describe('buildReviewQueue — owed first, then touched × importance × gap', () => {
  const map = mapOf([
    { id: 'alpha', importance: 0.2 },
    { id: 'beta', importance: 0.9 },
    { id: 'owed-one', importance: 0.1 },
  ]);
  const coverage = coverageOf({
    alpha: comp(0.2),
    beta: comp(0.2),
    'owed-one': comp(0.9, 'validated'),
  });
  const touched = touchedSinceLastCheck([
    touch('2026-09-12T09:00:00.000Z', ['alpha'], ['a.ts']),
    touch('2026-09-12T10:00:00.000Z', ['beta'], ['b.ts']),
  ]);

  it('an owed check leads, whatever its importance or coverage says', () => {
    const q = buildReviewQueue({
      coverage,
      map,
      config,
      pending: { 'owed-one': { at: '2026-09-11T09:00:00.000Z' } },
      touched,
      limit: 3,
    });
    expect(q.map((i) => i.componentId)).toEqual(['owed-one', 'beta', 'alpha']);
    expect(q[0]!.reason).toBe('owed');
    expect(q[0]!.since).toBe('2026-09-11T09:00:00.000Z');
    // No touch rows for it (a denied edit writes none) — stated, not invented.
    expect(q[0]!.lastTouch).toBeNull();
    expect(q[0]!.files).toEqual([]);
  });

  it('touched items carry their window, their files and their coverage', () => {
    const q = buildReviewQueue({ coverage, map, config, pending: {}, touched, limit: 3 });
    expect(q.map((i) => i.componentId)).toEqual(['beta', 'alpha']); // importance × gap
    expect(q[0]).toMatchObject({
      reason: 'touched',
      since: '2026-09-12T10:00:00.000Z',
      files: ['b.ts'],
      sessions: 1,
      coverage: { state: 'explored' },
    });
    expect(q[0]!.coverage.mean).toBeCloseTo(0.2, 5);
  });

  it('nothing owed and nothing touched → an EMPTY queue, not filler homework', () => {
    // `pickComponents` falls back to the lowest-coverage components overall when
    // no session candidates exist. That is right for a quest batch and wrong
    // here: a review is about what this user just did.
    expect(
      buildReviewQueue({ coverage, map, config, pending: {}, touched: new Map(), limit: 3 }),
    ).toEqual([]);
  });

  it('honors the limit, and a non-positive limit yields nothing', () => {
    const one = buildReviewQueue({
      coverage,
      map,
      config,
      pending: { 'owed-one': { at: '2026-09-11T09:00:00.000Z' } },
      touched,
      limit: 1,
    });
    expect(one.map((i) => i.componentId)).toEqual(['owed-one']);
    expect(buildReviewQueue({ coverage, map, config, pending: {}, touched, limit: 0 })).toEqual([]);
  });

  it('a pending id that no longer exists in the map is dropped', () => {
    const q = buildReviewQueue({
      coverage,
      map,
      config,
      pending: { 'deleted-doc': { at: '2026-09-11T09:00:00.000Z' } },
      touched,
      limit: 3,
    });
    expect(q.map((i) => i.componentId)).toEqual(['beta', 'alpha']);
  });

  it('titles come from the docs; a missing one falls back to the id', () => {
    const q = buildReviewQueue({
      coverage,
      map,
      config,
      pending: {},
      touched,
      titles: { beta: 'Beta territory' },
      limit: 2,
    });
    expect(q[0]!.title).toBe('Beta territory');
    expect(q[1]!.title).toBe('alpha');
    expect(formatReviewItem(q[0]!)).toContain('beta — Beta territory');
    expect(formatReviewItem(q[0]!)).toContain('1 file(s) since 2026-09-12');
  });
});

describe('truncateDiff — a cap that keeps the patch readable', () => {
  it('leaves output under the cap untouched', () => {
    expect(truncateDiff('a\nb\n', 100)).toBe('a\nb\n');
  });

  it('cuts on a line boundary and says it truncated', () => {
    const text = ['aaaa', 'bbbb', 'cccc', 'dddd'].join('\n');
    const out = truncateDiff(text, 12);
    expect(out.endsWith('\n… truncated')).toBe(true);
    expect(out.split('\n').slice(0, -1)).toEqual(['aaaa', 'bbbb']);
  });

  it('counts BYTES, not characters — multibyte patches respect the cap', () => {
    const text = '한글한글한글\n한글한글한글';
    expect(Buffer.byteLength(truncateDiff(text, 20), 'utf8')).toBeLessThanOrEqual(
      Buffer.byteLength('한글한글한글', 'utf8') + Buffer.byteLength('\n… truncated', 'utf8'),
    );
  });

  it('a single over-long line is cut rather than dropped entirely', () => {
    const out = truncateDiff('x'.repeat(50), 10);
    expect(out.startsWith('xxxxxxxxxx')).toBe(true);
    expect(out).toContain('… truncated');
  });
});

describe('formatReviewDiff — grounding, or an honest note in its place', () => {
  const base = { componentId: 'alpha', since: '2026-09-12T09:00:00.000Z', files: ['a.ts'] };

  it('labels the territory, the window and the files', () => {
    const out = formatReviewDiff({
      ...base,
      diff: { commits: 'commit patch', worktree: 'wt patch', ok: true },
    });
    expect(out.split('\n')[0]).toBe(
      '# scale review diff — alpha (since 2026-09-12T09:00:00.000Z)',
    );
    expect(out).toContain('# files: a.ts');
    expect(out).toContain('--- commits since then ---\ncommit patch');
    expect(out).toContain('--- working tree ---\nwt patch');
  });

  it('git unavailable degrades to a one-line note — the check still stands', () => {
    const out = formatReviewDiff({ ...base, diff: { commits: '', worktree: '', ok: false } });
    expect(out).toContain('git unavailable here');
    expect(out).not.toContain('---');
  });

  it('no changes in the window is stated, so nobody reads silence as failure', () => {
    const out = formatReviewDiff({ ...base, diff: { commits: '', worktree: '   ', ok: true } });
    expect(out).toContain('# no changes to these files in this window.');
  });

  it('applies the byte cap to the whole block', () => {
    const out = formatReviewDiff({
      ...base,
      diff: { commits: 'x\n'.repeat(5000), worktree: '', ok: true },
      maxBytes: 200,
    });
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(
      200 + Buffer.byteLength('\n… truncated', 'utf8'),
    );
    expect(out.endsWith('… truncated')).toBe(true);
  });
});

describe('reviewAlreadyOpened — one intervention per component per session', () => {
  const row = (ts: string, over: RawEvidence = {}): RawEvidence => ({
    type: 'intervention',
    ts,
    user: 'u',
    componentId: 'alpha',
    timing: 'postsession',
    modality: 'quiz',
    outcome: 'requested',
    trigger: 'review',
    ...over,
  });

  it('true for a review request inside this session', () => {
    expect(
      reviewAlreadyOpened([row('2026-09-12T10:00:00.000Z')], 'alpha', '2026-09-12T09:00:00.000Z'),
    ).toBe(true);
  });

  it('false for an older session, another component, or the edit gate', () => {
    const start = '2026-09-12T09:00:00.000Z';
    expect(reviewAlreadyOpened([row('2026-09-11T10:00:00.000Z')], 'alpha', start)).toBe(false);
    expect(reviewAlreadyOpened([row('2026-09-12T10:00:00.000Z')], 'beta', start)).toBe(false);
    expect(
      reviewAlreadyOpened(
        [row('2026-09-12T10:00:00.000Z', { trigger: 'edit' })],
        'alpha',
        start,
      ),
    ).toBe(false);
  });

  it('no session record (empty start) → never suppresses the row', () => {
    expect(reviewAlreadyOpened([row('2026-09-12T10:00:00.000Z')], 'alpha', '')).toBe(false);
  });
});
