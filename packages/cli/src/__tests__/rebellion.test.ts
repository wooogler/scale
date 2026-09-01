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
import { driftContext } from '../drift-context.js';

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

describe('rebellion — authorship (PLAN-GATE S2)', () => {
  /** Commit as someone else, then restore the local identity. */
  function commitAs(email: string, name: string, message: string): void {
    git(['add', '-A']);
    git(['commit', '-qm', message], {
      GIT_AUTHOR_EMAIL: email,
      GIT_AUTHOR_NAME: name,
      GIT_COMMITTER_EMAIL: email,
      GIT_COMMITTER_NAME: name,
    });
  }

  /** Bring `widget` to validated, then return its state after `mutate` + recompute. */
  function afterChange(mutate: () => void): string {
    seedComponent('widget', 40);
    git(['add', '-A']);
    git(['commit', '-qm', 'initial']);
    recordChecks('widget', 4, Date.parse('2026-09-01T00:00:00Z'));
    expect(recomputeCoverageFromDisk(repo).coverage.components['widget']!.state).toBe('validated');
    mutate();
    return recomputeCoverageFromDisk(repo).coverage.components['widget']!.state;
  }

  it('a MODERATE change by a collaborator re-locks the territory', () => {
    const state = afterChange(() => {
      fs.appendFileSync(
        path.join(repo, 'src', 'widget.ts'),
        Array.from({ length: 14 }, (_, i) => `// colleague ${i}`).join('\n') + '\n',
      );
      commitAs('colleague@example.com', 'Colleague', 'colleague edit');
    });
    expect(state).toBe('stale');
  });

  it('the SAME change made by the user does not', () => {
    // The asymmetry, end to end and against real git: identical churn, opposite
    // verdicts, decided only by who authored the commit.
    const state = afterChange(() => {
      fs.appendFileSync(
        path.join(repo, 'src', 'widget.ts'),
        Array.from({ length: 14 }, (_, i) => `// mine ${i}`).join('\n') + '\n',
      );
      git(['add', '-A']);
      git(['commit', '-qm', 'my edit']);
    });
    expect(state).toBe('validated');
  });

  it('a total self-rewrite still rebels — the one hole self-churn closes', () => {
    const state = afterChange(() => {
      writeSource('widget', 40, 'my total rewrite');
      git(['add', '-A']);
      git(['commit', '-qm', 'my rewrite']);
    });
    expect(state).toBe('stale');
  });

  it('merging a collaborator PR attributes the churn to THEM, not the merger', () => {
    // Default `git log --numstat` skips merge commits, so the work stays on the
    // commit its author wrote. Without that, every reviewer who merges would
    // absorb their teammates' churn as self churn and never rebel.
    const state = afterChange(() => {
      const main = git(['rev-parse', '--abbrev-ref', 'HEAD']); // init.defaultBranch varies
      git(['checkout', '-qb', 'feature']);
      fs.appendFileSync(
        path.join(repo, 'src', 'widget.ts'),
        Array.from({ length: 20 }, (_, i) => `// from the PR ${i}`).join('\n') + '\n',
      );
      commitAs('colleague@example.com', 'Colleague', 'PR work');
      git(['checkout', '-q', main]);
      git(['merge', '-q', '--no-ff', 'feature', '-m', 'Merge PR']); // merged BY me
    });
    expect(state).toBe('stale');
  });

  it('with NO resolvable git identity, everything reads as self (fails safe)', () => {
    // A laptop with no `user.email` must not turn every teammate — and every
    // one of the user's OWN commits — into a stranger, which would re-lock the
    // whole map with nothing on screen to explain it. The safe direction is the
    // opposite one: attribute everything to self, where only the high bar
    // applies. `scale status` reports the identity so this stays visible.
    seedComponent('widget', 40);
    git(['add', '-A']);
    git(['commit', '-qm', 'initial']);
    recordChecks('widget', 4, Date.parse('2026-09-01T00:00:00Z'));
    recomputeCoverageFromDisk(repo);

    git(['config', '--unset', 'user.email']);
    fs.appendFileSync(
      path.join(repo, 'src', 'widget.ts'),
      Array.from({ length: 14 }, (_, i) => `// colleague ${i}`).join('\n') + '\n',
    );
    commitAs('colleague@example.com', 'Colleague', 'colleague edit');

    const res = recomputeCoverageFromDisk(repo);
    // The very change that re-locked in the first test of this block is now
    // scored entirely as self, and stays below the self bar.
    expect(res.churn['widget']?.foreign).toBe(0);
    expect(res.churn['widget']!.self).toBeGreaterThan(0);
    expect(res.coverage.components['widget']!.state).toBe('validated');
  });
});

