/**
 * `POST /api/doc/:id/translation` — the request surface only.
 *
 * Runs a real server on an ephemeral port and speaks HTTP to it, the same way
 * the token test does. Everything here is deliberately reachable WITHOUT an API
 * key: a 400 for a language SCALE does not render, a 404 for a component that
 * does not exist, and the `lang: 'en'` path, which is a pure read of the
 * committed doc. The translating path itself is covered in translate.test.ts
 * against a stubbed model — no test in this repo ever calls a provider.
 *
 * The method and the content-type are part of the surface under test: this is
 * the only route that can spend API money, and a GET would be reachable as a
 * sub-resource (which sends no `Origin` for the allowlist to refuse).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import crypto from 'node:crypto';

import { renderCommittedTranslation } from '@scale/core';

import { startServer } from '../serve.js';

let home: string;
let repo: string;
let prevHome: string | undefined;
const servers: http.Server[] = [];

function listen(): Promise<string> {
  return new Promise((resolve) => {
    const server = startServer({ port: 0, host: '127.0.0.1', cwd: repo });
    servers.push(server);
    server.once('listening', () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

beforeAll(() => {
  prevHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'scale-doctrans-home-'));
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'scale-doctrans-repo-'));
  process.env.HOME = home;
  const docDir = path.join(repo, '.scale', 'prov', 'alpha');
  fs.mkdirSync(docDir, { recursive: true });
  fs.writeFileSync(
    path.join(docDir, 'README.md'),
    [
      '---',
      'id: alpha',
      'title: Alpha',
      'sources:',
      '  - src/alpha.ts',
      'concepts:',
      '  - id: first-concept',
      '    name: The first idea',
      'rationale:',
      '  - decision: Do it this way',
      '    provenance: inferred',
      '---',
      '',
      '# Alpha',
      '',
      'The English body.',
      '',
    ].join('\n'),
  );
});

afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

/** POST the translation route the way the web client does. */
function post(
  base: string,
  id: string,
  body?: unknown,
  init: { headers?: Record<string, string>; contentType?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  const ct = init.contentType === undefined ? 'application/json' : init.contentType;
  if (ct !== null) headers['content-type'] = ct;
  return fetch(`${base}/api/doc/${id}/translation`, {
    method: 'POST',
    headers,
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
}

describe('POST /api/doc/:id/translation', () => {
  it("lang 'en' is the committed doc itself — no error, no model, English text", async () => {
    const base = await listen();
    const res = await post(base, 'alpha', { lang: 'en' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      lang: string;
      translated: boolean;
      error?: unknown;
      frontmatter: { id: string; title: string; sources: string[] };
      body: string;
    };
    expect(body).toMatchObject({ id: 'alpha', lang: 'en', translated: false });
    expect(body.error).toBeUndefined();
    expect(body.frontmatter).toMatchObject({ id: 'alpha', title: 'Alpha' });
    expect(body.frontmatter.sources).toEqual(['src/alpha.ts']);
    expect(body.body).toContain('The English body.');
  });

  it("defaults to the reader's configured language when `lang` is omitted", async () => {
    // No user config has been written, so the effective language is the schema
    // default — English. A bodiless POST therefore means "render this for me".
    const base = await listen();
    const res = await post(base, 'alpha', {});
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ lang: 'en', translated: false });
  });

  it('a language SCALE does not render is 400, not a silent fallback', async () => {
    const base = await listen();
    const res = await post(base, 'alpha', { lang: 'fr' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; lang: string; supported: string[] };
    expect(body.error).toBe('unsupported lang');
    expect(body.lang).toBe('fr');
    expect(body.supported).toEqual(expect.arrayContaining(['en', 'ko']));
  });

  it('an unknown component is 404, and says which id it could not find', async () => {
    const base = await listen();
    const res = await post(base, 'nope', { lang: 'en' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'unknown component', id: 'nope' });
  });

  it('the bad lang is rejected BEFORE the component is looked up', async () => {
    // Order matters for the message the caller gets: an unknown id AND an
    // unsupported lang must report the lang, which is the one the caller can
    // fix without knowing anything about this repo's components.
    const base = await listen();
    expect((await post(base, 'nope', { lang: 'fr' })).status).toBe(400);
  });

  it('refuses a request that is not application/json with 415', async () => {
    // THE point: a sub-resource request (an <img>, a <form>) cannot set this
    // content-type cross-origin without a preflight, and it is what makes the
    // Origin allowlist a sufficient gate on the one route that spends money.
    const base = await listen();
    expect((await post(base, 'alpha', 'lang=en', { contentType: null })).status).toBe(415);
    expect(
      (await post(base, 'alpha', 'lang=en', { contentType: 'application/x-www-form-urlencoded' }))
        .status,
    ).toBe(415);
    expect((await post(base, 'alpha', 'lang=en', { contentType: 'text/plain' })).status).toBe(415);
    // …and the charset parameter is not what makes it fail.
    expect(
      (await post(base, 'alpha', { lang: 'en' }, { contentType: 'application/json; charset=utf-8' }))
        .status,
    ).toBe(200);
  });

  it('a body it cannot read is 400 — the fallback for this route would be to spend money', async () => {
    const base = await listen();
    expect((await post(base, 'alpha', '{not json')).status).toBe(400);
    expect((await post(base, 'alpha', '[1,2,3]')).status).toBe(400);
    expect((await post(base, 'alpha', '"just a string"')).status).toBe(400);
  });

  it('a GET no longer reaches it: it is an unknown endpoint', async () => {
    const base = await listen();
    const res = await fetch(`${base}/api/doc/alpha/translation`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'unknown endpoint' });
  });

  it('is guarded by the same token as every other /api route', async () => {
    const server = startServer({ port: 0, host: '127.0.0.1', cwd: repo, token: 'sekrit' });
    servers.push(server);
    const base = await new Promise<string>((r) =>
      server.once('listening', () =>
        r(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
      ),
    );
    expect((await post(base, 'alpha', { lang: 'en' })).status).toBe(401);
    const ok = await post(base, 'alpha', { lang: 'en' }, {
      headers: { authorization: 'Bearer sekrit' },
    });
    expect(ok.status).toBe(200);
    // …and the cross-origin refusal applies to it too.
    const foreign = await post(base, 'alpha', { lang: 'en' }, {
      headers: { origin: 'http://evil.example' },
    });
    expect(foreign.status).toBe(401);
  });

  it('plain GET /api/doc/:id still returns the doc unchanged', async () => {
    const base = await listen();
    const res = await fetch(`${base}/api/doc/alpha`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { frontmatter: { id: string }; body: string };
    expect(body.frontmatter.id).toBe('alpha');
    expect(body.body).toContain('The English body.');
    expect((await fetch(`${base}/api/doc/nope`)).status).toBe(404);
  });
});

describe('POST /api/doc/:id/translation — a committed README.ko.md', () => {
  const KEY_VARS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];
  const saved: Record<string, string | undefined> = {};
  const docDir = (): string => path.join(repo, '.scale', 'prov', 'alpha');

  function commit(sha?: string): void {
    const english = fs.readFileSync(path.join(docDir(), 'README.md'));
    fs.writeFileSync(
      path.join(docDir(), 'README.ko.md'),
      renderCommittedTranslation({
        meta: {
          lang: 'ko',
          sourceLang: 'en',
          sourceSha: sha ?? crypto.createHash('sha256').update(english).digest('hex'),
          model: 'committed-model',
          translatedAt: '2026-10-11T00:00:00.000Z',
        },
        frontmatter: {
          id: 'alpha',
          title: '알파',
          sources: ['src/alpha.ts'],
          concepts: [{ id: 'first-concept', name: '첫 번째 아이디어' }],
          rationale: [{ decision: '이렇게 한다', provenance: 'inferred' }],
        },
        body: '\n# 알파\n\n한국어 본문.\n',
      }),
    );
  }

  beforeAll(() => {
    // "No API key configured" for real: HOME is already empty, and the env
    // fallbacks are cleared for the duration.
    for (const k of KEY_VARS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterAll(() => {
    for (const k of KEY_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(path.join(docDir(), 'README.ko.md'), { force: true });
  });

  it('is served with no key — `missing-key` never fires while a current rendering exists', async () => {
    commit();
    const base = await listen();
    const res = await post(base, 'alpha', { lang: 'ko' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown> & {
      frontmatter: { title: string; sources: string[] };
      body: string;
    };
    expect(body).toMatchObject({
      id: 'alpha',
      lang: 'ko',
      translated: true,
      cached: true,
      source: 'committed',
      model: 'committed-model',
    });
    expect(body.error).toBeUndefined();
    expect(body.frontmatter.title).toBe('알파');
    expect(body.frontmatter.sources).toEqual(['src/alpha.ts']);
    expect(body.body).toContain('한국어 본문.');
  });

  it('a STALE rendering is not served: with no key the reader gets English and the reason', async () => {
    commit('f'.repeat(64));
    const base = await listen();
    const body = (await (await post(base, 'alpha', { lang: 'ko' })).json()) as {
      translated: boolean;
      error?: { code: string };
      frontmatter: { title: string };
    };
    expect(body.translated).toBe(false);
    expect(body.error?.code).toBe('missing-key');
    expect(body.frontmatter.title).toBe('Alpha');
  });
});
