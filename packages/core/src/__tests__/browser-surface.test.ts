/**
 * `@scale/core/browser` must stay bundleable into the web SPA.
 *
 * The rule the barrel states in prose — "everything re-exported here is pure
 * and free of node builtins" — was enforced by nothing. One `import fs from
 * 'node:fs'` added to a module three hops down would break the vite build, and
 * only at build time, in a package nobody was editing. This walks the actual
 * import graph instead, so the guarantee is checked where it is made.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { gateDenyReason, quizSpecLine, ScaleConfigSchema } from '../browser.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every `from '...'` specifier in a source file. */
function importsOf(source: string): string[] {
  const out: string[] = [];
  const re = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/g;
  for (const m of source.matchAll(re)) out.push(m[1]!);
  // `import 'x'` (side-effect) and dynamic `import('x')` too.
  for (const m of source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]!);
  return out;
}

/** Resolve a relative `./x.js` specifier back to its `.ts` source. */
function resolveLocal(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const abs = path.resolve(path.dirname(fromFile), spec).replace(/\.js$/, '.ts');
  return fs.existsSync(abs) ? abs : null;
}

describe('@scale/core/browser is browser-safe', () => {
  it('pulls in no node builtin, anywhere in its import graph', () => {
    const seen = new Set<string>();
    const offenders: string[] = [];
    const walk = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      const source = fs.readFileSync(file, 'utf8');
      for (const spec of importsOf(source)) {
        if (spec.startsWith('node:') || spec === 'fs' || spec === 'path') {
          offenders.push(`${path.relative(SRC, file)} imports "${spec}"`);
          continue;
        }
        const local = resolveLocal(file, spec);
        if (local) walk(local);
      }
    };
    walk(path.join(SRC, 'browser.ts'));

    expect(offenders, offenders.join('\n')).toEqual([]);
    // Sanity: the walk actually visited the graph rather than stopping at the
    // barrel, which would make the assertion above vacuously true.
    expect(seen.size).toBeGreaterThan(8);
  });

  it('exports the gate text builders the Settings preview renders with', () => {
    // The preview must be produced by the SAME function that ships the text,
    // or it is a mock that drifts. This pins that it is reachable from the SPA.
    const config = ScaleConfigSchema.parse({ user: 'u' });
    const reason = gateDenyReason('session-management', config);
    expect(reason).toContain('session-management');
    expect(reason).toContain(quizSpecLine(config.quiz));
  });
});
