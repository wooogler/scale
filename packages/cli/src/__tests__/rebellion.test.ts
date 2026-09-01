/**
 * Rebellion — staleness against a REAL git repo (PLAN-GATE §4 S2).
 *
 * These run against a throwaway git repo + $HOME, because the thing under test
 * is precisely the impure edge: which sha churn is measured from, and what git
 * reports for it. The pure halves (`foldEvidence`, `recomputeDrift`) are covered
 * in core; what could only break here is the wiring between them.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { stateDir, paths } from '../state.js';
import { recomputeCoverageFromDisk } from '../coverage.js';

let home: string;
let repo: string;
let prevHome: string | undefined;

const git = (args: string[], env: Record<string, string> = {}): string =>
  execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, ...env },
  }).trim();

/** A component paper anchored to one source file of `lines` lines. */
function seedComponent(id: string, lines: number): void {
  const dir = path.join(repo, '.scale', 'prov', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'README.md'),
    [
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
      '    why: because it must',
      '    provenance: inferred',
      '---',
      '',
      `# ${id}`,
      '',
    ].join('\n'),
  );
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  writeSource(id, lines, 'original');
}

function writeSource(id: string, lines: number, marker: string): void {
  const body = Array.from({ length: lines }, (_, i) => `// ${marker} line ${i}`).join('\n');
  fs.writeFileSync(path.join(repo, 'src', `${id}.ts`), body + '\n');
}

/** Append one evidence row, as `scale record` would. */
function appendEvidenceLine(entry: Record<string, unknown>): void {
  const dir = stateDir(repo);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(paths.evidence(dir), JSON.stringify(entry) + '\n');
}

/** Record `n` passing quiz results for `id`, anchored at the current HEAD. */
function recordChecks(id: string, n: number, tsBase: number): void {
  const sha = git(['rev-parse', '--short', 'HEAD']);
  for (let i = 0; i < n; i++) {
    for (const dim of ['structure', 'concepts', 'rationale'] as const) {
      appendEvidenceLine({
        type: 'quiz_result',
        ts: new Date(tsBase + i * 3000 + dim.length).toISOString(),
        user: 'tester',
        componentId: id,
        dim,
        score: 1,
        sha,
        origin: 'session',
        by: 'user',
      });
    }
  }
}

beforeEach(() => {
  prevHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'scale-reb-home-'));
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'scale-reb-repo-'));
  process.env.HOME = home;
  git(['init', '-q', '.']);
  git(['config', 'user.email', 'me@example.com']);
  git(['config', 'user.name', 'Me']);
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('rebellion — drift against a real repo', () => {
  it('a heavy rewrite flips a validated component to stale', () => {
    seedComponent('widget', 40);
    git(['add', '-A']);
    git(['commit', '-qm', 'initial']);

    recordChecks('widget', 4, Date.parse('2026-09-01T00:00:00Z'));
    expect(recomputeCoverageFromDisk(repo).coverage.components['widget']!.state).toBe('validated');

    writeSource('widget', 40, 'rewritten');
    git(['add', '-A']);
    git(['commit', '-qm', 'rewrite']);

    const after = recomputeCoverageFromDisk(repo).coverage.components['widget']!;
    expect(after.state).toBe('stale');
    expect(after.loyalty).toBeLessThan(0.5);
  });

  it('ONE passing check recovers a stale component, in the same recompute', () => {
    // The regression this pins: churn used to be measured from the PREVIOUSLY
    // PERSISTED lastValidatedSha, so a component that had just been re-validated
    // was still compared against its pre-rebellion anchor and flipped straight
    // back to `stale`. Recovery silently took two recomputes — and once the edit
    // gate re-locks on rebellion, that means the junior stays locked out of
    // territory they just earned back, reading "needs more validation" after
    // scoring 1.0. Churn must be measured from the anchor THIS fold produced.
    seedComponent('widget', 40);
    git(['add', '-A']);
    git(['commit', '-qm', 'initial']);

    recordChecks('widget', 4, Date.parse('2026-09-01T00:00:00Z'));
    recomputeCoverageFromDisk(repo);

    writeSource('widget', 40, 'rewritten');
    git(['add', '-A']);
    git(['commit', '-qm', 'rewrite']);
    expect(recomputeCoverageFromDisk(repo).coverage.components['widget']!.state).toBe('stale');

    // A single passing check, anchored at the post-rewrite HEAD.
    recordChecks('widget', 1, Date.parse('2026-09-02T00:00:00Z'));

    const recovered = recomputeCoverageFromDisk(repo).coverage.components['widget']!;
    expect(recovered.state).toBe('validated');
    expect(recovered.loyalty).toBe(1);
    expect(recovered.lastValidatedSha).toBe(git(['rev-parse', '--short', 'HEAD']));
  });

  it('a component that was never validated cannot go stale', () => {
    seedComponent('widget', 40);
    git(['add', '-A']);
    git(['commit', '-qm', 'initial']);
    writeSource('widget', 40, 'rewritten');
    git(['add', '-A']);
    git(['commit', '-qm', 'rewrite']);

    const comp = recomputeCoverageFromDisk(repo).coverage.components['widget']!;
    expect(comp.lastValidatedSha).toBeNull();
    expect(comp.state).not.toBe('stale');
    expect(comp.loyalty).toBe(1);
  });

  it('a trivial edit leaves a validated component alone', () => {
    seedComponent('widget', 40);
    git(['add', '-A']);
    git(['commit', '-qm', 'initial']);
    recordChecks('widget', 4, Date.parse('2026-09-01T00:00:00Z'));
    recomputeCoverageFromDisk(repo);

    fs.appendFileSync(path.join(repo, 'src', 'widget.ts'), '// one more line\n');
    git(['add', '-A']);
    git(['commit', '-qm', 'tiny']);

    const comp = recomputeCoverageFromDisk(repo).coverage.components['widget']!;
    expect(comp.state).toBe('validated');
    expect(comp.loyalty).toBeGreaterThan(0.9);
  });
});
