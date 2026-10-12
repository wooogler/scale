/**
 * `scale map check` end to end (stage 1). The judgement itself is pure and
 * covered in core; what can only break here is the part that touches the
 * filesystem — which anchored paths count toward density, which have gone
 * missing, and whether every exit path honours `--json`.
 *
 * Shells out to the built CLI on purpose: this command's contract is its exit
 * code, and a caller (a skill, CI) sees exactly this surface.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

import { renderCommittedTranslation } from '@scale/core';

const CLI = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'dist',
  'index.js',
);

let repo: string;
let home: string;

/** Run the command; never throws, so a non-zero exit is data rather than a failure. */
function check(json = true): { code: number; out: string } {
  try {
    const out = execFileSync('node', [CLI, 'map', 'check', ...(json ? ['--json'] : [])], {
      cwd: repo,
      // An empty HOME, so the effective config is the schema defaults plus the
      // repo's own policy — never whatever the person running the suite set.
      env: { ...process.env, HOME: home, SCALE_STATE_DIR: '' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

function codes(): string[] {
  const r = check();
  const j = JSON.parse(r.out) as { findings?: { level: string; code: string }[] };
  return (j.findings ?? []).map((f) => `${f.level}:${f.code}`);
}

/** One component doc anchoring `sources`, under province `prov`. */
function doc(prov: string, id: string, sources: string[]): void {
  const dir = path.join(repo, '.scale', prov, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'README.md'),
    [
      '---',
      `id: ${id}`,
      `title: ${id}`,
      'sources:',
      ...sources.map((s) => `  - ${s}`),
      'concepts:',
      `  - id: ${id}-c`,
      '    name: A thing a junior could be asked about',
      'rationale:',
      '  - decision: A real decision',
      '    why: Because it had to be made',
      '    provenance: inferred',
      '---',
      '',
      `# ${id}`,
      '',
    ].join('\n'),
  );
}

/** A source file of `lines` lines, so the estimator sees a real repo shape. */
function source(rel: string, lines: number): void {
  const full = path.join(repo, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, Array.from({ length: lines }, (_, i) => `// line ${i}`).join('\n') + '\n');
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'scale-mapcheck-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'scale-mapcheck-home-'));
});
afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

describe('exit code is the contract', () => {
  it('a partition matching its estimate passes', () => {
    for (let i = 0; i < 6; i++) {
      source(`src/m${i}.ts`, 280);
      doc('core', `m${i}`, [`src/m${i}.ts`]);
    }
    const r = check();
    expect(r.code).toBe(0);
    expect(codes()).toEqual([]);
  });

  it('a partition finer than one component per file fails on both counts', () => {
    // Koa in miniature: one file, many components.
    source('src/big.ts', 1400);
    for (let i = 0; i < 12; i++) doc('core', `c${i}`, ['src/big.ts']);
    expect(check().code).toBe(1);
    expect(codes()).toContain('fail:unresolvable-anchors');
    expect(codes()).toContain('fail:too-fine');
  });

  it('a partition far coarser than its estimate fails', () => {
    for (let i = 0; i < 40; i++) source(`src/f${i}.ts`, 300);
    doc('core', 'only', ['src/f0.ts']);
    expect(check().code).toBe(1);
    expect(codes()).toContain('fail:too-coarse');
  });
});

describe('what counts as an anchored file', () => {
  it('a path that no longer exists warns and does not flatter the density', () => {
    for (let i = 0; i < 6; i++) {
      source(`src/m${i}.ts`, 280);
      doc('core', `m${i}`, [`src/m${i}.ts`]);
    }
    // Add a seventh component whose only anchor is gone. Were the missing path
    // counted, density would read 7/7; it must read 7/6.
    doc('core', 'ghost', ['src/deleted.ts']);
    const r = check();
    const j = JSON.parse(r.out) as { anchoredFiles: number; anchoredPaths: number; deadAnchors: string[] };
    expect(j.deadAnchors).toEqual(['src/deleted.ts']);
    expect(j.anchoredFiles).toBe(6);
    expect(j.anchoredPaths).toBe(7);
    expect(codes()).toContain('warn:stale-anchor');
    expect(r.code).toBe(0); // staleness is not unresolvability
  });

  it('non-source anchors do not dilute the density', () => {
    // Ten components over five source files is 2.0 per file. Anchoring five
    // markdown files as well would read 1.0 if every path counted.
    for (let i = 0; i < 5; i++) source(`src/s${i}.ts`, 300);
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(repo, `doc${i}.md`), '# d\n');
    for (let i = 0; i < 10; i++) {
      doc('core', `c${i}`, [`src/s${i % 5}.ts`, `doc${i % 5}.md`]);
    }
    const j = JSON.parse(check().out) as { anchoredFiles: number; anchoredPaths: number };
    expect(j.anchoredFiles).toBe(5);
    expect(j.anchoredPaths).toBe(10);
    expect(codes()).toContain('fail:unresolvable-anchors');
  });
});

describe('--json answers on every path', () => {
  it('is valid JSON when there is no coverage memory', () => {
    const r = check();
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false });
  });

  it('is valid JSON when the memory holds no component docs', () => {
    fs.mkdirSync(path.join(repo, '.scale'), { recursive: true });
    const r = check();
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false });
  });

  it('agrees with the human report', () => {
    source('src/a.ts', 300);
    doc('core', 'a', ['src/a.ts']);
    const j = JSON.parse(check(true).out) as { built: number; findings: { message: string }[] };
    const human = check(false).out;
    expect(human).toContain(`${j.built} components`);
    for (const f of j.findings) expect(human).toContain(f.message.slice(0, 40));
  });
});

