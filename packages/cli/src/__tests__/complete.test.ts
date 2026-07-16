import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

import { stateDir, paths } from '../state.js';
import { completeQuizQuest, completeSocraticQuest } from '../quest.js';

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
