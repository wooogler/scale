/**
 * The viewer-as-a-running-thing layer (PLAN-ACCESS "Shared CLI contract"):
 * `/api/health`, `serve.json`, deep-link composition, and the reuse/adopt half
 * of `serve ensure`.
 *
 * The spawn half is deliberately NOT exercised here — a test that forks a
 * detached daemon is a test that leaks one. Everything up to the spawn decision
 * is covered by `spawn: false`, and the branch it guards is three lines.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';

import { startServer } from '../serve.js';
import {
  DEFAULT_PORT,
  agentViewerBase,
  defaultViewerUrl,
  ensureServer,
  publicViewerUrl,
  portCandidates,
  probeHealth,
  readServeState,
  resolveViewer,
  serveStatePath,
  viewerUrl,
  writeServeState,
} from '../serve-state.js';
import { buildSetupStatus } from '../setup.js';
import { keyStatus, keysPath, setKeyFromInput } from '../keys.js';
import { resolveRepoId, stateDir } from '../state.js';

let home: string;
let repo: string;
let prevHome: string | undefined;
const prevEnvKeys: Record<string, string | undefined> = {};
const servers: http.Server[] = [];

/** A real server on an ephemeral port, with the state file left to the test. */
function listen(opts: { token?: string } = {}): Promise<{ base: string; port: number }> {
  return new Promise((resolve) => {
    const server = startServer({ port: 0, host: '127.0.0.1', cwd: repo, token: opts.token });
    servers.push(server);
    server.once('listening', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ base: `http://localhost:${port}`, port });
    });
  });
}

beforeAll(() => {
  prevHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'scale-state-home-'));
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'scale-state-repo-'));
  process.env.HOME = home;
  for (const v of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) {
    prevEnvKeys[v] = process.env[v];
    delete process.env[v];
  }
  fs.mkdirSync(path.join(repo, '.scale'), { recursive: true });
});

afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  for (const [k, v] of Object.entries(prevEnvKeys)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(serveStatePath(repo), { force: true });
});

describe('viewerUrl — deep links', () => {
  const base = 'http://localhost:4318';

  it('leaves the base alone when no screen is named', () => {
    expect(viewerUrl(base)).toBe(base);
    expect(viewerUrl(base, {})).toBe(base);
  });

  it('composes the component and settings hashes', () => {
    expect(viewerUrl(base, { component: 'core-gate' })).toBe('http://localhost:4318/#/c/core-gate');
    expect(viewerUrl(base, { settings: 'gate' })).toBe('http://localhost:4318/#/settings/gate');
    expect(viewerUrl(base, { settings: '' })).toBe('http://localhost:4318/#/settings');
  });

  it('anchors a section inside the component hash', () => {
    expect(viewerUrl(base, { component: 'core-gate', section: 'design-decisions' })).toBe(
      'http://localhost:4318/#/c/core-gate/design-decisions',
    );
    expect(viewerUrl(base, { component: 'core-gate', section: 'concepts' })).toBe(
      'http://localhost:4318/#/c/core-gate/concepts',
    );
  });

  it('drops a section with nothing to anchor it to', () => {
    // A section is a place INSIDE a doc; without a component there is no doc.
    expect(viewerUrl(base, { section: 'summary' })).toBe(base);
    expect(viewerUrl(base, { settings: 'gate', section: 'summary' })).toBe(
      'http://localhost:4318/#/settings/gate',
    );
    expect(viewerUrl(base, { component: 'core-gate', section: '' })).toBe(
      'http://localhost:4318/#/c/core-gate',
    );
  });

  it('keeps a token query in the query, not the hash', () => {
    const tokened = 'http://192.168.1.20:4318/?token=abc123';
    expect(viewerUrl(tokened, { component: 'x' })).toBe(
      'http://192.168.1.20:4318/?token=abc123#/c/x',
    );
  });

  it('returns a base it cannot parse unchanged rather than losing the link', () => {
    expect(viewerUrl('not a url', { component: 'x' })).toBe('not a url');
  });

  it('defaults to the documented port', () => {
    expect(defaultViewerUrl()).toBe(`http://localhost:${DEFAULT_PORT}`);
    expect(portCandidates(DEFAULT_PORT)).toEqual([
      4318, 4319, 4320, 4321, 4322, 4323, 4324, 4325, 4326, 4327, 4328,
    ]);
    // A preferred port inside the walk range is never tried twice.
    expect(portCandidates(4320).filter((p) => p === 4320)).toHaveLength(1);
  });
});