describe('committed translations (docs.languages)', () => {
  /** A rendering of the doc's English bytes — or of `sha`, to fake a stale one. */
  function render(prov: string, id: string, sha?: string): void {
    const d = path.join(repo, '.scale', prov, id);
    const english = fs.readFileSync(path.join(d, 'README.md'));
    fs.writeFileSync(
      path.join(d, 'README.ko.md'),
      renderCommittedTranslation({
        meta: {
          lang: 'ko',
          sourceLang: 'en',
          sourceSha: sha ?? crypto.createHash('sha256').update(english).digest('hex'),
          model: 'm',
          translatedAt: '2026-10-11T00:00:00.000Z',
        },
        frontmatter: {
          id,
          title: `${id} (ko)`,
          sources: [`src/${id}.ts`],
          concepts: [{ id: `${id}-c`, name: '개념' }],
          rationale: [{ decision: '결정', why: '이유', provenance: 'inferred' }],
        },
        body: '\n본문.\n',
      }),
    );
  }

  function healthyRepo(): void {
    for (let i = 0; i < 6; i++) {
      source(`src/m${i}.ts`, 280);
      doc('core', `m${i}`, [`src/m${i}.ts`]);
    }
  }

  function policy(languages: string[]): void {
    fs.writeFileSync(
      path.join(repo, '.scale', 'policy.json'),
      JSON.stringify({ docs: { languages } }, null, 2),
    );
  }

  it('says nothing about translations when docs.languages is empty', () => {
    healthyRepo();
    render('core', 'm0', 'f'.repeat(64)); // a stale file nobody promised
    const r = check();
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).not.toHaveProperty('translations');
    expect(check(false).out).not.toContain('README.ko.md');
  });

  it('fails on missing and stale renderings, and names them', () => {
    healthyRepo();
    policy(['ko']);
    for (let i = 0; i < 4; i++) render('core', `m${i}`);
    render('core', 'm4', 'f'.repeat(64)); // renders an older English doc
    // m5: never rendered

    const r = check();
    expect(r.code).toBe(1);
    const j = JSON.parse(r.out) as {
      translations: Record<string, { missing: string[]; stale: string[] }>;
      findings: { level: string; code: string; message: string }[];
    };
    expect(j.translations).toEqual({ ko: { missing: ['m5'], stale: ['m4'] } });
    expect(codes()).toEqual(['fail:translation-missing', 'fail:translation-stale']);
    for (const f of j.findings) {
      expect(f.message).toContain('run: scale doc translate --lang ko --all');
    }

    const human = check(false).out;
    expect(human).toContain('README.ko.md     4/6 current, 1 missing, 1 stale');
    expect(human).toContain('FAIL');
  });

  it('passes once every rendering is current — and an English edit makes it stale again', () => {
    healthyRepo();
    policy(['ko', 'en']); // `en` is the source, never a rendering — ignored
    for (let i = 0; i < 6; i++) render('core', `m${i}`);
    const ok = check();
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.out).translations).toEqual({ ko: { missing: [], stale: [] } });

    fs.appendFileSync(path.join(repo, '.scale', 'core', 'm2', 'README.md'), '\nOne more line.\n');
    const after = check();
    expect(after.code).toBe(1);
    expect(JSON.parse(after.out).translations).toEqual({ ko: { missing: [], stale: ['m2'] } });
  });

  it('the renderings do not change the partition itself', () => {
    healthyRepo();
    const before = JSON.parse(check().out) as Record<string, unknown>;
    for (let i = 0; i < 6; i++) render('core', `m${i}`);
    const after = JSON.parse(check().out) as Record<string, unknown>;
    expect(after).toEqual(before);
  });
});
