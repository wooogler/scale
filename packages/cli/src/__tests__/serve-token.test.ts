/**
 * `scale serve` off loopback (PLAN-GATE §4 S3): the API demands a bearer token,
 * the static SPA does not, and a tokenless loopback server behaves as before.
 * Runs a real server on an ephemeral port and speaks HTTP to it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';

import { startServer } from '../serve.js';

let home: string;
let repo: string;
let prevHome: string | undefined;
const servers: http.Server[] = [];

function listen(opts: { token?: string; host?: string }): Promise<string> {
  return new Promise((resolve) => {
    const server = startServer({ port: 0, host: opts.host ?? '127.0.0.1', cwd: repo, token: opts.token });
    servers.push(server);
    server.once('listening', () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

beforeAll(() => {
  prevHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'scale-serve-home-'));
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'scale-serve-repo-'));
  process.env.HOME = home;
  fs.mkdirSync(path.join(repo, '.scale'), { recursive: true });
});

afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('token-guarded API', () => {
  it('refuses the API without the token, in either form', async () => {
    const base = await listen({ token: 'sekrit' });
    const bare = await fetch(`${base}/api/locks`);
    expect(bare.status).toBe(401);
    expect(bare.headers.get('www-authenticate')).toContain('Bearer');
    const wrong = await fetch(`${base}/api/locks`, { headers: { authorization: 'Bearer nope' } });
    expect(wrong.status).toBe(401);
    // The wrong token is also refused when it merely shares a prefix or length.
    const near = await fetch(`${base}/api/locks?token=sekrIt`);
    expect(near.status).toBe(401);
  });

  it('accepts the token as a header and as ?token= (the printed URL)', async () => {
    const base = await listen({ token: 'sekrit' });
    const viaHeader = await fetch(`${base}/api/locks`, { headers: { authorization: 'Bearer sekrit' } });
    expect(viaHeader.status).toBe(200);
    expect(await viaHeader.json()).toEqual({ unlocked: [], drifted: {}, pendingUnlocks: {} });
    const viaQuery = await fetch(`${base}/api/locks?token=sekrit`);
    expect(viaQuery.status).toBe(200);
  });

  it('a token-bearing request is not subject to the same-origin refusal', async () => {
    // Off loopback the page's own origin is a LAN address, which the loopback
    // allow-list would refuse; the token IS the authentication there.
    const base = await listen({ token: 'sekrit' });
    const res = await fetch(`${base}/api/locks`, {
      headers: { authorization: 'Bearer sekrit', origin: 'http://192.168.1.20:4318' },
    });
    expect(res.status).toBe(200);
  });

  it('serves the SPA shell without a token — the bundle is public code', async () => {
    const base = await listen({ token: 'sekrit' });
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('tokenless loopback is unchanged: open API, cross-origin still refused', async () => {
    const base = await listen({});
    expect((await fetch(`${base}/api/locks`)).status).toBe(200);
    const foreign = await fetch(`${base}/api/locks`, { headers: { origin: 'http://evil.example' } });
    expect(foreign.status).toBe(403);
  });
});
