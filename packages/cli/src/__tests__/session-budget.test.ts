/**
 * Interruption-budget accounting (PLAN §6.1).
 *
 * `gate.ts` documents the budget as "provably honored (≤ maxPerSession per
 * session)". It was not: the record is one unlocked per-repo file, a second
 * Claude Code window rewrote it with a fresh counter, and the gate's
 * read-decide-write let two simultaneous commits both spend the same slot.
 * These pin the two properties that make the docblock true — a still-active
 * period is adopted rather than reset, and the decision is mutually exclusive.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultSession, isSessionAdoptable, withSessionLock } from '../state.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe('isSessionAdoptable', () => {
  const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
  // The shipped default: 12h, long enough that it never ends a working day —
  // it exists only to recover a SessionEnd lost to a crash.
  const BACKSTOP = 12 * HOUR;

  it('adopts a session that just started — a second window joins it', () => {
    expect(isSessionAdoptable(defaultSession('win-b', at(5 * MINUTE)), BACKSTOP)).toBe(true);
  });

  it('keeps a long continuous work period — the backstop must not end it', () => {
    // The case the old hardcoded 4h window got wrong: five hours of unbroken
    // work refilled the budget mid-session.
    expect(isSessionAdoptable(defaultSession('all-day', at(5 * HOUR)), BACKSTOP)).toBe(true);
  });

  it('expires once the backstop has passed — a lost SessionEnd is recovered', () => {
    expect(isSessionAdoptable(defaultSession('crashed', at(13 * HOUR)), BACKSTOP)).toBe(false);
  });

  it('measures from the last intervention, not the start', () => {
    const session = {
      ...defaultSession('long-running', at(20 * HOUR)),
      interventionsThisSession: 2,
      lastInterventionAt: at(1 * MINUTE),
    };
    expect(isSessionAdoptable(session, BACKSTOP)).toBe(true);
  });

  it('treats a future-dated record as expired, not adoptable forever', () => {
    const future = new Date(Date.now() + 30 * HOUR).toISOString();
    expect(isSessionAdoptable(defaultSession('skewed', future), BACKSTOP)).toBe(false);
  });

  it('treats an unparseable record as expired rather than adopting it', () => {
    expect(isSessionAdoptable(defaultSession('x', 'not-a-date'), BACKSTOP)).toBe(false);
  });
});

describe('withSessionLock', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scale-lock-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('runs the body and releases the lock', () => {
    expect(withSessionLock(dir, () => 'ran')).toBe('ran');
    expect(fs.existsSync(path.join(dir, 'session.lock'))).toBe(false);
  });

  it('refuses re-entry while the lock is held, and allows it again after', () => {
    const inner = withSessionLock(dir, () => withSessionLock(dir, () => 'nested'));
    // Contention returns null — the gate reads that as "someone else is
    // deciding", and allows rather than risking a double interruption.
    expect(inner).toBeNull();
    expect(withSessionLock(dir, () => 'after')).toBe('after');
  });

  it('releases the lock even when the body throws', () => {
    expect(() =>
      withSessionLock(dir, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(fs.existsSync(path.join(dir, 'session.lock'))).toBe(false);
  });

  it('reclaims a lock abandoned by a dead process', () => {
    const lock = path.join(dir, 'session.lock');
    fs.writeFileSync(lock, 'stale\n');
    const old = Date.now() - 60_000;
    fs.utimesSync(lock, old / 1000, old / 1000);
    expect(withSessionLock(dir, () => 'reclaimed')).toBe('reclaimed');
  });
});
