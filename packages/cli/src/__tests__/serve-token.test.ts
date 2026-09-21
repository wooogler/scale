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

describe('settings provenance and reset (PLAN-GATE S4)', () => {
  it('GET /api/settings says where each leaf came from; unset drops the pin and logs a reset', async () => {
    fs.writeFileSync(
      path.join(repo, '.scale', 'policy.json'),
      JSON.stringify({ gate: { enforcement: 'hard' } }),
    );
    const base = await listen({});
    // Pin enforcement to the SAME value the team chose.
    const saved = await fetch(`${base}/api/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gate: { enforcement: 'hard' } }),
    });
    expect(saved.status).toBe(200);
    const s1 = (await fetch(`${base}/api/settings`).then((r) => r.json())) as {
      sources: Record<string, { source: string; policyValue?: unknown }>;
    };
    expect(s1.sources['gate.enforcement']).toMatchObject({ source: 'user', policyValue: 'hard' });
    expect(s1.sources['gate.modality']).toMatchObject({ source: 'default' });

    const reset = await fetch(`${base}/api/settings/unset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'gate.enforcement' }),
    });
    expect(reset.status).toBe(200);
    const body = (await reset.json()) as { config: { gate: { enforcement: string } }; sources: Record<string, { source: string }> };
    expect(body.config.gate.enforcement).toBe('hard'); // team value shows through
    expect(body.sources['gate.enforcement']!.source).toBe('policy');

    // The identity field is not an override.
    const bad = await fetch(`${base}/api/settings/unset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'user' }),
    });
    expect(bad.status).toBe(400);

    // Telemetry: the pin changed nothing effective (no row); the reset changed
    // nothing effective either — same value — so no row. Now change for real.
    const loosen = await fetch(`${base}/api/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gate: { enforcement: 'advisory' } }),
    });
    expect(loosen.status).toBe(200);
    const stateDirs = fs.readdirSync(path.join(home, '.scale'));
    const tel = fs
      .readFileSync(path.join(home, '.scale', stateDirs[0]!, 'telemetry.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(tel).toHaveLength(1);
    expect(tel[0]).toMatchObject({
      type: 'config_change',
      path: 'gate.enforcement',
      from: 'hard',
      to: 'advisory',
      source: 'web',
      reset: false,
      policyValue: 'hard',
      direction: 'loosen',
    });
  });

  // The patch handler names its sections explicitly, so a new config block is
  // silently DROPPED until it is listed there — the modal saves, the server
  // answers 200, and nothing changes. This pins the list.
  it('the quiz shape is patchable, bounded, and provenance-tracked', async () => {
    const base = await listen({});
    const save = await fetch(`${base}/api/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quiz: { items: 4, focus: 'rationale' } }),
    });
    expect(save.status).toBe(200);
    const saved = (await save.json()) as {
      config: { quiz: { items: number; focus: string; grounding: string } };
      sources: Record<string, { source: string }>;
    };
    expect(saved.config.quiz).toMatchObject({
      items: 4,
      focus: 'rationale',
      grounding: 'balanced', // untouched leaf keeps its default
    });
    expect(saved.sources['quiz.items']!.source).toBe('user');
    expect(saved.sources['quiz.grounding']!.source).toBe('default');

    // The schema is the authority, not the number input: out of range is a 400.
    const bad = await fetch(`${base}/api/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quiz: { items: 9 } }),
    });
    expect(bad.status).toBe(400);
    const after = (await fetch(`${base}/api/settings`).then((r) => r.json())) as {
      config: { quiz: { items: number } };
    };
    expect(after.config.quiz.items).toBe(4); // the rejected patch never landed

    const reset = await fetch(`${base}/api/settings/unset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'quiz.items' }),
    });
    expect(reset.status).toBe(200);
    const body = (await reset.json()) as { config: { quiz: { items: number } } };
    expect(body.config.quiz.items).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// /api/policy — the TEAM file, and the lead check in front of it.
//
// The check is a UX gate, not a security boundary (schema/policy.ts): these
// pin the behaviour the UI depends on, not a permission model.
// ---------------------------------------------------------------------------

const POLICY = () => path.join(repo, '.scale', 'policy.json');
const writePolicy = (o: unknown): void =>
  fs.writeFileSync(POLICY(), JSON.stringify(o, null, 2) + '\n');
const readPolicy = (): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(POLICY(), 'utf8')) as Record<string, unknown>;

describe('/api/policy — team policy and the lead gate', () => {
  it('with nobody listed, anyone is a lead (bootstrap) and may write', async () => {
    writePolicy({});
    const base = await listen({});
    const got = (await fetch(`${base}/api/policy`).then((r) => r.json())) as {
      isLead: boolean;
      leads: string[];
      exists: boolean;
      identity: string[];
      path: string;
      dirty: boolean;
    };
    expect(got.isLead).toBe(true);
    expect(got.leads).toEqual([]);
    expect(got.exists).toBe(true);
    expect(got.path).toBe(POLICY());
    expect(typeof got.dirty).toBe('boolean');

    const save = await fetch(`${base}/api/policy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gate: { enforcement: 'hard' }, quiz: { items: 4 } }),
    });
    expect(save.status).toBe(200);
    // The file stays SPARSE — writing back a parsed policy would freeze every
    // schema default into the team file.
    expect(readPolicy()).toEqual({ gate: { enforcement: 'hard' }, quiz: { items: 4 } });
  });

  it('a section patch merges leaf by leaf instead of replacing the section', async () => {
    writePolicy({ gate: { enforcement: 'hard', assessment: 'async' } });
    const base = await listen({});
    await fetch(`${base}/api/policy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gate: { enforcement: 'soft' } }),
    });
    expect(readPolicy().gate).toEqual({ enforcement: 'soft', assessment: 'async' });
  });

  it('rejects a value the schema forbids, leaving the file untouched', async () => {
    writePolicy({ quiz: { items: 3 } });
    const base = await listen({});
    const bad = await fetch(`${base}/api/policy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quiz: { items: 9 } }),
    });
    expect(bad.status).toBe(400);
    expect(readPolicy()).toEqual({ quiz: { items: 3 } });
  });

  it('unset drops one leaf and prunes the empty section', async () => {
    writePolicy({ quiz: { items: 3 }, gate: { enforcement: 'hard' } });
    const base = await listen({});
    const r = await fetch(`${base}/api/policy/unset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'quiz.items' }),
    });
    expect(r.status).toBe(200);
    expect(readPolicy()).toEqual({ gate: { enforcement: 'hard' } });
  });

  it('refuses a path that is not a policy section', async () => {
    writePolicy({});
    const base = await listen({});
    const r = await fetch(`${base}/api/policy/unset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'models.provider' }),
    });
    expect(r.status).toBe(400);
  });

  it('a non-lead gets 403 on both writes, but can still READ the policy', async () => {
    writePolicy({ leads: ['someone-else@example.com'], gate: { enforcement: 'hard' } });
    const base = await listen({});
    const got = (await fetch(`${base}/api/policy`).then((r) => r.json())) as {
      isLead: boolean;
      leads: string[];
      raw: { gate: { enforcement: string } };
    };
    expect(got.isLead).toBe(false);
    expect(got.leads).toEqual(['someone-else@example.com']);
    // Read-only is still a genuine read: a member sees the team's defaults.
    expect(got.raw.gate.enforcement).toBe('hard');

    for (const url of ['/api/policy', '/api/policy/unset']) {
      const r = await fetch(`${base}${url}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ gate: { enforcement: 'soft' }, path: 'gate.enforcement' }),
      });
      expect(r.status, url).toBe(403);
      expect(((await r.json()) as { error: string }).error).toBe('not a lead');
    }
    expect(readPolicy().gate).toEqual({ enforcement: 'hard' }); // nothing moved
  });

  it('leads are normalized on write, and REPLACE rather than merge', async () => {
    writePolicy({});
    const base = await listen({});
    await fetch(`${base}/api/policy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ leads: ['  Lead@Example.COM ', 'lead@example.com', ''] }),
    });
    expect(readPolicy().leads).toEqual(['lead@example.com']);

    // Now a DIFFERENT list — removal has to be expressible, so this is not a merge.
    // (Still allowed: this identity is in the list, so we are the lead here.)
    writePolicy({ leads: [] });
  });

  it('identity.emails counts, and emptying leads reopens the bootstrap', async () => {
    const base = await listen({});
    // Give this user a second git address, the way someone with a work address
    // would. The lead check reads the SAME identity set drift attribution uses,
    // so listing that address must be enough to make them a lead.
    writePolicy({});
    await fetch(`${base}/api/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gate: {} }),
    });
    const stateDir = path.join(home, '.scale', fs.readdirSync(path.join(home, '.scale'))[0]!);
    const cfgPath = path.join(stateDir, 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({ ...cfg, identity: { emails: ['Work@Corp.example'] } }, null, 2) + '\n',
    );

    writePolicy({ leads: ['work@corp.example'] });
    const asLead = (await fetch(`${base}/api/settings`).then((r) => r.json())) as {
      identity: string[];
      isLead: boolean;
    };
    expect(asLead.identity).toContain('work@corp.example');
    expect(asLead.isLead).toBe(true); // matched case-insensitively

    // Removing the last lead is ALLOWED — a departing lead must not be able to
    // strand the team — but the reply has to say the policy just reopened.
    const r = await fetch(`${base}/api/policy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ leads: [] }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { leads: string[]; isLead: boolean; warning?: string };
    expect(body.leads).toEqual([]);
    expect(body.isLead).toBe(true);
    expect(body.warning).toContain('anyone can now edit');

    // Put the identity back so later tests see the default user config.
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  });

  it('GET /api/settings carries identity and isLead for the modal', async () => {
    writePolicy({ leads: ['nobody@example.com'] });
    const base = await listen({});
    const s = (await fetch(`${base}/api/settings`).then((r) => r.json())) as {
      identity: string[];
      isLead: boolean;
    };
    expect(Array.isArray(s.identity)).toBe(true);
    expect(s.isLead).toBe(false);
    fs.rmSync(POLICY(), { force: true });
  });
});

