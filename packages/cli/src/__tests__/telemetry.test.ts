/**
 * Telemetry — the shippable stream (PLAN-GATE S4, §15). What can only break
 * here: the ledger writing its rows, and the out-of-band detector reading git.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  stateDir,
  paths,
  writeUserConfigRaw,
  writeLocks,
  emptyLocks,
  readLocksSafe,
  noteCheckOutcome,
  notePendingUnlock,
  syncLocksWithDrift,
  pruneLocksToKnown,
  writeSession,
  defaultSession,
} from '../state.js';
import { readTelemetrySafe, outOfBandEdits, summarizeTelemetry, recordConfigDelta } from '../telemetry.js';
import { resolveConfig } from '@scale/core';

let home: string;
let repo: string;
let dir: string;
let prevHome: string | undefined;

const git = (args: string[]): string =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

function seed(id: string): void {
  const d = path.join(repo, '.scale', 'prov', id);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(
    path.join(d, 'README.md'),
    `---\nid: ${id}\ntitle: ${id}\nsources:\n  - src/${id}.ts\nconcepts:\n  - id: ${id}-c\n    name: c\nrationale:\n  - decision: d\n    why: w\n    provenance: inferred\n---\n\n# ${id}\n`,
  );
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', `${id}.ts`), `// ${id}\n`);
}

beforeEach(() => {
  prevHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'scale-tel-home-'));
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'scale-tel-repo-'));
  process.env.HOME = home;
  git(['init', '-q']);
  git(['config', 'user.email', 'me@example.com']);
  git(['config', 'user.name', 'Me']);
  seed('auth');
  seed('billing');
  git(['add', '-A']);
  // Backdated: the seed predates every session these tests open, so only what
  // a test itself changes can show up as in-period.
  const past = new Date(Date.now() - 10 * 60_000).toISOString();
  execFileSync('git', ['commit', '-q', '-m', 'seed'], {
    cwd: repo, stdio: 'ignore',
    env: { ...process.env, GIT_AUTHOR_DATE: past, GIT_COMMITTER_DATE: past },
  });
  dir = stateDir(repo);
  fs.mkdirSync(dir, { recursive: true });
  writeUserConfigRaw(dir, { user: 'tester' });
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('ledger rows', () => {
  it('an unlock records how long the check was owed and whether it recovered drift', () => {
    writeSession(dir, defaultSession('sess-1', '2026-09-01T09:00:00Z'));
    notePendingUnlock(dir, 'auth', 'sess-1', '2026-09-01T09:00:00Z');
    const r = noteCheckOutcome(repo, dir, 'auth', 0.9, 'user', 'abc', '2026-09-01T10:30:00Z', 'quiz');
    expect(r.unlocked).toBe(true);
    const rows = readTelemetrySafe(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'unlock', component: 'auth', via: 'quiz', meanScore: 0.9, checks: 1,
      owedMs: 90 * 60_000, recovery: false, sessionId: 'sess-1', user: 'tester',
    });
  });

  it('a failed or agent check writes nothing', () => {
    noteCheckOutcome(repo, dir, 'auth', 0.2, 'user', 'abc');
    noteCheckOutcome(repo, dir, 'auth', 1, 'agent', 'abc');
    expect(readTelemetrySafe(dir)).toEqual([]);
  });

  it('a re-lock counts collaborators without naming them; recovering it says so', () => {
    const locks = emptyLocks();
    locks.components['auth'] = { unlockedAt: 't', sha: 'abc', checks: 1, via: 'check' };
    writeLocks(dir, locks);
    syncLocksWithDrift(dir, { auth: { state: 'stale' } }, { auth: { cause: 'foreign', foreignAuthors: ['a@x', 'b@x'] } });
    let rows = readTelemetrySafe(dir);
    expect(rows[0]).toMatchObject({ type: 'relock', component: 'auth', cause: 'foreign', foreignAuthors: 2 });
    expect(JSON.stringify(rows[0])).not.toContain('a@x');
    noteCheckOutcome(repo, dir, 'auth', 1, 'user', 'def');
    rows = readTelemetrySafe(dir);
    expect(rows[1]).toMatchObject({ type: 'unlock', recovery: true, owedMs: null });
  });

  it('pruneLocksToKnown drops ghosts from every table and nothing else', () => {
    const locks = emptyLocks();
    locks.components['auth'] = { unlockedAt: 't', sha: 'a', checks: 1, via: 'check' };
    locks.components['ghost'] = { unlockedAt: 't', sha: 'a', checks: 1, via: 'check' };
    locks.pendingUnlocks['old'] = { at: 't', sessionId: 's' };
    locks.progress['gone'] = 1;
    writeLocks(dir, locks);
    expect(pruneLocksToKnown(dir, ['auth', 'billing']).sort()).toEqual(['ghost', 'gone', 'old']);
    const after = readLocksSafe(dir);
    expect(Object.keys(after.components)).toEqual(['auth']);
    expect(after.pendingUnlocks).toEqual({});
    expect(pruneLocksToKnown(dir, ['auth'])).toEqual([]);
  });
});

describe('config deltas', () => {
  it('one row per changed leaf, reset flagged, team value alongside', () => {
    fs.writeFileSync(path.join(repo, '.scale', 'policy.json'), JSON.stringify({ gate: { enforcement: 'hard' } }));
    const policy = { gate: { enforcement: 'hard' } };
    const before = resolveConfig({ user: 'tester' }, policy).config;
    const after = resolveConfig({ user: 'tester', gate: { enforcement: 'soft', modality: 'socratic' } }, policy).config;
    expect(recordConfigDelta(dir, repo, before, after, 'cli', false)).toBe(2);
    expect(recordConfigDelta(dir, repo, after, before, 'cli', true)).toBe(2);
    const rows = readTelemetrySafe(dir);
    expect(rows.map((r) => (r as { path: string }).path)).toEqual([
      'gate.enforcement', 'gate.modality', 'gate.enforcement', 'gate.modality',
    ]);
    expect(rows[0]).toMatchObject({ from: 'hard', to: 'soft', policyValue: 'hard', direction: 'loosen', reset: false });
    expect(rows[1]).toMatchObject({ policyValue: null, direction: 'neutral' });
    expect(rows[2]).toMatchObject({ from: 'soft', to: 'hard', reset: true, direction: 'tighten' });
  });
});

describe('out-of-band edits — around the tools, seen from git at period end', () => {
  const session = () => ({ ...defaultSession('sess-1', new Date(Date.now() - 60_000).toISOString()) });

  it('a locked component committed by the user with no touch is out of band', () => {
    fs.appendFileSync(path.join(repo, 'src', 'auth.ts'), '// edited in vim\n');
    git(['commit', '-q', '-am', 'sneaky']);
    const rows = outOfBandEdits(repo, dir, session());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ component: 'auth', seenIn: 'commits', deniedThisSession: false });
  });

  it('uncommitted working-tree changes count too, and a deny this period is noted', () => {
    fs.appendFileSync(path.join(repo, 'src', 'billing.ts'), '// shell edit\n');
    fs.appendFileSync(
      paths.evidence(dir),
      JSON.stringify({ type: 'intervention', ts: new Date().toISOString(), user: 'tester', componentId: 'billing',
        timing: 'inflow', modality: 'quiz', outcome: 'requested', trigger: 'edit' }) + '\n',
    );
    const rows = outOfBandEdits(repo, dir, session());
    expect(rows).toEqual([expect.objectContaining({ component: 'billing', seenIn: 'worktree', deniedThisSession: true })]);
  });

  it('an edit that went THROUGH the tools (touch evidence) is not out of band', () => {
    fs.appendFileSync(path.join(repo, 'src', 'auth.ts'), '// via Edit\n');
    fs.appendFileSync(
      paths.evidence(dir),
      JSON.stringify({ type: 'touch', ts: new Date().toISOString(), user: 'tester', files: ['src/auth.ts'], componentIds: ['auth'] }) + '\n',
    );
    expect(outOfBandEdits(repo, dir, session())).toEqual([]);
  });

  it('an UNLOCKED component may be edited any way one likes', () => {
    const locks = emptyLocks();
    locks.components['auth'] = { unlockedAt: 't', sha: 'a', checks: 1, via: 'check' };
    writeLocks(dir, locks);
    fs.appendFileSync(path.join(repo, 'src', 'auth.ts'), '// fine\n');
    expect(outOfBandEdits(repo, dir, session())).toEqual([]);
  });

  it("a collaborator's commit is not the user's out-of-band edit", () => {
    fs.appendFileSync(path.join(repo, 'src', 'auth.ts'), '// colleague\n');
    execFileSync('git', ['commit', '-q', '-am', 'theirs'], {
      cwd: repo, stdio: 'ignore',
      env: { ...process.env, GIT_AUTHOR_EMAIL: 'them@example.com', GIT_AUTHOR_NAME: 'Them', GIT_COMMITTER_EMAIL: 'them@example.com', GIT_COMMITTER_NAME: 'Them' },
    });
    expect(outOfBandEdits(repo, dir, session())).toEqual([]);
  });
});

describe('summary', () => {
  it('computes the avoidance share and the owed-check median', () => {
    const base = { v: 1 as const, ts: 't', user: 'u', sessionId: 's' };
    const s = summarizeTelemetry([
      { ...base, type: 'gate', decision: 'deny', component: 'a', cause: 'locked', enforcement: 'soft', assessment: 'async', modality: 'quiz', budgetUsed: 1, budgetMax: 3 },
      { ...base, type: 'gate', decision: 'deny', component: 'b', cause: 'locked', enforcement: 'soft', assessment: 'async', modality: 'quiz', budgetUsed: 2, budgetMax: 3 },
      { ...base, type: 'skip', component: 'a', by: 'user', enforcement: 'soft', msSinceDeny: 100 },
      { ...base, type: 'unlock', component: 'b', via: 'quiz', meanScore: 1, checks: 1, owedMs: 5000, recovery: false },
      { ...base, type: 'config_change', path: 'gate.enforcement', from: 'hard', to: 'soft', source: 'web', reset: false, policyValue: 'hard', direction: 'loosen' },
    ]);
    expect(s.denies).toBe(2);
    expect(s.avoidanceRate).toBe(0.5); // a denied, never unlocked; b denied, unlocked
    expect(s.deniedComponents).toBe(2);
    expect(s.unlockedAfterDeny).toBe(1);
    expect(s.medianOwedMs).toBe(5000);
    expect(s.overrides.loosen).toBe(1);
  });
});
