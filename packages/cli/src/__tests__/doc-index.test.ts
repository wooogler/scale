/**
 * `GET /api/docs` and the `dir` field on `GET /api/doc/:id` — the two things
 * that let the viewer read a component doc as a DOCUMENT rather than as a panel.
 *
 * A doc's "Related components" links are relative folder paths, written that
 * way so the tree reads correctly on disk and on GitHub. The viewer routes by
 * STABLE frontmatter id. Folder path is the only coordinate the two share, so
 * every assertion here is really about one thing: can the browser turn
 * `../beta/` written inside `prov/alpha/README.md` back into the id `beta`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';

import { startServer } from '../serve.js';
import { DocIndexSchema } from '@scale/core';

let home: string;
let repo: string;
let prevHome: string | undefined;
let base: string;
const servers: http.Server[] = [];

function doc(dir: string, id: string, title: string, body: string): void {
  const abs = path.join(repo, '.scale', ...dir.split('/'));
  fs.mkdirSync(abs, { recursive: true });
  fs.writeFileSync(
    path.join(abs, 'README.md'),
    ['---', `id: ${id}`, `title: ${title}`, 'sources: []', 'concepts: []', 'rationale: []', '---', '', body, ''].join(
      '\n',
    ),
  );
}

beforeAll(async () => {
  prevHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'scale-docindex-home-'));
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'scale-docindex-repo-'));
  process.env.HOME = home;
  doc('prov/alpha', 'alpha', 'Alpha', '## Related components\n\n- [Beta](../beta/)\n');
  doc('prov/beta', 'beta', 'Beta', '## Summary\n\nBeta.\n');
  doc('other/gamma', 'gamma', 'Gamma', '## Summary\n\nGamma.\n');
  base = await new Promise<string>((resolve) => {
    const server = startServer({ port: 0, host: '127.0.0.1', cwd: repo });
    servers.push(server);
    server.once('listening', () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
});

afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('GET /api/docs', () => {
  it('lists every component doc with the folder its links are written from', async () => {
    const res = await fetch(`${base}/api/docs`);
    expect(res.status).toBe(200);
    const index = DocIndexSchema.parse(await res.json());
    expect(index).toEqual([
      { id: 'gamma', title: 'Gamma', province: 'other', dir: 'other/gamma' },
      { id: 'alpha', title: 'Alpha', province: 'prov', dir: 'prov/alpha' },
      { id: 'beta', title: 'Beta', province: 'prov', dir: 'prov/beta' },
    ]);
  });

  it('resolves a relative related-components link back to an id', async () => {
    const index = DocIndexSchema.parse(await (await fetch(`${base}/api/docs`)).json());
    const byDir = new Map(index.map((d) => [d.dir, d.id]));
    // `../beta/` from `prov/alpha` — the exact string the alpha doc contains.
    expect(byDir.get('prov/beta')).toBe('beta');
  });
});

describe('GET /api/doc/:id', () => {
  it('carries the doc its own folder, so one request is enough to resolve its links', async () => {
    const res = await fetch(`${base}/api/doc/alpha`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dir: string; frontmatter: { id: string }; body: string };
    expect(body.dir).toBe('prov/alpha');
    expect(body.frontmatter.id).toBe('alpha');
    expect(body.body).toContain('[Beta](../beta/)');
  });
});
