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

const CLI = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'dist',
  'index.js',
);

let repo: string;

/** Run the command; never throws, so a non-zero exit is data rather than a failure. */
function check(json = true): { code: number; out: string } {
  try {
    const out = execFileSync('node', [CLI, 'map', 'check', ...(json ? ['--json'] : [])], {
      cwd: repo,
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

/** One component paper anchoring `sources`, under province `prov`. */
function paper(prov: string, id: string, sources: string[]): void {
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
});
afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('exit code is the contract', () => {
  it('a partition matching its estimate passes', () => {
    for (let i = 0; i < 6; i++) {
      source(`src/m${i}.ts`, 280);
      paper('core', `m${i}`, [`src/m${i}.ts`]);
    }
    const r = check();
    expect(r.code).toBe(0);
    expect(codes()).toEqual([]);
  });

  it('a partition finer than one component per file fails on both counts', () => {
    // Koa in miniature: one file, many components.
    source('src/big.ts', 1400);
    for (let i = 0; i < 12; i++) paper('core', `c${i}`, ['src/big.ts']);
    expect(check().code).toBe(1);
    expect(codes()).toContain('fail:unresolvable-anchors');
    expect(codes()).toContain('fail:too-fine');
  });

  it('a partition far coarser than its estimate fails', () => {
    for (let i = 0; i < 40; i++) source(`src/f${i}.ts`, 300);
    paper('core', 'only', ['src/f0.ts']);
    expect(check().code).toBe(1);
    expect(codes()).toContain('fail:too-coarse');
  });
});

describe('what counts as an anchored file', () => {
  it('a path that no longer exists warns and does not flatter the density', () => {
    for (let i = 0; i < 6; i++) {
      source(`src/m${i}.ts`, 280);
      paper('core', `m${i}`, [`src/m${i}.ts`]);
    }
    // Add a seventh component whose only anchor is gone. Were the missing path
    // counted, density would read 7/7; it must read 7/6.
    paper('core', 'ghost', ['src/deleted.ts']);
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
      paper('core', `c${i}`, [`src/s${i % 5}.ts`, `doc${i % 5}.md`]);
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

  it('is valid JSON when the memory holds no component papers', () => {
    fs.mkdirSync(path.join(repo, '.scale'), { recursive: true });
    const r = check();
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false });
  });

  it('agrees with the human report', () => {
    source('src/a.ts', 300);
    paper('core', 'a', ['src/a.ts']);
    const j = JSON.parse(check(true).out) as { built: number; findings: { message: string }[] };
    const human = check(false).out;
    expect(human).toContain(`${j.built} components`);
    for (const f of j.findings) expect(human).toContain(f.message.slice(0, 40));
  });
});