describe('rebellion — the churn pre-filter must never skip a real change', () => {
  it('sees churn on a file that was changed and then reverted', () => {
    // The pre-filter asks git which files moved since the OLDEST anchor, to skip
    // per-component walks. Using `git diff --name-only` there was wrong: a net
    // diff omits a file changed and then reverted inside the range, while a
    // nearer anchor still sees it as changed. Measured on the real repo, that
    // broke the superset property for 17 of 24 anchor depths — each one a
    // component whose rebellion would have been silently skipped.
    seedComponent('widget', 40);
    git(['add', '-A']);
    git(['commit', '-qm', 'initial']);
    const original = fs.readFileSync(path.join(repo, 'src', 'widget.ts'), 'utf8');

    // A second, older-anchored component so the oldest anchor predates the churn.
    seedComponent('other', 40);
    git(['add', '-A']);
    git(['commit', '-qm', 'add other']);
    recordChecks('other', 4, Date.parse('2026-09-01T00:00:00Z'));
    recomputeCoverageFromDisk(repo);

    // widget validated LATER, so its anchor is nearer than other's.
    writeSource('widget', 40, 'v2');
    git(['add', '-A']);
    git(['commit', '-qm', 'widget v2']);
    recordChecks('widget', 4, Date.parse('2026-09-02T00:00:00Z'));
    recomputeCoverageFromDisk(repo);

    // A colleague rewrites widget, then reverts it exactly. Net diff from the
    // OLD anchor: unchanged. Real churn since widget's anchor: substantial.
    writeSource('widget', 40, 'colleague churn');
    git(['add', '-A']);
    git(['commit', '-qm', 'colleague rewrite'], {
      GIT_AUTHOR_EMAIL: 'colleague@example.com',
      GIT_AUTHOR_NAME: 'Colleague',
      GIT_COMMITTER_EMAIL: 'colleague@example.com',
      GIT_COMMITTER_NAME: 'Colleague',
    });
    fs.writeFileSync(path.join(repo, 'src', 'widget.ts'), original);
    git(['add', '-A']);
    git(['commit', '-qm', 'revert'], {
      GIT_AUTHOR_EMAIL: 'colleague@example.com',
      GIT_AUTHOR_NAME: 'Colleague',
      GIT_COMMITTER_EMAIL: 'colleague@example.com',
      GIT_COMMITTER_NAME: 'Colleague',
    });

    const res = recomputeCoverageFromDisk(repo);
    expect(res.churn['widget']?.foreign ?? 0).toBeGreaterThan(0);
    expect(res.coverage.components['widget']!.state).toBe('stale');
  });
});

describe('driftContext — gathering the change from real git', () => {
  it('collects commits, files, regions and hunks for a drifted component', () => {
    seedComponent('widget', 40);
    git(['add', '-A']);
    git(['commit', '-qm', 'initial']);
    const base = git(['rev-parse', '--short', 'HEAD']);

    fs.writeFileSync(
      path.join(repo, 'src', 'widget.ts'),
      'export function alpha(): number {\n  return 1;\n}\n',
    );
    git(['add', '-A']);
    git(['commit', '-qm', 'rewrite as a function'], {
      GIT_AUTHOR_EMAIL: 'ada@example.com',
      GIT_AUTHOR_NAME: 'Ada',
      GIT_COMMITTER_EMAIL: 'ada@example.com',
      GIT_COMMITTER_NAME: 'Ada',
    });

    const ctx = driftContext(repo, base, ['src/widget.ts'], 'foreign');
    expect(ctx).not.toBeNull();
    expect(ctx!.commits).toHaveLength(1);
    expect(ctx!.commits[0]?.author).toBe('ada@example.com');
    expect(ctx!.commits[0]?.subject).toBe('rewrite as a function');
    expect(ctx!.files[0]?.path).toBe('src/widget.ts');
    expect(ctx!.hunks.length).toBeGreaterThan(0);
    expect(ctx!.hunks[0]?.churn).toBeGreaterThan(0);
  });

  it('survives a user gitconfig that would otherwise hijack the diff', () => {
    // `-c diff.external=` does NOT disable an external diff — git tries to RUN
    // the empty string and dies ("cannot run : No such file or directory"),
    // which silently produced no drift block at all. `--no-ext-diff` is the
    // supported way, and this pins that a hostile/broken setting cannot win.
    seedComponent('widget', 20);
    git(['add', '-A']);
    git(['commit', '-qm', 'initial']);
    const base = git(['rev-parse', '--short', 'HEAD']);
    writeSource('widget', 20, 'changed');
    git(['add', '-A']);
    git(['commit', '-qm', 'change']);

    git(['config', 'diff.external', '/nonexistent/definitely-not-a-program']);
    const ctx = driftContext(repo, base, ['src/widget.ts'], 'self');
    expect(ctx).not.toBeNull();
    expect(ctx!.hunks.length).toBeGreaterThan(0);
  });

  it('returns null rather than throwing on an unresolvable anchor', () => {
    seedComponent('widget', 10);
    git(['add', '-A']);
    git(['commit', '-qm', 'initial']);
    expect(driftContext(repo, 'deadbeef', ['src/widget.ts'], 'foreign')).toBeNull();
    expect(driftContext(repo, null, ['src/widget.ts'], 'foreign')).toBeNull();
    expect(driftContext(repo, 'HEAD', [], 'foreign')).toBeNull();
  });

  it('returns null when nothing changed — no empty block', () => {
    seedComponent('widget', 10);
    git(['add', '-A']);
    git(['commit', '-qm', 'initial']);
    const head = git(['rev-parse', '--short', 'HEAD']);
    expect(driftContext(repo, head, ['src/widget.ts'], 'foreign')).toBeNull();
  });
});
