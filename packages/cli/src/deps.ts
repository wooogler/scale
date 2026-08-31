/**
 * `.scale/deps.json` → `depends_on` map edges (PLAN-GRAPHIFY P1).
 *
 * The file is produced on the SENIOR side by `scripts/distill-graph.mjs` from a
 * graphify AST extraction, and committed. Nothing here runs graphify, needs
 * Python, or touches the network — the junior's side only ever reads JSON that
 * is already in the repo.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { MapEdge } from '@scale/core';

/**
 * Minimum AST edges between two components before their dependency is worth a
 * map edge. One `imports` line across a boundary is real but weak evidence, and
 * `importance` is an in-degree count, so singletons would inflate every hub.
 * The raw counts stay in deps.json, so this can be re-tuned without re-running
 * graphify.
 */
export const DEPS_MIN_COUNT = 2;

export interface DepsFile {
  builtFromSha?: string | null;
  graphifyVersion?: string | null;
  edges?: { from?: unknown; to?: unknown; count?: unknown }[];
}

/**
 * Load `.scale/deps.json` and render it as `depends_on` map edges.
 *
 * OPTIONAL BY DESIGN: no file, or an unreadable one, yields [] and the layout is
 * exactly what it was before graphify existed. The junior never runs the
 * distiller — they only ever read what a senior committed.
 *
 * These edges live ALONGSIDE the LLM's `reference` links rather than replacing
 * them. The map keeps both because the difference between what a paper claims
 * and what the code does is the measurement (`npm run check:map`).
 */
export function loadDependsOnEdges(cwd: string, nodeIds: Set<string>): MapEdge[] {
  let deps: DepsFile;
  try {
    deps = JSON.parse(
      fs.readFileSync(path.join(cwd, '.scale', 'deps.json'), 'utf8'),
    ) as DepsFile;
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const edges: MapEdge[] = [];
  for (const e of deps.edges ?? []) {
    const from = typeof e?.from === 'string' ? e.from : null;
    const to = typeof e?.to === 'string' ? e.to : null;
    const count = typeof e?.count === 'number' ? e.count : 0;
    if (!from || !to || from === to) continue;
    if (count < DEPS_MIN_COUNT) continue;
    // A component renamed since the distillation would otherwise add an edge to
    // a node that does not exist, which the layout would count toward nothing.
    if (!nodeIds.has(from) || !nodeIds.has(to)) continue;
    const key = `${from} ${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from, to, kind: 'depends_on' });
  }
  return edges;
}
