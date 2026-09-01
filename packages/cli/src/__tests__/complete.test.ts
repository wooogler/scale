import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

import { stateDir, paths } from '../state.js';
import {
  completeQuizQuest,
  completeSocraticQuest,
  questForClient,
  gradeQuizPicks,
} from '../quest.js';
import { QuestSchema, type Quest } from '@scale/core';

// completeQuizQuest / completeSocraticQuest are the SHARED completion path used
// by BOTH the CLI (`scale quest complete`) and the web POST endpoint. These
// tests exercise them end-to-end against a throwaway repo + $HOME so the state
// dir (~/.scale/<repo-id>/) is isolated.

let home: string;
let repo: string;
let prevHome: string | undefined;

/** A minimal .scale/ component paper the loader + coverage recompute can read. */
function seedComponent(repoRoot: string, id: string): void {
  const dir = path.join(repoRoot, '.scale', 'prov', id);
  fs.mkdirSync(dir, { recursive: true });
  const fm = [
    '---',
    `id: ${id}`,
    `title: ${id}`,
    'sources:',
    `  - src/${id}.ts`,
    'concepts:',
    `  - id: ${id}-c1`,
    `    name: ${id} core concept`,
    'rationale:',
    `  - decision: ${id} decision`,
    `    why: because it must`,
    '    provenance: inferred',
    '---',
    '',
    `# ${id}`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'README.md'), fm);
  // A real source file so the loyalty denominator (size) is non-zero.
  fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'src', `${id}.ts`), 'export const x = 1;\n');
}

/** Write a single pending quiz quest into the state dir and return its id. */
function seedQuest(repoRoot: string, componentId: string): string {
  const dir = stateDir(repoRoot);
  fs.mkdirSync(dir, { recursive: true });
  const id = 'quest-1';
  const quest = {
    id,
    componentId,
    modality: 'quiz',
    items: [{ prompt: 'q?', dim: 'concepts', options: ['a', 'b', 'c', 'd'], answer: 'a' }],
    origin: 'session',
    status: 'pending',
  };
  fs.writeFileSync(paths.quests(dir), JSON.stringify([quest], null, 2) + '\n');
  return id;
}

beforeEach(() => {
  prevHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'scale-home-'));
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'scale-repo-'));
  process.env.HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('completeQuizQuest (shared CLI + web path)', () => {
  it('records results, marks the quest completed, and returns the updated component', async () => {
    seedComponent(repo, 'alpha');
    const questId = seedQuest(repo, 'alpha');

    const result = await completeQuizQuest(repo, questId, [
      { dim: 'structure', score: 1 },
      { dim: 'concepts', score: 1 },
    ]);

    expect(result).not.toBeNull();
    expect(result!.componentId).toBe('alpha');
    expect(result!.recorded).toBe(2);
    // Two active validations at score 1 → the component moves off fog.
    expect(result!.component.state).not.toBe('fog');
    expect(result!.component.dims.concepts).toBeGreaterThan(0);

    // Quest is persisted as completed.
    const quests = JSON.parse(fs.readFileSync(paths.quests(stateDir(repo)), 'utf8'));
    expect(quests[0].status).toBe('completed');
  });

  it('skips malformed results (bad dim / out-of-range score)', async () => {
    seedComponent(repo, 'beta');
    const questId = seedQuest(repo, 'beta');

    const result = await completeQuizQuest(repo, questId, [
      { dim: 'nope', score: 1 },
      { dim: 'concepts', score: 5 },
      { dim: 'concepts', score: 0.9 },
    ]);

    expect(result!.recorded).toBe(1);
  });

  it('returns null for an unknown quest id', async () => {
    seedComponent(repo, 'gamma');
    seedQuest(repo, 'gamma');
    const result = await completeQuizQuest(repo, 'does-not-exist', [{ dim: 'concepts', score: 1 }]);
    expect(result).toBeNull();
  });
});

describe('completeSocraticQuest (shared CLI path)', () => {
  it('records a per-dim rubric result and marks the quest completed', async () => {
    seedComponent(repo, 'delta');
    const questId = seedQuest(repo, 'delta');

    const result = await completeSocraticQuest(repo, questId, {
      structure: 0.8,
      concepts: 0.9,
      rationale: 0.7,
    });

    expect(result).not.toBeNull();
    expect(result!.componentId).toBe('delta');
    expect(result!.recorded).toBe(3);
    expect(result!.component.dims.concepts).toBeGreaterThan(0);

    const quests = JSON.parse(fs.readFileSync(paths.quests(stateDir(repo)), 'utf8'));
    expect(quests[0].status).toBe('completed');
  });
});

describe('server-side grading (PLAN-GATE S3)', () => {
  const quiz = (): Quest =>
    QuestSchema.parse({
      id: 'q1',
      componentId: 'alpha',
      modality: 'quiz',
      origin: 'session',
      status: 'pending',
      items: [
        {
          prompt: 'one?',
          dim: 'concepts',
          options: ['a', 'b', 'c', 'd'],
          correctIndex: 2,
          answer: 'c',
          explanation: 'because c',
        },
        { prompt: 'two?', dim: 'concepts', options: ['a', 'b'], correctIndex: 0, answer: 'a' },
        { prompt: 'three?', dim: 'structure', options: ['a', 'b'], correctIndex: 1, answer: 'b' },
      ],
    });

  it('questForClient strips every part of the answer key', () => {
    // The key used to ride along on GET /api/quests, visible in the network tab
    // of any quiz. Cosmetic when a check moved a number; not cosmetic now that
    // a passed check unlocks territory.
    const sent = questForClient(quiz());
    for (const item of sent.items) {
      const rec = item as Record<string, unknown>;
      expect(rec.correctIndex).toBeUndefined();
      expect(rec.answer).toBeUndefined();
      expect(rec.explanation).toBeUndefined();
      // …while everything the runner draws survives.
      expect(rec.prompt).toBeTruthy();
      expect(rec.options).toBeTruthy();
      expect(rec.dim).toBeTruthy();
    }
    expect(JSON.stringify(sent)).not.toContain('because c');
  });

  it('grades picks against the stored key, per dimension', () => {
    const { results, reveal } = gradeQuizPicks(quiz(), [2, 1, 1]);
    // concepts: item0 right, item1 wrong → 0.5. structure: item2 right → 1.
    expect(results).toEqual(
      expect.arrayContaining([
        { dim: 'concepts', score: 0.5 },
        { dim: 'structure', score: 1 },
      ]),
    );
    expect(reveal.map((r) => r.correct)).toEqual([true, false, true]);
    expect(reveal[0]?.answer).toBe('c');
    expect(reveal[0]?.explanation).toBe('because c');
  });

  it('scores unanswered and out-of-range picks as wrong, never as right', () => {
    const { results } = gradeQuizPicks(quiz(), [null, undefined, 99]);
    expect(results.every((r) => r.score === 0)).toBe(true);
  });

  it('ignores a client that sends more picks than there are items', () => {
    const { results, reveal } = gradeQuizPicks(quiz(), [2, 0, 1, 0, 0, 0]);
    expect(reveal).toHaveLength(3);
    expect(results.find((r) => r.dim === 'concepts')?.score).toBe(1);
  });

  it('a client cannot claim a score — only picks are accepted', () => {
    // The shape the old endpoint trusted. Passed as picks it grades to zero,
    // because none of it names an option index.
    const { results } = gradeQuizPicks(quiz(), [
      { dim: 'concepts', score: 1 },
      { dim: 'structure', score: 1 },
    ] as unknown);
    expect(results.every((r) => r.score === 0)).toBe(true);
  });
});
