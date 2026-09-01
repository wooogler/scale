/**
 * Coverage materialization for the CLI.
 *
 * `coverage.json` is a MATERIALIZED VIEW of `evidence.jsonl` (PLAN §5 / §5.1).
 * Hooks only APPEND evidence on the hot path; coverage is (re)computed here at
 * natural points — `scale context` (SessionStart), `scale coverage recompute`,
 * `scale record`, and `scale serve` (on request when evidence is newer). This
 * module owns the impure edges (git, fs, clock); the fold and the drift pass are
 * the PURE `foldEvidence` / `recomputeDrift` from `@scale/core`, so the same
 * evidence + inputs always produce a byte-identical `UserCoverage`.
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
  foldEvidence,
  type ComponentChurn,
  recomputeDrift,
  finalizeCoverage,
  unificationProgress,
} from '@scale/core';

import {
  stateDir,
  paths,
  ensureStateDir,
  readConfigSafe,
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
 * The git identities that are THIS user: `git config user.email` plus any extra
 * addresses they listed in `identity.emails` (a work address, a GitHub
 * `users.noreply`). Lower-cased, because git addresses are case-insensitive in
 * practice and people type them both ways.
 *
 * An EMPTY set means we could not establish who the user is. Attribution then
 * treats every commit as SELF (see {@link gitChurnByAuthor}) — rebellion fires
 * only under the much higher self bar. That direction is deliberate: the other
 * one would lock a person out of their own codebase because their laptop had no
 * `user.email`, and a deployment study cannot afford that failure.
 */
