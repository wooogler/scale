/**
 * The unlock ledger + config layering (PLAN-GATE §2, §3.1).
 *
 * These pin the permission model's ground rules: only a user's PASSED check
 * unlocks, progress accumulates toward checksRequired, the user file stays
 * sparse so team-policy defaults remain live, and a broken policy fails open.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readLocksSafe,
  writeLocks,
  emptyLocks,
  noteCheckOutcome,
  loadEffectiveConfig,
  readUserConfigRaw,
  writeUserConfigRaw,
} from '../state.js';

let dir: string; // fake ~/.scale/<repo-id>
let cwd: string; // fake repo root (holds .scale/policy.json)

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scale-locks-state-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'scale-locks-repo-'));
  fs.mkdirSync(path.join(cwd, '.scale'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

const writePolicy = (obj: unknown): void => {
  fs.writeFileSync(path.join(cwd, '.scale', 'policy.json'), JSON.stringify(obj));
};

describe('noteCheckOutcome — the single unlock funnel', () => {
  it('a passed user check unlocks at the default checksRequired=1', () => {
    const r = noteCheckOutcome(cwd, dir, 'auth', 0.8, 'user', 'abc123');
    expect(r.unlocked).toBe(true);
    expect(readLocksSafe(dir).components['auth']?.sha).toBe('abc123');
  });

  it('a failed check (below passBar) never unlocks', () => {
    const r = noteCheckOutcome(cwd, dir, 'auth', 0.5, 'user', 'abc');
    expect(r.unlocked).toBe(false);
    expect(readLocksSafe(dir).components['auth']).toBeUndefined();
  });

  it('an agent-answered check NEVER unlocks, whatever it scored', () => {
    const r = noteCheckOutcome(cwd, dir, 'auth', 1.0, 'agent', 'abc');
    expect(r.unlocked).toBe(false);
    expect(readLocksSafe(dir).components['auth']).toBeUndefined();
    expect(readLocksSafe(dir).progress['auth']).toBeUndefined();
  });

  it('checksRequired > 1 accumulates progress before unlocking', () => {
    writePolicy({ unlock: { checksRequired: 2 } });
    const first = noteCheckOutcome(cwd, dir, 'auth', 0.9, 'user', 'abc');
    expect(first.unlocked).toBe(false);
    expect(first.checks).toBe(1);
    expect(readLocksSafe(dir).progress['auth']).toBe(1);
    const second = noteCheckOutcome(cwd, dir, 'auth', 0.9, 'user', 'def');
    expect(second.unlocked).toBe(true);
    expect(readLocksSafe(dir).components['auth']?.checks).toBe(2);
    expect(readLocksSafe(dir).progress['auth']).toBeUndefined();
  });

  it('policy passBar override raises the bar', () => {
    writePolicy({ unlock: { passBar: 0.9 } });
    expect(noteCheckOutcome(cwd, dir, 'a', 0.8, 'user', 's').unlocked).toBe(false);
    expect(noteCheckOutcome(cwd, dir, 'a', 0.95, 'user', 's').unlocked).toBe(true);
  });

  it('an already-unlocked component just counts the extra check', () => {
    noteCheckOutcome(cwd, dir, 'auth', 1, 'user', 's1');
    const r = noteCheckOutcome(cwd, dir, 'auth', 1, 'user', 's2');
    expect(r.alreadyUnlocked).toBe(true);
    expect(readLocksSafe(dir).components['auth']?.checks).toBe(2);
    expect(readLocksSafe(dir).components['auth']?.sha).toBe('s1'); // unlock sha kept
  });
});

describe('locks.json robustness', () => {
  it('missing/garbage file reads as empty', () => {
    expect(readLocksSafe(dir)).toEqual(emptyLocks());
    fs.writeFileSync(path.join(dir, 'locks.json'), 'not json');
    expect(readLocksSafe(dir)).toEqual(emptyLocks());
  });

  it('round-trips', () => {
    const locks = emptyLocks();
    locks.components['x'] = { unlockedAt: 't', sha: 's', checks: 1, via: 'check' };
    locks.progress['y'] = 1;
    writeLocks(dir, locks);
    expect(readLocksSafe(dir)).toEqual(locks);
  });
});

describe('loadEffectiveConfig — layering on disk', () => {
  it('policy defaults apply under a sparse user file', () => {
    writeUserConfigRaw(dir, { user: 'me' });
    writePolicy({ gate: { enforcement: 'hard' }, budgets: { maxPerSession: 9 } });
    const eff = loadEffectiveConfig(cwd, dir);
    expect(eff.policyApplied).toBe(true);
    expect(eff.config.gate.enforcement).toBe('hard');
    expect(eff.config.budgets.maxPerSession).toBe(9);
    // The user file stayed sparse — nothing materialized into it.
    expect(readUserConfigRaw(dir)).toEqual({ user: 'me' });
  });

  it('user overrides beat policy; personal keys ignore policy entirely', () => {
    writeUserConfigRaw(dir, { user: 'me', gate: { enforcement: 'advisory' } });
    writePolicy({ gate: { enforcement: 'hard' }, language: 'ko', user: 'evil' });
    const eff = loadEffectiveConfig(cwd, dir);
    expect(eff.config.gate.enforcement).toBe('advisory');
    expect(eff.config.language).toBe('en');
    expect(eff.config.user).toBe('me');
  });

  it('unparseable policy.json fails open with the reason surfaced', () => {
    writeUserConfigRaw(dir, { user: 'me' });
    fs.writeFileSync(path.join(cwd, '.scale', 'policy.json'), '{oops');
    const eff = loadEffectiveConfig(cwd, dir);
    expect(eff.policyPresent).toBe(true);
    expect(eff.policyApplied).toBe(false);
    expect(eff.policyError).toContain('not valid JSON');
    expect(eff.config.gate.enforcement).toBe('soft'); // schema default
  });

  it('no policy file at all: plain defaults + user', () => {
    writeUserConfigRaw(dir, { user: 'me' });
    const eff = loadEffectiveConfig(cwd, dir);
    expect(eff.policyPresent).toBe(false);
    expect(eff.policyApplied).toBe(false);
    expect(eff.policyError).toBeNull();
  });

  it('a legacy user file (condition/inflow) still resolves', () => {
    writeUserConfigRaw(dir, {
      user: 'me',
      condition: { timing: 'postsession', modality: 'socratic' },
    });
    const eff = loadEffectiveConfig(cwd, dir);
    expect(eff.config.gate.assessment).toBe('async');
    expect(eff.config.gate.modality).toBe('socratic');
  });
});