describe('publicViewerUrl — what an agent is allowed to read', () => {
  it('drops the token query and nothing else', () => {
    expect(publicViewerUrl('http://192.168.1.20:4318/?token=abc123')).toBe(
      'http://192.168.1.20:4318/',
    );
    expect(publicViewerUrl('http://192.168.1.20:4318/?token=abc123#/c/core-gate')).toBe(
      'http://192.168.1.20:4318/#/c/core-gate',
    );
  });

  it('leaves a token-free URL byte-for-byte alone (no trailing-slash normalising)', () => {
    expect(publicViewerUrl('http://localhost:4318')).toBe('http://localhost:4318');
    expect(publicViewerUrl('http://localhost:4318/#/settings/gate')).toBe(
      'http://localhost:4318/#/settings/gate',
    );
    expect(publicViewerUrl('not a url')).toBe('not a url');
  });

  it('keeps the token out of the gate link and the missing-key message', () => {
    writeServeState(
      {
        pid: 1,
        port: 4318,
        host: '0.0.0.0',
        url: 'http://192.168.1.20:4318/?token=sekrit',
        startedAt: '',
        idleMinutes: null,
        version: 'test',
      },
      repo,
    );
    // Exactly what the edit gate hands `gateDenyReason`, and what
    // MissingKeyError prints.
    const base = agentViewerBase(repo);
    expect(base).not.toContain('token=');
    expect(base).toBe('http://192.168.1.20:4318/');
    expect(viewerUrl(base, { component: 'core-gate' })).toBe(
      'http://192.168.1.20:4318/#/c/core-gate',
    );
  });

  it('falls back to the default URL when nothing is recorded', () => {
    expect(agentViewerBase(repo)).toBe(defaultViewerUrl());
  });
});

describe('/api/health', () => {
  it('answers with the contract shape, unauthenticated, on a token-guarded server', async () => {
    const { base } = await listen({ token: 'sekrit' });
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.repoId).toBe(resolveRepoId(repo));
    expect(body.pid).toBe(process.pid);
    expect(typeof body.version).toBe('string');
    expect(typeof body.startedAt).toBe('string');
    // Everything else on that server still demands the token.
    expect((await fetch(`${base}/api/locks`)).status).toBe(401);
  });
});

describe('serve.json', () => {
  it('reads back what was written, and refuses junk', () => {
    expect(readServeState(repo)).toBeNull();
    writeServeState(
      {
        pid: 4242,
        port: 4318,
        host: '127.0.0.1',
        url: 'http://localhost:4318',
        startedAt: '2026-01-01T00:00:00.000Z',
        idleMinutes: 240,
        version: '1.2.3',
      },
      repo,
    );
    expect(readServeState(repo)).toMatchObject({ pid: 4242, port: 4318, idleMinutes: 240 });
    expect(fs.existsSync(path.join(stateDir(repo), 'serve.json'))).toBe(true);

    fs.writeFileSync(serveStatePath(repo), '{not json');
    expect(readServeState(repo)).toBeNull();
    fs.writeFileSync(serveStatePath(repo), JSON.stringify({ pid: 1 }));
    expect(readServeState(repo)).toBeNull(); // no port → nothing to reach
  });
});