export function myIdentities(cwd: string, config: ScaleConfig): Set<string> {
  const out = new Set<string>();
  try {
    const email = execFileSync('git', ['config', 'user.email'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
    if (email) out.add(email.toLowerCase());
  } catch {
    /* no git identity configured — see the note above */
  }
  for (const e of config.identity.emails) {
    if (typeof e === 'string' && e.trim()) out.add(e.trim().toLowerCase());
  }
  return out;
}

/**
 * Every repo-relative path touched by ANY commit between the oldest of
 * `anchors` and HEAD — a true superset of what any single component could have
 * churned, since every anchor's commit range is a subset of that one.
 *
 * The union of COMMITS, deliberately, not `git diff --name-only`. A net diff
 * omits a file that was changed and then reverted inside the range, while a
 * nearer anchor can still see it as changed — measured on this repo, the net
 * form broke the superset property for 17 of 24 anchor depths, which would have
 * silently skipped components that really had churned. Skipping a component is
 * the one error this function must never make.
 *
 * Returns null when the answer is unknown (no anchors, not a git repo, an anchor
 * git cannot resolve). Null means "do not skip anything": the caller then walks
 * every component, which is the correct fail-open — a redundant walk only costs
 * milliseconds, whereas a wrong skip hides a rebellion.
 */
function changedFilesSince(cwd: string, anchors: string[]): Set<string> | null {
  const unique = [...new Set(anchors.filter(Boolean))];
  if (unique.length === 0) return null;
  let oldest: string;
  try {
    // `rev-list --topo-order` puts the oldest of the set last. A sha that does
    // not resolve (a squashed or rebased-away commit) makes this throw, and we
    // fall back to walking everything.
    const out = execFileSync('git', ['rev-list', '--no-walk=sorted', '--topo-order', ...unique], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
    const lines = out.split('\n').filter(Boolean);
    if (lines.length === 0) return null;
    oldest = lines[lines.length - 1]!;
  } catch {
    return null;
  }
  try {
    const out = execFileSync('git', ['log', '--name-only', '--format=', `${oldest}..HEAD`], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
    return new Set(out.split('\n').map((s) => s.trim()).filter(Boolean));
  } catch {
    return null;
  }
}

/** One `C<sha>\t<author-email>` header line emitted by the log format below. */
const COMMIT_HEADER = /^C([0-9a-f]{7,40})\t(.*)$/;

/**
 * Churn on `sources` since `sinceSha`, split by commit authorship.
 *
 * ONE `git log --numstat` call per component — the same call count the old
 * net-diff version had. Per-commit output is what makes attribution possible at
 * all: `git diff a..b` gives a net diff that belongs to no one.
 *
 * Three git behaviors this relies on, each verified against a real repo:
 *  - MERGES are omitted from `--numstat` by default, so a teammate's work stays
 *    attributed to the commit they authored rather than to whoever merged the
 *    PR. That is exactly the semantics a team needs.
 *  - AUTHOR (`%aE`), not committer: a rebase or a squash-merge rewrites the
 *    committer, and the person who wrote the code is the one whose change the
 *    user has not read.
 *  - A RENAME into one of `sources` reads as a whole-file add, and the file's
 *    history before the rename is invisible to the pathspec. Left as-is: if a
 *    teammate moved code the paper anchors, that paper's anchor is stale too,
 *    and flagging the component is the right answer rather than a false negative.
 *
 * Per-commit sums run higher than a net diff (a line added then removed counts
 * twice — measured ~26% higher over a 3-commit range here), so `loyalty` reads
 * slightly lower than it used to for the same code. Accepted: the thresholds it
 * feeds were re-chosen against these numbers, not inherited.
 *
 * Fails to a zero result on any git error, so drift never blocks anything.
 */
function gitChurnByAuthor(
  cwd: string,
  sinceSha: string,
  sources: string[],
  mine: Set<string>,
): ComponentChurn {
  const empty: ComponentChurn = {
    foreign: 0,
    self: 0,
    foreignAuthors: [],
    foreignCommits: 0,
    unmeasurableForeign: false,
  };
  if (!sinceSha || sources.length === 0) return empty;

  let out: string;
  try {
    out = execFileSync(
      'git',
      // %aE, not %ae: the mailmap-canonical author address. `.mailmap` is git's
      // own committed answer to one person having several addresses, and it
      // costs nothing — with no .mailmap in the repo the two are byte-identical.
      ['log', '--numstat', '--format=C%H%x09%aE', `${sinceSha}..HEAD`, '--', ...sources],
      { cwd, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' },
    );
  } catch {
    // The anchor did not resolve. A rebase, a squash, or a force-push erases the
    // sha the user validated against, and every later walk then fails the same
    // way — so scoring this 0 would not be "no churn this once", it would turn
    // rebellion off permanently and silently for that component. The history
    // they demonstrated against genuinely no longer exists, so report it as an
    // unmeasurable change and let the trigger ask for a re-check.
    return { ...empty, unmeasurableForeign: true };
  }

  let foreign = 0;
  let self = 0;
  const authors = new Set<string>();
  const foreignShas = new Set<string>();
  let currentSha = '';
  let currentIsForeign = false;
  let unmeasurableForeign = false;

  for (const line of out.split('\n')) {
    const header = COMMIT_HEADER.exec(line);
    if (header) {
      currentSha = header[1]!;
      const author = (header[2] ?? '').toLowerCase();
      // Unknown identity → treat as self (never lock someone out on a
      // misconfiguration). A commit with no author email is likewise self.
      currentIsForeign = mine.size > 0 && author !== '' && !mine.has(author);
      if (currentIsForeign) authors.add(author);
      continue;
    }
    const parts = line.split('\t');
    if (parts.length < 3 || !currentSha) continue;
    const added = Number(parts[0]);
    const deleted = Number(parts[1]);
    // `-\t-` means git decided the file is BINARY, and then it reports no line
    // counts at all. That is not only images: a stray NUL byte in a source file
    // is enough, and this repo had two such files. Silently scoring them 0 would
    // make a component anchored to one unable to rebel however much a teammate
    // rewrote it — an invisible, permanent hole. Record it instead and let the
    // trigger treat an unmeasurable foreign change as cause on its own.
    if (!Number.isFinite(added) || !Number.isFinite(deleted)) {
      if (currentIsForeign) {
        unmeasurableForeign = true;
        foreignShas.add(currentSha);
      }
      continue;
    }
    const lines = added + deleted;
    if (lines <= 0) continue;
    if (currentIsForeign) {
      foreign += lines;
      foreignShas.add(currentSha);
    } else {
      self += lines;
    }
  }

  return {
    foreign,
    self,
    foreignAuthors: [...authors].sort(),
    foreignCommits: foreignShas.size,
    unmeasurableForeign,
  };
}

export interface RecomputeResult {
  coverage: UserCoverage;
  map: MapJson;
  loaded: LoadedScale;
  dir: string;
  /**
   * The authorship-split churn this run measured, for callers that need to say
   * WHY something rebelled (the lock sync, the SessionStart digest). Only
   * components that actually churned appear.
   */
  churn: Record<string, ComponentChurn>;
  /** componentId → size in lines, the loyalty/ratio denominator. */
  sizes: Record<string, number>;
  /** The effective config this run used. */
  config: ScaleConfig;
}

/**
 * Re-materialize coverage.json from evidence.jsonl for the repo at `cwd`, write
 * it, and return it. Steps:
 *   1. load the .scale/ tree, the frozen map, config, and evidence,
 *   2. compute per-component `sizes` (line count of sources at HEAD) — always,
 *      since it is the loyalty denominator,
 *   3. FOLD the evidence (pure) to get this run's `lastValidatedSha` anchors,
 *   4. compute per-component `churn` from THOSE anchors (git diff <sha>..HEAD
 *      over its sources) — never validated → no churn entry → cannot drift,
 *   5. apply drift, stamp, and write ~/.scale/<repo-id>/coverage.json.
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

  // TWO-PHASE, and the order is load-bearing. Fold first (pure, no I/O), then
  // measure churn from the anchors THAT FOLD produced, then apply drift.
  //
  // Measuring from the previously-persisted coverage.json instead made recovery
  // take two recomputes: a component re-validated after a rebellion still had
  // its churn measured from the PRE-rebellion sha, so drift immediately flipped
  // it back to `stale` in the same command that recorded the passing check.
  // Harmless while staleness was only a map colour; with the edit gate re-locking
  // on rebellion it would lock the junior out of territory they had just earned.
  const folded = foldEvidence(evidence, { map, config, user: config.user, headSha: head });

  // One cheap pre-filter before the per-component walks. Every anchor is an
  // ancestor of HEAD, so the union of files changed since the OLDEST anchor is a
  // superset of anything any component could have churned: a component whose
  // sources are absent from it provably has zero churn and needs no git call at
  // all. On a quiet repo this collapses 37 `git log` walks (~540 ms measured
  // here) into one `git diff --name-only`, which matters because this runs
  // inside the SessionStart hook.
  const mine = myIdentities(cwd, config);
  const anchored = Object.entries(folded.components).filter(([, c]) => c.lastValidatedSha);
  const touchedFiles = changedFilesSince(
    cwd,
    anchored.map(([, c]) => c.lastValidatedSha!),
  );

  const churn: Record<string, ComponentChurn> = {};
  for (const [id, comp] of anchored) {
    const sources = sourcesById.get(id) ?? [];
    if (touchedFiles && !sources.some((s) => touchedFiles.has(s))) continue;
    const c = gitChurnByAuthor(cwd, comp.lastValidatedSha!, sources, mine);
    if (c.foreign > 0 || c.self > 0 || c.unmeasurableForeign) churn[id] = c;
  }

  const coverage = finalizeCoverage(
    recomputeDrift(folded, { churn, sizes, config }),
    new Date().toISOString(),
  );

  ensureStateDir(dir);
  fs.writeFileSync(paths.coverage(dir), JSON.stringify(coverage, null, 2) + '\n');

  return { coverage, map, loaded, dir, churn, sizes, config };
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
