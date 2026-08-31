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

  it('adopts a session that just started — a second window joins it', () => {
    expect(isSessionAdoptable(defaultSession('win-b', at(5 * MINUTE)))).toBe(true);
  });

  it('expires a session that has been quiet past the window', () => {
    expect(isSessionAdoptable(defaultSession('old', at(5 * HOUR)))).toBe(false);
  });

  it('measures from the last intervention, not the start', () => {
    // Started long ago but interrupted a minute ago: still the same work period,
    // so the budget must not refill under the junior's hands.
    const session = {
      ...defaultSession('long-running', at(5 * HOUR)),
      interventionsThisSession: 2,
      lastInterventionAt: at(1 * MINUTE),
    };
    expect(isSessionAdoptable(session)).toBe(true);
  });

  it('treats an unparseable record as expired rather than adopting it', () => {
    expect(isSessionAdoptable({ ...defaultSession('x', 'not-a-date') })).toBe(false);
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