describe('resolveViewer / ensureServer — reuse and adopt', () => {
  it('falls back to the default URL when nothing is running', async () => {
    const view = await resolveViewer(repo, { settings: 'general' }, 150);
    expect(view).toEqual({
      url: `http://localhost:${DEFAULT_PORT}/#/settings/general`,
      running: false,
      port: DEFAULT_PORT,
    });
  });

  it('reports a live server recorded in serve.json as running', async () => {
    const { base, port } = await listen();
    writeServeState(
      {
        pid: process.pid,
        port,
        host: '127.0.0.1',
        url: base,
        startedAt: new Date().toISOString(),
        idleMinutes: null,
        version: 'test',
      },
      repo,
    );
    const view = await resolveViewer(repo, { component: 'a-b' }, 1000);
    expect(view).toEqual({ url: `${base}/#/c/a-b`, running: true, port });

    const reused = await ensureServer({ cwd: repo, port, spawn: false });
    expect(reused).toMatchObject({ started: false, reused: true, port });
  });

  it('ignores a serve.json whose server is gone, and deletes it', async () => {
    // A port we held and released: as close to "certainly free" as a test gets,
    // and unlike `port + 1` it cannot collide with a sibling test's server.
    const dead = await new Promise<number>((resolve) => {
      const s = startServer({ port: 0, host: '127.0.0.1', cwd: repo });
      s.once('listening', () => {
        const { port } = s.address() as AddressInfo;
        s.close(() => resolve(port));
      });
    });
    writeServeState(
      {
        pid: 999999,
        port: dead,
        host: '127.0.0.1',
        url: `http://localhost:${dead}`,
        startedAt: '',
        idleMinutes: null,
        version: 'test',
      },
      repo,
    );
    // Not running — but the URL still points at the port the viewer was last
    // on (and comes back on), not at the default 4318 that nothing is using.
    const view = await resolveViewer(repo, { component: 'a' }, 150);
    expect(view).toEqual({
      url: `http://localhost:${dead}/#/c/a`,
      running: false,
      port: dead,
    });
    // …and ensure, told not to spawn, reports the free port it would have used.
    const res = await ensureServer({ cwd: repo, port: dead, spawn: false });
    expect(res).toMatchObject({ started: false, reused: false, port: dead });
    expect(readServeState(repo)).toBeNull();
  });

  it('adopts a live server found by walking, rewriting serve.json', async () => {
    const { port } = await listen();
    const res = await ensureServer({ cwd: repo, port, spawn: false });
    expect(res).toMatchObject({ reused: true, started: false, port });
    expect(readServeState(repo)).toMatchObject({ port, pid: process.pid });
  });

  it('reuses without touching the token the server recorded', async () => {
    const { base, port } = await listen({ token: 'sekrit' });
    const tokened = `${base}/?token=sekrit`;
    writeServeState(
      {
        pid: process.pid,
        port,
        host: '127.0.0.1',
        url: tokened,
        startedAt: new Date().toISOString(),
        idleMinutes: null,
        version: 'test',
      },
      repo,
    );
    const res = await ensureServer({ cwd: repo, port, spawn: false });
    expect(res.url).toBe(tokened);
    expect(readServeState(repo)?.url).toBe(tokened);
  });

  it('adopts without destroying the token, when the first probe missed the server', async () => {
    // The state file names a host the server does not answer on, so `ensure`
    // falls through to the port walk and ADOPTS the very server it was already
    // recording. Before the fix that branch rewrote serve.json with a bare
    // origin, locking the user out of an off-loopback viewer for good.
    const { base, port } = await listen({ token: 'sekrit' });
    const tokened = `${base}/?token=sekrit`;
    writeServeState(
      {
        pid: process.pid,
        port,
        host: '127.0.0.2', // loopback, but not the address we bound
        url: tokened,
        startedAt: new Date().toISOString(),
        idleMinutes: null,
        version: 'test',
      },
      repo,
    );
    const res = await ensureServer({ cwd: repo, port, host: '127.0.0.1', spawn: false });
    expect(res).toMatchObject({ reused: true, started: false, port });
    expect(res.url).toBe(tokened);
    expect(readServeState(repo)?.url).toBe(tokened);
    // And the deep link the human gets still carries it, in the query.
    expect(viewerUrl(res.url, { component: 'foo' })).toBe(`${tokened}#/c/foo`);
    // While the agent-facing copy of the same state does not.
    expect(agentViewerBase(repo)).not.toContain('token=');
  });

  it('never takes long, even with nothing listening anywhere', async () => {
    const started = Date.now();
    await resolveViewer(repo, {}, 200);
    await ensureServer({ cwd: repo, port: 4318, spawn: false }).catch(() => undefined);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe('keys set — stdin only', () => {
  it('stores the trimmed key without touching argv, and reports only a boolean', () => {
    const argvBefore = [...process.argv];
    setKeyFromInput('anthropic', 'sk-ant-secret-value\n');
    expect(process.argv).toEqual(argvBefore);
    expect(keyStatus().anthropic.configured).toBe(true);
    const stored = JSON.parse(fs.readFileSync(keysPath(), 'utf8')) as Record<string, string>;
    expect(stored.anthropic).toBe('sk-ant-secret-value'); // trailing newline gone
    // The file lives under the test HOME, owner-only.
    expect(keysPath().startsWith(home)).toBe(true);
    expect(fs.statSync(keysPath()).mode & 0o777).toBe(0o600);
    setKeyFromInput('anthropic', '');
    expect(keyStatus().anthropic.configured).toBe(false);
  });
});

describe('setup status', () => {
  it('has the contract shape and reads a first-run repo honestly', async () => {
    const s = await buildSetupStatus(repo);
    expect(Object.keys(s).sort()).toEqual([
      'gate',
      'initialized',
      'keyPresent',
      'language',
      'memory',
      'provider',
      'repoId',
      'stateDir',
      'user',
      'viewer',
    ]);
    expect(s.repoId).toBe(resolveRepoId(repo));
    expect(s.stateDir).toBe(stateDir(repo));
    expect(s.initialized).toBe(false);
    expect(s.user).toBeNull();
    expect(s.memory).toEqual({ present: false, components: 0 });
    expect(s.provider).toBe('anthropic');
    expect(s.keyPresent).toBe(false);
    expect(Object.keys(s.gate).sort()).toEqual(['assessment', 'enforcement', 'modality']);
    expect(s.viewer.running).toBe(false);
    expect(s.viewer.url).toBe(defaultViewerUrl());
  });

  it('reports the viewer without its token — this JSON reaches the transcript', async () => {
    const { base, port } = await listen({ token: 'sekrit' });
    writeServeState(
      {
        pid: process.pid,
        port,
        host: '127.0.0.1',
        url: `${base}/?token=sekrit`,
        startedAt: new Date().toISOString(),
        idleMinutes: null,
        version: 'test',
      },
      repo,
    );
    const s = await buildSetupStatus(repo);
    expect(s.viewer.running).toBe(true);
    expect(s.viewer.url).toBe(`${base}/`);
    expect(JSON.stringify(s)).not.toContain('token=');
  });

  it('reflects a written config and a stored key', async () => {
    const dir = stateDir(repo);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ user: 'jun', language: 'ko', gate: { enforcement: 'hard' } }),
    );
    setKeyFromInput('anthropic', 'sk-ant-x');
    const s = await buildSetupStatus(repo);
    expect(s.initialized).toBe(true);
    expect(s.user).toBe('jun');
    expect(s.language).toBe('ko');
    expect(s.gate.enforcement).toBe('hard');
    expect(s.keyPresent).toBe(true);
    setKeyFromInput('anthropic', '');
    fs.rmSync(path.join(dir, 'config.json'), { force: true });
  });
});

describe('probeHealth', () => {
  it('reads nothing on a dead port as "not ours", quickly', async () => {
    const started = Date.now();
    expect(await probeHealth('http://127.0.0.1:1', 200)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1500);
  });
});
