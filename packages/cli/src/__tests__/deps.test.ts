/**
 * deps.json → `depends_on` map edges (PLAN-GRAPHIFY P1).
 *
 * The invariant that matters most here is OPTIONALITY: a repo with no
 * deps.json, or an unreadable one, must lay out exactly as it did before
 * graphify existed. graphify is a senior-side build tool, and nothing on the
 * junior's path may start depending on it having been run.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadDependsOnEdges, DEPS_MIN_COUNT } from '../deps.js';

describe('loadDependsOnEdges', () => {
  let cwd: string;
  const nodes = new Set(['a', 'b', 'c']);

  const writeDeps = (body: unknown) => {
    fs.mkdirSync(path.join(cwd, '.scale'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.scale', 'deps.json'), JSON.stringify(body));
  };

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'scale-deps-'));
  });
  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('is a no-op when deps.json is absent — graphify stays optional', () => {
    expect(loadDependsOnEdges(cwd, nodes)).toEqual([]);
  });

  it('is a no-op on malformed or unexpected JSON rather than throwing', () => {
    writeDeps('not an object');
    expect(loadDependsOnEdges(cwd, nodes)).toEqual([]);
    fs.writeFileSync(path.join(cwd, '.scale', 'deps.json'), '{ broken');
    expect(loadDependsOnEdges(cwd, nodes)).toEqual([]);
    writeDeps({});
    expect(loadDependsOnEdges(cwd, nodes)).toEqual([]);
  });

  it('emits a directed depends_on edge per qualifying pair', () => {
    writeDeps({ edges: [{ from: 'a', to: 'b', count: 5 }] });
    expect(loadDependsOnEdges(cwd, nodes)).toEqual([{ from: 'a', to: 'b', kind: 'depends_on' }]);
  });

  it('drops pairs below the evidence threshold', () => {
    writeDeps({
      edges: [
        { from: 'a', to: 'b', count: DEPS_MIN_COUNT - 1 },
        { from: 'b', to: 'c', count: DEPS_MIN_COUNT },
      ],
    });
    expect(loadDependsOnEdges(cwd, nodes)).toEqual([{ from: 'b', to: 'c', kind: 'depends_on' }]);
  });

  it('drops edges naming a component that no longer exists', () => {
    // A rename between the distillation and the layout would otherwise add an
    // edge to a node the map does not have.
    writeDeps({ edges: [{ from: 'a', to: 'gone', count: 9 }] });
    expect(loadDependsOnEdges(cwd, nodes)).toEqual([]);
  });

  it('drops self-edges and de-duplicates', () => {
    writeDeps({
      edges: [
        { from: 'a', to: 'a', count: 9 },
        { from: 'a', to: 'b', count: 9 },
        { from: 'a', to: 'b', count: 3 },
      ],
    });
    expect(loadDependsOnEdges(cwd, nodes)).toEqual([{ from: 'a', to: 'b', kind: 'depends_on' }]);
  });

  it('ignores entries with missing or wrongly-typed fields', () => {
    writeDeps({
      edges: [
        { from: 'a', count: 9 },
        { to: 'b', count: 9 },
        { from: 1, to: 'b', count: 9 },
        { from: 'a', to: 'b', count: 'many' },
        null,
      ],
    });
    expect(loadDependsOnEdges(cwd, nodes)).toEqual([]);
  });
});
