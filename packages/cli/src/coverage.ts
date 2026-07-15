/**
 * Coverage materialization for the CLI.
 *
 * `coverage.json` is a MATERIALIZED VIEW of `evidence.jsonl` (PLAN §5 / §5.1).
 * Hooks only APPEND evidence on the hot path; coverage is (re)computed here at
 * natural points — `scale context` (SessionStart), `scale coverage recompute`,
 * `scale record`, and `scale serve` (on request when evidence is newer). This
 * module owns the impure edges (git, fs, clock); the actual fold is the PURE
 * `materializeCoverage` from `@scale/core`, so the same evidence + inputs always
 * produce a byte-identical `UserCoverage`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  ScaleConfigSchema,
  type ScaleConfig,
  type UserCoverage,
  type MapJson,
  MapJsonSchema,
  type EvidenceEntry,
  EvidenceEntrySchema,
  type LoadedScale,
  loadScaleDir,
  computeLayout,
  componentSourcesIndex,
  materializeCoverage,
  unificationProgress,
} from '@scale/core';

import {
  stateDir,
  paths,
  ensureStateDir,
  readConfigSafe,
  readCoverageSafe,
} from './state.js';

/** Best-effort short HEAD sha of the repo at `cwd`; '' when not a git repo. */
function shortHeadSha(cwd: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
  } catch {
    return '';
  }
}

/**
 * Config for materialization: the persisted config.json if present, else a
 * schema-defaulted config keyed on the current user. Falling back to defaults
 * lets `coverage recompute` / `record` work before `scale init` has been run.
 */
function readConfigOrDefault(dir: string): ScaleConfig {
  return (
    readConfigSafe(dir) ??
    ScaleConfigSchema.parse({ user: process.env.USER ?? 'user' })
  );
}

/**
 * The frozen map for `cwd`: read `.scale/map.json` if present, else compute the
 * same deterministic layout `scale map layout` would (in-memory — recompute
 * must work even before a map has been written to disk).
 */
function readMapOrCompute(cwd: string, loaded: LoadedScale): MapJson {
  try {
    const raw = fs.readFileSync(path.join(cwd, '.scale', 'map.json'), 'utf8');
    return MapJsonSchema.parse(JSON.parse(raw));
  } catch {
    // No (valid) map.json — build the layout from the loaded .scale/ tree.
  }
  return computeLayout({
    provinces: loaded.provinces,
    nodes: loaded.papers.map((p) => ({ id: p.id, province: p.province })),
    edges: loaded.edges,
    builtFromSha: shortHeadSha(cwd) || '',
  });
}

/** Read + parse evidence.jsonl, skipping malformed lines (never throws). */
function readEvidence(dir: string): EvidenceEntry[] {
  let text: string;
  try {
    text = fs.readFileSync(paths.evidence(dir), 'utf8');
  } catch {
    return [];
  }
  const out: EvidenceEntry[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(EvidenceEntrySchema.parse(JSON.parse(trimmed)));
    } catch {
      // Skip malformed/partial lines — evidence.jsonl stays the source of truth.
    }
  }
  return out;
}

/** wc -l semantics: count newline bytes in a file (0 if it doesn't exist). */
function fileLineCount(cwd: string, rel: string): number {
  try {
    const buf = fs.readFileSync(path.resolve(cwd, rel));
    let n = 0;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
    return n;
  } catch {
    return 0;
  }
}

/**
 * Sum of added+deleted lines from `git diff --numstat <sinceSha>..HEAD` limited
 * to `sources`. Returns 0 when there is no ref, no sources, or no git repo.
 */
function gitChurn(cwd: string, sinceSha: string, sources: string[]): number {
  if (!sinceSha || sources.length === 0) return 0;
  let out: string;
  try {
    out = execFileSync(
      'git',
      ['diff', '--numstat', `${sinceSha}..HEAD`, '--', ...sources],
      { cwd, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' },
    );
  } catch {
    return 0;
  }
  let total = 0;
  for (const line of out.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    const added = Number(parts[0]); // '-' (binary) → NaN, ignored
    const deleted = Number(parts[1]);
    if (Number.isFinite(added)) total += added;
    if (Number.isFinite(deleted)) total += deleted;
  }
  return total;
}

export interface RecomputeResult {
  coverage: UserCoverage;
  map: MapJson;
  loaded: LoadedScale;
  dir: string;
}

/**
 * Re-materialize coverage.json from evidence.jsonl for the repo at `cwd`, write
 * it, and return it. Steps:
 *   1. load the .scale/ tree, the frozen map, config, and evidence,
 *   2. compute per-component `sizes` (line count of sources at HEAD) — always,
 *      since it is the loyalty denominator,
 *   3. compute per-component `churn` from the *previously persisted*
 *      coverage.json's `lastValidatedSha` (git diff <sha>..HEAD over its
 *      sources). First run (no prior coverage) → churn {} → nothing goes stale,
 *   4. fold via the pure `materializeCoverage`,
 *   5. write ~/.scale/<repo-id>/coverage.json (schema-validated by core).
 */
export function recomputeCoverageFromDisk(cwd: string = process.cwd()): RecomputeResult {
  const dir = stateDir(cwd);
  const loaded = loadScaleDir(cwd);
  const map = readMapOrCompute(cwd, loaded);
  const config = readConfigOrDefault(dir);
  const evidence = readEvidence(dir);
  const head = shortHeadSha(cwd);

  const sourcesByComp = componentSourcesIndex(loaded); // { id, sources }[]
  const sourcesById = new Map(sourcesByComp.map((s) => [s.id, s.sources]));

  // sizes: always provided (denominator for loyalty = 1 − churn/size).
  const sizes: Record<string, number> = {};
  for (const { id, sources } of sourcesByComp) {
    let total = 0;
    for (const s of sources) total += fileLineCount(cwd, s);
    sizes[id] = total;
  }

  // churn: measured from the on-disk coverage.json's lastValidatedSha values, so
  // the diff starts where the component was last confirmed (see handoff note on
  // the two-phase churn dependency). Only components already stamped with a sha
  // can drift; the rest need no churn entry.
  const prev = readCoverageSafe(dir);
  const churn: Record<string, number> = {};
  if (prev) {
    for (const [id, comp] of Object.entries(prev.components)) {
      if (!comp.lastValidatedSha) continue;
      const c = gitChurn(cwd, comp.lastValidatedSha, sourcesById.get(id) ?? []);
      if (c > 0) churn[id] = c;
    }
  }

  const coverage = materializeCoverage(evidence, {
    map,
    config,
    user: config.user,
    headSha: head,
    churn,
    sizes,
    now: new Date().toISOString(),
  });

  ensureStateDir(dir);
  fs.writeFileSync(paths.coverage(dir), JSON.stringify(coverage, null, 2) + '\n');

  return { coverage, map, loaded, dir };
}

export interface CoverageCounts {
  total: number;
  validated: number;
  explored: number;
  stale: number;
  fog: number;
  /** Unification progress ∈ [0,1] (weighted mean dims over all nodes). */
  progress: number;
}

/** Tally per-state component counts + unification progress over the map nodes. */
export function coverageCounts(coverage: UserCoverage, map: MapJson): CoverageCounts {
  const counts = { total: 0, validated: 0, explored: 0, stale: 0, fog: 0 };
  for (const node of map.nodes) {
    counts.total++;
    const state = coverage.components[node.id]?.state ?? 'fog';
    counts[state]++;
  }
  return { ...counts, progress: unificationProgress(map.nodes, coverage) };
}
