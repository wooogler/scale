/**
 * `SCALE_STATE_DIR` — one root for every per-user file, relocatable per process.
 *
 * The point of the override is two personas of one repo on one machine (a
 * "lead" and a "member" in a test). That only holds if EVERYTHING per-user
 * follows the root — state dir, keys file, and the viewer a persona is willing
 * to adopt — so each of those is pinned here.
 */
import { afterEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';

import { scaleHome, stateDir, resolveRepoId, STATE_DIR_ENV } from '../state.js';
import { keysPath } from '../keys.js';
import { servesThisState, type HealthInfo } from '../serve-state.js';

const saved = process.env[STATE_DIR_ENV];
afterEach(() => {
  if (saved === undefined) delete process.env[STATE_DIR_ENV];
  else process.env[STATE_DIR_ENV] = saved;
});

describe('scaleHome / stateDir', () => {
  it('defaults to ~/.scale/<repo-id>', () => {
    delete process.env[STATE_DIR_ENV];
    expect(scaleHome()).toBe(path.join(os.homedir(), '.scale'));
    expect(stateDir(process.cwd())).toBe(
      path.join(os.homedir(), '.scale', resolveRepoId(process.cwd())),
    );
  });

  it('relocates the root, resolved to an absolute path, and the keys file follows', () => {
    process.env[STATE_DIR_ENV] = 'tmp/member-persona';
    const root = path.resolve('tmp/member-persona');
    expect(scaleHome()).toBe(root);
    expect(stateDir(process.cwd())).toBe(path.join(root, resolveRepoId(process.cwd())));
    expect(keysPath()).toBe(path.join(root, 'keys.json'));
  });

  it('treats a blank value as unset', () => {
    process.env[STATE_DIR_ENV] = '   ';
    expect(scaleHome()).toBe(path.join(os.homedir(), '.scale'));
  });

  it('is read per call, not cached at import', () => {
    process.env[STATE_DIR_ENV] = '/tmp/a';
    const a = stateDir(process.cwd());
    process.env[STATE_DIR_ENV] = '/tmp/b';
    expect(stateDir(process.cwd())).not.toBe(a);
  });
});

describe('servesThisState — which viewer a persona may adopt', () => {
  const cwd = process.cwd();
  const base = (): HealthInfo => ({
    ok: true,
    repoId: resolveRepoId(cwd),
    pid: 1,
    version: 'x',
    startedAt: 'now',
  });

  it('rejects another repo outright', () => {
    expect(servesThisState({ ...base(), repoId: 'other' }, cwd)).toBe(false);
  });

  it('matches on repo-id alone when the server predates stateDir in /api/health', () => {
    expect(servesThisState(base(), cwd)).toBe(true);
  });

  it("adopts a server for this repo only when it serves THIS persona's state dir", () => {
    delete process.env[STATE_DIR_ENV];
    expect(servesThisState({ ...base(), stateDir: stateDir(cwd) }, cwd)).toBe(true);
    // The lead's viewer, seen from the member persona: same repo, other root.
    process.env[STATE_DIR_ENV] = '/tmp/member';
    expect(
      servesThisState({ ...base(), stateDir: path.join(os.homedir(), '.scale', resolveRepoId(cwd)) }, cwd),
    ).toBe(false);
    expect(servesThisState({ ...base(), stateDir: stateDir(cwd) }, cwd)).toBe(true);
  });
});