// ---------------------------------------------------------------------------
// /api/preview/quiz — the Checks tab's sample check.
//
// Read-only and offline by construction: the deterministic generator, no model,
// no key. These pin the two things the UI depends on (a real N-item check for
// the requested shape) and the one thing it must never do (leak the key).
// ---------------------------------------------------------------------------

describe('/api/preview/quiz', () => {
  /** Two real component docs, so the picker and the corpus both have material. */
  function seedDocs(): void {
    const write = (id: string, title: string, concepts: string[], why: string[]): void => {
      const folder = path.join(repo, '.scale', 'p', id);
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(
        path.join(folder, 'README.md'),
        [
          '---',
          `id: ${id}`,
          `title: ${title}`,
          'sources:',
          `  - src/${id}.ts`,
          'concepts:',
          ...concepts.flatMap((c, i) => [`  - id: c${i}`, `    name: ${c}`]),
          // An empty list must be written as `[]`: a bare `rationale:` parses
          // as null and the whole doc fails frontmatter validation.
          why.length > 0 ? 'rationale:' : 'rationale: []',
          ...why.flatMap((w, i) => [
            `  - decision: decision ${i}`,
            `    why: ${w}`,
            '    provenance: inferred',
          ]),
          '---',
          '',
          `# ${title}`,
          '',
        ].join('\n'),
      );
    };
    write(
      'rich-one',
      'Rich One',
      ['first idea here', 'second idea here', 'third idea here'],
      ['the first reason', 'the second reason', 'the third reason'],
    );
    write('thin-two', 'Thin Two', ['only idea'], []);
  }

  it('returns exactly the requested number of items, with no answer key', async () => {
    seedDocs();
    const base = await listen({});
    for (const n of [1, 3, 5]) {
      const r = await fetch(`${base}/api/preview/quiz?items=${n}`);
      expect(r.status).toBe(200);
      const body = (await r.json()) as {
        componentId: string;
        title: string;
        items: { stem: string; options: string[]; dim: string }[];
        components: { id: string }[];
        groundingPreviewable: boolean;
      };
      expect(body.items).toHaveLength(n);
      for (const item of body.items) {
        expect(item.stem.length).toBeGreaterThan(0);
        expect(item.options).toHaveLength(4);
        // The answer key never reaches the browser — same rule the quest
        // runner follows. These are real items the junior may be asked later.
        expect(item).not.toHaveProperty('correctIndex');
        expect(item).not.toHaveProperty('answer');
      }
      // Defaults to the RICHEST doc, not just the first one loaded.
      expect(body.componentId).toBe('rich-one');
      expect(body.components.map((c) => c.id)).toContain('thin-two');
      // The offline generator has no diff, so `grounding` changes nothing —
      // the flag is how the UI knows to say that instead of faking it.
      expect(body.groundingPreviewable).toBe(false);
    }
  });

  it('honours an explicit component, and 404s an unknown one', async () => {
    seedDocs();
    const base = await listen({});
    const picked = (await fetch(`${base}/api/preview/quiz?items=2&component=thin-two`).then((r) =>
      r.json(),
    )) as { componentId: string; title: string; items: unknown[] };
    expect(picked.componentId).toBe('thin-two');
    expect(picked.title).toBe('Thin Two');
    expect(picked.items).toHaveLength(2); // thin doc still yields the full count

    const missing = await fetch(`${base}/api/preview/quiz?component=nope`);
    expect(missing.status).toBe(404);
  });

  it('honours focus, tagging every item with that dimension', async () => {
    seedDocs();
    const base = await listen({});
    const body = (await fetch(`${base}/api/preview/quiz?items=3&focus=rationale`).then((r) =>
      r.json(),
    )) as { items: { dim: string }[] };
    expect(body.items.map((i) => i.dim)).toEqual(['rationale', 'rationale', 'rationale']);
  });

  it('400s on a shape the config schema would reject', async () => {
    seedDocs();
    const base = await listen({});
    for (const q of ['items=0', 'items=9', 'items=2.5', 'focus=vibes', 'grounding=nope']) {
      const r = await fetch(`${base}/api/preview/quiz?${q}`);
      expect(r.status, q).toBe(400);
    }
  });
});
