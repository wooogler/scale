#!/usr/bin/env node
/**
 * @scale/cli — the `scale` command. Wraps @scale/core; also invoked by the
 * Claude Code plugin hooks. Command surface per PLAN §7.1.
 *
 * Latency contract (PLAN §6.1 / §7.1): the hook-path commands — `log`, `gate`,
 * `context` — MUST stay pure fast file reads/appends (< 200 ms) with NO LLM
 * calls and no network. Anything heavy (quest generation, layout, drift, serve)
 * runs detached, out of the hook path.
 *
 * Phase 0 acceptance: `scale --help` runs and lists every subcommand. Real
 * commands here: init, log, config, reset (+ best-effort quest list / map index
 * reads). The rest are wired with help text and exit-0 stubs that print
 * "not implemented (Phase N)".
 */
import path from 'node:path';
import fs from 'node:fs';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { Command } from 'commander';
import {
  type ScaleConfig,
  type Language,
  type EvidenceEntry,
  type MapJson,
  type LoadedScale,
  type DimName,
  type FileComponentIndex,
  type GateInput,
  ScaleConfigSchema,
  buildFileComponentIndex,
  loadScaleDir,
  paperById,
  componentSourcesIndex,
  componentsForFile,
  computeLayout,
  emptyComponentCoverage,
  meanDims,
  gateDecision,
  estimateBuild,
  resolveInterventionModel,
  MODEL_RATES,
  MEASURED_BUILD,
  type BuildEstimate,
} from '@scale/core';

import { startServer } from './serve.js';
import {
  generateQuests,
  completeQuizQuest,
  completeSocraticQuest,
} from './quest.js';
import {
  recomputeCoverageFromDisk,
  coverageCounts,
  type RecomputeResult,
} from './coverage.js';

import {
  stateDir,
  resolveRepoId,
  ensureStateDir,
  paths,
  configExists,
  readConfig,
  readConfigSafe,
  writeConfig,
  appendEvidence,
  readQuestsSafe,
  type SessionRecord,
  defaultSession,
  readSessionSafe,
  writeSession,
  readPendingEdits,
  writePendingEdits,
} from './state.js';
import {
  readHookPayload,
  promptTextOf,
  editedFilesOf,
  sessionIdOf,
} from './hook-input.js';

/**
 * Plugin release this binary was bundled from. `scripts/build-plugin.mjs`
 * replaces it at build time; running from source (tsx) leaves it undefined, and
 * the `-dev` marker is then the honest answer. `scale --version` is the only way
 * to tell whether Claude Code is serving a stale cached plugin, so it must never
 * report a hardcoded number that happens to look current.
 */
declare const __SCALE_VERSION__: string | undefined;
const SCALE_VERSION =
  typeof __SCALE_VERSION__ === 'string' ? __SCALE_VERSION__ : '0.0.0-dev';

const program = new Command();

program
  .name('scale')
  .description('SCALE — coverage-memory state engine and tutor CLI')
  .version(SCALE_VERSION);

/** Mark a subcommand as an intentional exit-0 placeholder. */
function stub(phase: string, note: string): void {
  console.log(`scale: ${note} — not implemented (${phase}).`);
  // Intentionally exit 0: stubs must not break hooks or scripts.
}

const nowIso = (): string => new Date().toISOString();

function currentUser(dir: string): string {
  return readConfigSafe(dir)?.user ?? process.env.USER ?? 'unknown';
}

function splitList(v?: string): string[] {
  if (!v) return [];
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Normalize a hook-supplied path to a repo-relative one. Claude Code hands the
 * edit hooks ABSOLUTE paths, while `.scale/index.json` is keyed relative to the
 * repo root — so without this every hook-captured file misses the index. Paths
 * outside the repo are left as-is (they simply won't match a component).
 */
function relToRepo(cwd: string, file: string): string {
  const rel = path.relative(cwd, path.resolve(cwd, file));
  return rel && !rel.startsWith('..') ? rel : file;
}

/** Best-effort short HEAD SHA of the repo at `cwd`; '' if not a git repo. */
function headSha(cwd: string): string {
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

/** Run a git command in `cwd`, returning trimmed stdout or '' on any failure. */
function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
  } catch {
    return '';
  }
}

/** Staged file paths (repo-relative) from `git diff --cached --name-only`. */
function stagedFiles(cwd: string): string[] {
  const out = git(cwd, ['diff', '--cached', '--name-only']);
  return out ? out.split('\n').map((s) => s.trim()).filter(Boolean) : [];
}

/**
 * Total changed lines in the staged diff = Σ(added + deleted) from
 * `git diff --cached --numstat`. Binary files ('-'\t'-') contribute 0.
 */
function stagedChangedLines(cwd: string): number {
  const out = git(cwd, ['diff', '--cached', '--numstat']);
  if (!out) return 0;
  let total = 0;
  for (const line of out.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    const added = Number(parts[0]);
    const deleted = Number(parts[1]);
    if (Number.isFinite(added)) total += added;
    if (Number.isFinite(deleted)) total += deleted;
  }
  return total;
}

/**
 * Component ids "recently addressed" within the marker TTL (PLAN §6.1): those
 * with a fresh active validation (quiz_result/socratic_result) OR a
 * deferred/completed intervention whose `ts` is within `ttlMinutes` of `now`.
 * This is BOTH the retry-passes path and the defer=drop path. Reads
 * evidence.jsonl directly (fast, no recompute). Malformed lines are skipped.
 */
function recentlyAddressedComponents(dir: string, now: Date, ttlMinutes: number): string[] {
  let text: string;
  try {
    text = fs.readFileSync(paths.evidence(dir), 'utf8');
  } catch {
    return [];
  }
  const cutoff = now.getTime() - ttlMinutes * 60_000;
  const ids = new Set<string>();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const ts = typeof e.ts === 'string' ? Date.parse(e.ts) : NaN;
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    const type = e.type;
    const compId = typeof e.componentId === 'string' ? e.componentId : null;
    if (!compId) continue;
    if (type === 'quiz_result' || type === 'socratic_result') {
      ids.add(compId);
    } else if (type === 'intervention' && (e.outcome === 'deferred' || e.outcome === 'completed')) {
      ids.add(compId);
    }
  }
  return [...ids];
}

/** Read + parse `<cwd>/.scale/map.json`, or null if missing/invalid. */
function readMapJsonSafe(cwd: string): MapJson | null {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(cwd, '.scale', 'map.json'), 'utf8'),
    ) as MapJson;
  } catch {
    return null;
  }
}

/**
 * Case-insensitive match of free prompt text against every component's id,
 * title, and concept ids/names (dash/space normalized). Substring match — cheap,
 * no LLM — so it stays on the hook-append latency budget (§7.1). Returns the set
 * of matched component ids.
 */
function matchComponentsFromText(loaded: LoadedScale, text: string): string[] {
  const hay = ` ${text.toLowerCase().replace(/\s+/g, ' ')} `;
  const ids: string[] = [];
  for (const p of loaded.papers) {
    const fm = p.frontmatter;
    const candidates = [
      fm.id,
      fm.title,
      ...fm.concepts.flatMap((c) => [c.id, c.name]),
    ];
    for (const cand of candidates) {
      const c = cand.toLowerCase().trim();
      if (c.length < 3) continue;
      const variants = new Set([c, c.replace(/-/g, ' ')]);
      let hit = false;
      for (const v of variants) if (hay.includes(v)) hit = true;
      if (hit) {
        if (!ids.includes(fm.id)) ids.push(fm.id);
        break;
      }
    }
  }
  return ids;
}

/**
 * Load the file→component index for `cwd`: prefer the persisted
 * `.scale/index.json`, else build it in-memory from the papers' sources. Both
 * feed `componentsForFile` (exact match + nearest-dir fallback).
 */
function loadFileComponentIndex(cwd: string, loaded: LoadedScale): FileComponentIndex {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(cwd, '.scale', 'index.json'), 'utf8'),
    ) as FileComponentIndex;
  } catch {
    return buildFileComponentIndex(componentSourcesIndex(loaded));
  }
}

/** Round a coverage progress/dim value to a compact 0.x string. */
function fmt(n: number): string {
  return n.toFixed(2).replace(/\.?0+$/, '') || '0';
}

/**
 * Build the ≤3-line SessionStart coverage summary (injected into the agent's
 * context). Line 1: unification progress. Line 2: the weakest unconquered
 * territory. Line 3: territory that needs re-validation (stale). Kept terse.
 * When the junior's interaction language is 'ko', one extra line tells the agent
 * to deliver comprehension checks in Korean; 'en' adds nothing.
 */
function contextSummary(res: RecomputeResult, language: Language = 'en'): string {
  const { coverage, map } = res;
  const counts = coverageCounts(coverage, map);
  const scored = map.nodes.map((n) => {
    const comp = coverage.components[n.id] ?? emptyComponentCoverage();
    return { id: n.id, state: comp.state, mean: meanDims(comp.dims) };
  });

  const lines: string[] = [];
  lines.push(
    `SCALE: ${counts.total} territories, unification ${Math.round(
      counts.progress * 100,
    )}% (${counts.validated} validated, ${counts.explored} explored, ${counts.fog} fog).`,
  );

  const weak = scored
    .filter((s) => s.state === 'fog' || s.state === 'explored')
    .sort((a, b) => a.mean - b.mean)
    .slice(0, 3)
    .map((s) => (s.state === 'fog' ? `${s.id} (fog)` : `${s.id} (explored ${fmt(s.mean)})`));
  if (weak.length > 0) lines.push(`You're weak on: ${weak.join(', ')}.`);

  const stale = scored.filter((s) => s.state === 'stale').map((s) => s.id);
  if (stale.length > 0) {
    lines.push(
      `${stale.length} territory needs re-validation (stale): ${stale.join(', ')}.`,
    );
  }

  if (language === 'ko') {
    lines.push(
      'interaction language: ko — run comprehension checks in Korean (keep code identifiers in English)',
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// init  (REAL) — create ~/.scale/<repo-id>/ with a validated default config
// ---------------------------------------------------------------------------
program
  .command('init')
  .description('Create the ~/.scale/<repo-id>/ state dir with a default config.json')
  .option('-u, --user <label>', 'user label written into config.json')
  .option('-f, --force', 'overwrite an existing config.json', false)
  .action((opts: { user?: string; force?: boolean }) => {
    const dir = stateDir();
    ensureStateDir(dir);

    if (configExists(dir) && !opts.force) {
      console.log(`scale: state already initialized at ${dir}`);
      console.log('  (pass --force to overwrite config.json)');
      return;
    }

    // ScaleConfigSchema fills every field but `user` from its defaults.
    const config = writeConfig(dir, {
      user: opts.user ?? process.env.USER ?? 'user',
    });

    console.log(`scale: initialized state for repo-id "${resolveRepoId()}"`);
    console.log(`  dir:    ${dir}`);
    console.log(`  config: ${paths.config(dir)}`);
    console.log(
      `  condition: ${config.condition.timing}/${config.condition.modality}` +
        `  user: ${config.user}`,
    );
  });

// ---------------------------------------------------------------------------
// context  (STUB) — SessionStart 3-line coverage summary (hook path, no LLM)
// ---------------------------------------------------------------------------
program
  .command('context')
  .description('Print the SessionStart coverage summary (injected to the agent)')
  .action(async () => {
    // SessionStart: (re)start the session record, re-materialize coverage, then
    // print a ≤3-line summary for injection. No LLM / no network — git+fs only.
    const cwd = process.cwd();
    const dir = stateDir(cwd);
    ensureStateDir(dir);

    // The SessionStart payload carries the session id. A `compact` or `resume`
    // start is the SAME session continuing, and it reports the same id — so
    // reusing the existing record preserves the interruption budget instead of
    // silently refilling it mid-session (PLAN §6.1). A genuinely new session
    // (startup/clear) brings a new id and gets a fresh budget. Run by hand with
    // no payload, there is no id to match and the behavior is a fresh session,
    // as before.
    const sessionId = sessionIdOf(await readHookPayload()) || crypto.randomUUID();
    const existing = readSessionSafe(dir);
    if (!existing || existing.sessionId !== sessionId) {
      writeSession(dir, defaultSession(sessionId, nowIso()));
    }

    let res: RecomputeResult;
    try {
      res = recomputeCoverageFromDisk(cwd);
    } catch (err) {
      console.log(`SCALE: coverage unavailable (${(err as Error).message}).`);
      return;
    }
    // Per-user interaction language (config is optional pre-`init` → 'en').
    console.log(contextSummary(res, readConfigSafe(dir)?.language ?? 'en'));
  });

// ---------------------------------------------------------------------------
// status  (REAL) — "coverage at a glance" human/JSON view (no LLM, git+fs only)
// Distinct from `context` (the terse ≤3-line SessionStart injection): status is
// the fuller human view of the whole realm — progress, per-province rollup,
// stale list, pending quest count. Pure file+git reads.
// ---------------------------------------------------------------------------

interface StatusComponent {
  id: string;
  state: string;
  mean: number;
}
interface StatusProvince {
  id: string;
  name: string;
  components: StatusComponent[];
}

/** Assemble the structured status view for the repo at `cwd`. */
function buildStatus(cwd: string, res: RecomputeResult, dir: string) {
  const { coverage, map } = res;
  const counts = coverageCounts(coverage, map);
  const config = readConfigSafe(dir);
  const quests = readQuestsSafe(dir);
  const pending = quests.filter((q) => q.status === 'pending');

  const provinceName = new Map(map.provinces.map((p) => [p.id, p.name]));
  const byProvince = new Map<string, StatusComponent[]>();
  for (const n of map.nodes) {
    const comp = coverage.components[n.id] ?? emptyComponentCoverage();
    const arr = byProvince.get(n.province) ?? [];
    arr.push({ id: n.id, state: comp.state, mean: meanDims(comp.dims) });
    byProvince.set(n.province, arr);
  }
  const provinces: StatusProvince[] = [...byProvince.keys()]
    .sort((a, b) => (provinceName.get(a) ?? a).localeCompare(provinceName.get(b) ?? b))
    .map((pid) => ({
      id: pid,
      name: provinceName.get(pid) ?? pid,
      components: byProvince.get(pid)!.sort((a, b) => a.id.localeCompare(b.id)),
    }));

  const stale = map.nodes
    .filter((n) => (coverage.components[n.id]?.state ?? 'fog') === 'stale')
    .map((n) => n.id)
    .sort();

  return {
    repoId: resolveRepoId(cwd),
    user: config?.user ?? currentUser(dir),
    condition: config?.condition ?? null,
    models: config?.models ?? null,
    progress: counts.progress,
    counts: {
      total: counts.total,
      fog: counts.fog,
      explored: counts.explored,
      validated: counts.validated,
      stale: counts.stale,
    },
    provinces,
    stale,
    pendingQuests: pending.length,
  };
}

type StatusView = ReturnType<typeof buildStatus>;

/** Render the human-readable status summary. */
function renderStatus(s: StatusView): string {
  const lines: string[] = [];
  lines.push(`SCALE status — ${s.repoId}`);
  const cond = s.condition ? `${s.condition.timing}/${s.condition.modality}` : '(no config)';
  // Intervention model only — the build model is the Claude Code session's, not
  // anything SCALE stores (see ModelsConfigSchema).
  const models = s.models ? resolveInterventionModel(s.models) : '(no config)';
  lines.push(`  user: ${s.user}   condition: ${cond}   models: ${models}`);
  lines.push('');

  if (s.counts.total === 0) {
    lines.push('  No coverage memory found — run `/scale-map` to build .scale/, then `scale map layout`.');
    return lines.join('\n');
  }

  lines.push(`  unification progress: ${Math.round(s.progress * 100)}%  (importance-weighted)`);
  lines.push(
    `  states: ${s.counts.fog} fog · ${s.counts.explored} explored · ` +
      `${s.counts.validated} validated · ${s.counts.stale} stale  (${s.counts.total} total)`,
  );
  lines.push('');

  // Per-province rollup: id + skin-neutral state + comprehension mean.
  const allComps = s.provinces.flatMap((p) => p.components);
  const idW = Math.max(4, ...allComps.map((c) => c.id.length));
  const stateW = 9; // 'validated'
  const pad = (str: string, w: number): string => str + ' '.repeat(Math.max(0, w - str.length));
  for (const p of s.provinces) {
    lines.push(`${p.name}`);
    for (const c of p.components) {
      lines.push(`  ${pad(c.id, idW)}  ${pad(c.state, stateW)}  ${c.mean.toFixed(2)}`);
    }
    lines.push('');
  }

  if (s.stale.length > 0) {
    lines.push(`Needs re-validation (stale): ${s.stale.length}`);
    for (const id of s.stale) lines.push(`  - ${id}`);
    lines.push('');
  }

  lines.push(`Pending quests: ${s.pendingQuests}`);
  return lines.join('\n');
}

program
  .command('status')
  .description(
    'Coverage at a glance: unification progress, per-province states, stale ' +
      'territory, and pending quests. Read-only, no LLM (git+file reads only).',
  )
  .option('--json', 'emit machine-readable JSON instead of the summary', false)
  .action((opts: { json?: boolean }) => {
    const cwd = process.cwd();
    const dir = stateDir(cwd);
    let res: RecomputeResult;
    try {
      res = recomputeCoverageFromDisk(cwd);
    } catch (err) {
      const msg = (err as Error).message;
      if (opts.json) console.log(JSON.stringify({ error: msg }, null, 2));
      else console.error(`scale: coverage unavailable (${msg}).`);
      process.exitCode = 1;
      return;
    }
    const status = buildStatus(cwd, res, dir);
    if (opts.json) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    console.log(renderStatus(status));
  });

// ---------------------------------------------------------------------------
// log  (REAL) — append a validated EvidenceEntry to evidence.jsonl
// Hook path: validate + single async append, no LLM, no network (§6.1).
// ---------------------------------------------------------------------------
const log = program
  .command('log')
  .description('Append a raw signal to evidence.jsonl (hook path — fast append)');

// Latency budget (§7.1): `log *` is APPEND-ONLY and must stay < 200 ms — no LLM,
// no network, and NO coverage recompute here. Reading .scale/ to resolve
// component ids (keyword / index match) is fast, local, and allowed.

log
  .command('prompt')
  .description('Log a prompt signal (components mentioned in a user prompt)')
  .argument('[text...]', 'the prompt text (matched against components)')
  .option('-c, --components <ids>', 'comma-separated component ids (skip matching)')
  .option('-t, --text <text>', 'the prompt text (overrides positional)')
  .action(async (parts: string[], opts: { components?: string; text?: string }) => {
    const cwd = process.cwd();
    const dir = stateDir(cwd);
    let text = opts.text ?? parts.join(' ');
    // Hook path: prompt-submit.mjs pipes the UserPromptSubmit payload on stdin
    // and passes no argv, so the prompt itself lives there.
    if (!text.trim()) text = promptTextOf(await readHookPayload());
    // Explicit --components wins; otherwise keyword-match the text against ids,
    // titles, and concepts from .scale/.
    let componentIds = splitList(opts.components);
    if (componentIds.length === 0 && text.trim()) {
      componentIds = matchComponentsFromText(loadScaleDir(cwd), text);
    }
    const entry: EvidenceEntry = {
      type: 'prompt',
      ts: nowIso(),
      user: currentUser(dir),
      componentIds,
      ...(text.trim() ? { text } : {}),
    };
    await appendEvidence(dir, entry);
    console.log(`scale: logged prompt (${entry.componentIds.length} component(s))`);
  });

log
  .command('touch')
  .description('Log a touch signal (files edited → components)')
  .argument('[files...]', 'file paths that were edited')
  .option('-f, --files <paths>', 'comma-separated file paths (adds to positional)')
  .option('-c, --components <ids>', 'comma-separated component ids (adds to matched)')
  .action(async (fileArgs: string[], opts: { files?: string; components?: string }) => {
    const cwd = process.cwd();
    const dir = stateDir(cwd);
    let raw = [...fileArgs, ...splitList(opts.files)];
    let sessionId = '';
    // Hook path: post-edit.mjs pipes the PostToolUse payload on stdin and passes
    // no argv, so the edited paths live in its tool_input.
    if (raw.length === 0) {
      const payload = await readHookPayload();
      raw = editedFilesOf(payload);
      sessionId = sessionIdOf(payload);
    }
    const files = raw.map((f) => relToRepo(cwd, f));
    // Map each file → component ids via .scale/index.json (nearest-dir fallback).
    const index = loadFileComponentIndex(cwd, loadScaleDir(cwd));
    const matched = new Set<string>(splitList(opts.components));
    for (const f of files) {
      for (const id of componentsForFile(index, f)) matched.add(id);
    }
    const entry: EvidenceEntry = {
      type: 'touch',
      ts: nowIso(),
      user: currentUser(dir),
      files,
      componentIds: [...matched],
    };
    await appendEvidence(dir, entry);
    // Close the propose→execute pair opened by pre-edit.mjs, if any.
    const reviews = await closePendingReviews(dir, sessionId, files, entry.user);
    console.log(
      `scale: logged touch (${entry.files.length} file(s), ${entry.componentIds.length} component(s)` +
        `${reviews > 0 ? `, ${reviews} diff_review` : ''})`,
    );
  });

/**
 * Key a pending proposal by the session that made it (pre-edit.mjs's stated
 * contract: "keyed by session + target file"). Two concurrent Claude Code
 * windows editing the same file would otherwise close each other's pair and
 * report a latency that belongs to neither. NUL separates the parts because it
 * is the one byte that can appear in neither a session id nor a path.
 */
function pendingKey(sessionId: string, file: string): string {
  return `${sessionId}\u0000${file}`;
}

/**
 * Close any recorded PreToolUse proposal timestamps for `files` into
 * `diff_review` rows — the propose→execute latency pair opened by pre-edit.mjs.
 * Best-effort: an absent or unreadable pending file simply yields no rows.
 */
async function closePendingReviews(
  dir: string,
  sessionId: string,
  files: string[],
  user: string,
): Promise<number> {
  if (files.length === 0) return 0;
  const pending = readPendingEdits(dir);
  const now = Date.now();
  let closed = 0;
  let changed = false;

  for (const file of files) {
    // Prefer this session's proposal; fall back to a session-less one (an
    // explicit `scale log review`, or a payload that carried no session id).
    let key = pendingKey(sessionId, file);
    if (pending[key] === undefined && sessionId) key = pendingKey('', file);
    const proposedAt = pending[key];
    if (proposedAt === undefined) continue;

    delete pending[key];
    changed = true;
    const ms = now - Date.parse(proposedAt);
    if (!Number.isFinite(ms) || ms < 0) continue;
    await appendEvidence(dir, {
      type: 'diff_review',
      ts: nowIso(),
      user,
      file,
      proposeToExecuteMs: ms,
    });
    closed++;
  }

  if (changed) writePendingEdits(dir, pending);
  return closed;
}

log
  .command('review')
  .description('Log a diff-review latency signal (proposal → execution ms)')
  .argument('[file]', 'file that was reviewed')
  .argument('[ms]', 'propose-to-execute latency in ms')
  .option('-f, --file <path>', 'file that was reviewed (overrides positional)')
  .option('-m, --ms <number>', 'propose-to-execute latency in ms (overrides positional)')
  .action(
    async (
      fileArg: string | undefined,
      msArg: string | undefined,
      opts: { file?: string; ms?: string },
    ) => {
      const cwd = process.cwd();
      const dir = stateDir(cwd);
      const file = opts.file ?? fileArg;
      const ms = opts.ms ?? msArg;

      // Explicit form — a caller that already measured the latency.
      if (file && ms !== undefined) {
        const entry: EvidenceEntry = {
          type: 'diff_review',
          ts: nowIso(),
          user: currentUser(dir),
          file: relToRepo(cwd, file),
          proposeToExecuteMs: Number(ms),
        };
        await appendEvidence(dir, entry);
        console.log(`scale: logged diff_review (${entry.proposeToExecuteMs} ms)`);
        return;
      }

      // Hook path (propose phase): pre-edit.mjs pipes the PreToolUse payload and
      // passes no argv. The latency isn't knowable yet, so record the proposal
      // timestamp; the paired `log touch` (PostToolUse) closes it into a row.
      const payload = await readHookPayload();
      const files = editedFilesOf(payload).map((f) => relToRepo(cwd, f));
      if (files.length > 0) {
        const sessionId = sessionIdOf(payload);
        const pending = readPendingEdits(dir);
        const at = nowIso();
        for (const f of files) pending[pendingKey(sessionId, f)] = at;
        writePendingEdits(dir, pending);
        console.log(`scale: recorded ${files.length} edit proposal(s)`);
        return;
      }

      console.error('scale: usage — scale log review <file> <ms>');
      process.exitCode = 1;
    },
  );

// ---------------------------------------------------------------------------
// gate commit  (REAL) — deterministic pre-commit decision (hook path, no LLM)
// ---------------------------------------------------------------------------
const gate = program
  .command('gate')
  .description(
    'Interruption-gate policy decisions (PLAN §6.1). Only `commit` (the ' +
      "pre-commit trigger) is wired; `post-task` is a documented, deferred trigger.",
  );

/** Fresh in-flow markers older than this are ignored (PLAN §6.1 TTL). */
const MARKER_TTL_MINUTES = 10;

gate
  .command('commit')
  .description(
    'Decide whether a pre-commit intervention should fire. Reads the staged ' +
      'diff + coverage + budget, prints one JSON line ' +
      '{"allow":bool,"component":str|null,"reason":str|null}, always exit 0. ' +
      'Pure git+file I/O, no LLM — the hook (not the CLI) blocks the commit.',
  )
  .action(async () => {
    const cwd = process.cwd();
    const dir = stateDir(cwd);

    // Always emit a single JSON line + exit 0; the CLI never itself blocks.
    const emit = (allow: boolean, component: string | null, reason: string | null): void => {
      console.log(JSON.stringify({ allow, component, reason }));
    };

    // Config (persisted, else schema defaults so the gate works pre-`init`).
    const config: ScaleConfig =
      readConfigSafe(dir) ?? ScaleConfigSchema.parse({ user: process.env.USER ?? 'user' });

    // Staged diff → touched files → components (via .scale/index.json, nearest-dir
    // fallback). No .scale/ at all → nothing to gate, allow.
    const scaleDir = path.join(cwd, '.scale');
    if (!fs.existsSync(scaleDir)) {
      emit(true, null, null);
      return;
    }
    const loaded = loadScaleDir(cwd);
    const index = loadFileComponentIndex(cwd, loaded);
    const files = stagedFiles(cwd);
    const touched = new Set<string>();
    for (const f of files) {
      for (const id of componentsForFile(index, f)) touched.add(id);
    }
    const changedLines = stagedChangedLines(cwd);

    // Coverage (materialized from evidence) + the frozen map for importance.
    const { coverage, map } = recomputeCoverageFromDisk(cwd);
    const importance: Record<string, number> = {};
    for (const n of map.nodes) importance[n.id] = n.importance;

    // Session budget accounting (create a fresh one if SessionStart never ran).
    const session: SessionRecord =
      readSessionSafe(dir) ?? defaultSession(crypto.randomUUID(), nowIso());

    const now = nowIso();
    const recentlyAddressed = recentlyAddressedComponents(
      dir,
      new Date(now),
      MARKER_TTL_MINUTES,
    );

    const gateInput: GateInput = {
      touched: [...touched],
      coverage,
      config,
      session: {
        interventionsThisSession: session.interventionsThisSession,
        lastInterventionAt: session.lastInterventionAt,
        pendingComponent: session.pendingComponent,
      },
      changedLines,
      recentlyAddressed,
      now,
      importance,
    };

    const decision = gateDecision(gateInput);

    if (decision.action === 'deny' && decision.component) {
      const component = decision.component;
      // Record that we REQUESTED an in-flow intervention (accounting only — no
      // dim change). Not 'shown': the gate only asks the agent to run the check,
      // and whether it ever reached the junior is decided downstream.
      // Best-effort: a write failure must not turn the deny into noise.
      try {
        await appendEvidence(dir, {
          type: 'intervention',
          ts: now,
          user: currentUser(dir),
          componentId: component,
          timing: 'inflow',
          modality: config.condition.modality,
          outcome: 'requested',
        });
      } catch {
        /* keep going — the deny is what matters to the hook */
      }
      // Spend a budget slot: bump the counter, stamp the time, remember the target.
      writeSession(dir, {
        ...session,
        interventionsThisSession: session.interventionsThisSession + 1,
        lastInterventionAt: now,
        pendingComponent: component,
      });
      emit(false, component, decision.reason ?? null);
      return;
    }

    // Allow. If this allow resolved the pending component (its retry passed, or it
    // was deferred → dropped), clear the pending marker.
    if (session.pendingComponent && recentlyAddressed.includes(session.pendingComponent)) {
      writeSession(dir, { ...session, pendingComponent: null });
    }
    emit(true, null, null);
  });

// ---------------------------------------------------------------------------
// gate defer  (REAL) — the user's "skip" escape hatch (defer = drop, PLAN §6.1)
// ---------------------------------------------------------------------------
gate
  .command('defer')
  .description(
    'Skip the pre-commit check for a component (defer = drop, PLAN §6.1). ' +
      'Writes the intervention(outcome:deferred) marker the gate recognizes so ' +
      'the retried commit passes; nothing is queued — the territory just stays ' +
      'unconquered. Pure file append, no LLM.',
  )
  .argument('<componentId>', 'component whose in-flow check the user is skipping')
  .option(
    '--by <who>',
    "who chose to skip: 'user' (the junior declined) or 'agent' (the agent " +
      'skipped without asking, e.g. it authored the commit itself). Only ' +
      "'user' is a real deferral decision for study purposes",
    'user',
  )
  .action(async (componentId: string, opts: { by: string }) => {
    const cwd = process.cwd();
    const dir = stateDir(cwd);
    if (opts.by !== 'user' && opts.by !== 'agent') {
      console.error(`scale: --by must be 'user' or 'agent' (got '${opts.by}').`);
      process.exitCode = 1;
      return;
    }
    // Modality is accounting metadata; use the configured condition (schema
    // default pre-`init` so defer works even before state is set up).
    const config: ScaleConfig =
      readConfigSafe(dir) ?? ScaleConfigSchema.parse({ user: process.env.USER ?? 'user' });
    const now = nowIso();

    // The marker: an inflow intervention with outcome 'deferred'. This is exactly
    // what `recentlyAddressedComponents` (and the pure gate) scan for, so the very
    // next `git commit` on the same staged diff passes the gate (defer = drop).
    // `by` keeps an agent-side skip out of the junior's choice data.
    await appendEvidence(dir, {
      type: 'intervention',
      ts: now,
      user: currentUser(dir),
      componentId,
      timing: 'inflow',
      modality: config.condition.modality,
      outcome: 'deferred',
      by: opts.by,
    });

    // Clear the pending marker if this is what the last deny was waiting on, so the
    // budget accounting matches the retry-passes path.
    const session = readSessionSafe(dir);
    if (session && session.pendingComponent === componentId) {
      writeSession(dir, { ...session, pendingComponent: null });
    }

    console.log(
      `scale: skipped '${componentId}' (by ${opts.by}) — territory stays unconquered; ` +
        'commit will proceed.',
    );
  });

// ---------------------------------------------------------------------------
// record  (STUB) — quiz/socratic outcome from the tutor agent
// ---------------------------------------------------------------------------
program
  .command('record')
  .description('Record a quiz/Socratic validation outcome (updates coverage)')
  .argument('<componentId>', 'component the outcome is for')
  .option('-d, --dim <dim>', 'quiz dimension: structure | concepts | rationale')
  .option('-s, --score <0..1>', 'quiz score in [0,1]')
  .option('--socratic <json>', "per-dim rubric scores, e.g. '{\"structure\":0.8}'")
  .option(
    '--origin <origin>',
    'where the validation came from: session | voluntary (PLAN §6.3)',
    'session',
  )
  .action(
    async (
      componentId: string,
      opts: { dim?: string; score?: string; socratic?: string; origin?: string },
    ) => {
      const cwd = process.cwd();
      const dir = stateDir(cwd);
      if (opts.origin !== 'session' && opts.origin !== 'voluntary') {
        console.error("scale: --origin must be 'session' or 'voluntary'.");
        process.exitCode = 1;
        return;
      }
      const origin = opts.origin;
      // Capture the git sha that is HEAD right now — this validation is anchored
      // to it so its `lastValidatedSha` stays fixed across future recomputes
      // (staleness must persist through re-materialization). '' if not a git repo.
      const sha = headSha(cwd);

      let entry: EvidenceEntry;
      if (opts.socratic !== undefined) {
        let dims: Record<string, number>;
        try {
          dims = JSON.parse(opts.socratic) as Record<string, number>;
        } catch {
          console.error('scale: --socratic must be a JSON object of dim→score.');
          process.exitCode = 1;
          return;
        }
        entry = {
          type: 'socratic_result',
          ts: nowIso(),
          user: currentUser(dir),
          componentId,
          dims: dims as Partial<Record<DimName, number>>,
          sha,
          origin,
        };
      } else {
        if (!opts.dim || opts.score === undefined) {
          console.error(
            'scale: usage — scale record <componentId> --dim <dim> --score <0..1>' +
              "  (or --socratic '<json dims>')",
          );
          process.exitCode = 1;
          return;
        }
        entry = {
          type: 'quiz_result',
          ts: nowIso(),
          user: currentUser(dir),
          componentId,
          dim: opts.dim as DimName,
          score: Number(opts.score),
          sha,
          origin,
        };
      }

      // Append the raw outcome (schema-validated), then re-materialize so the
      // component's state/dims reflect it immediately.
      try {
        await appendEvidence(dir, entry);
      } catch (err) {
        console.error(`scale: invalid outcome — ${(err as Error).message.split('\n')[0]}`);
        process.exitCode = 1;
        return;
      }
      const res = recomputeCoverageFromDisk(cwd);
      const comp = res.coverage.components[componentId];
      if (!comp) {
        console.log(
          `scale: recorded outcome for "${componentId}" (not a known map component).`,
        );
        return;
      }
      console.log(
        `scale: ${componentId} → ${comp.state}  ` +
          `[structure ${fmt(comp.dims.structure)}, concepts ${fmt(comp.dims.concepts)}, ` +
          `rationale ${fmt(comp.dims.rationale)}]`,
      );
      // Progress line: weighted comprehension vs. the validate bar. EMA cold-start
      // (α=0.3 from 0) means several strong passes are needed to cross the bar, so
      // surface exactly how close this component is and whether it's over yet.
      const mean = meanDims(comp.dims);
      const validateDim = readConfigSafe(dir)?.thresholds.validateDim ?? 0.6;
      const verdict =
        comp.state === 'validated' ? 'validated' : 'needs more validation';
      console.log(
        `  ${componentId}: ${comp.state} — comprehension ${mean.toFixed(2)} / ` +
          `${validateDim.toFixed(2)} (${verdict})`,
      );
    },
  );

// ---------------------------------------------------------------------------
// coverage recompute  (REAL) — re-materialize coverage.json from evidence.jsonl
// ---------------------------------------------------------------------------
const coverage = program
  .command('coverage')
  .description('Coverage materialization (coverage.json is a view of evidence.jsonl)');

coverage
  .command('recompute')
  .description('Re-materialize ~/.scale/<repo-id>/coverage.json from evidence.jsonl')
  .action(() => {
    const res = recomputeCoverageFromDisk(process.cwd());
    const c = coverageCounts(res.coverage, res.map);
    console.log(
      `scale: ${c.total} component(s) — ` +
        `${c.validated} validated, ${c.explored} explored, ${c.stale} stale, ${c.fog} fog.`,
    );
    console.log(`  unification progress: ${Math.round(c.progress * 100)}%`);
    console.log(`  → ${paths.coverage(res.dir)}`);
  });

// ---------------------------------------------------------------------------
// estimate  (REAL) — pre-flight build-cost estimate for `scale-map` (Mode B)
// Pure fs scan + arithmetic (no LLM, no API) — safe to run before committing to
// an (expensive) coverage-memory build. See @scale/core estimate.ts (PLAN §4.3).
// ---------------------------------------------------------------------------

/** Source extensions counted toward the build-cost estimate. */
const SOURCE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java',
  '.rb', '.php', '.c', '.h', '.cpp', '.cs', '.swift', '.kt', '.scala', '.vue', '.svelte',
]);

/** Directory names never descended into during the scan. */
const EXCLUDE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', 'coverage', 'vendor',
  '.scale', 'test', 'tests', '__tests__', 'web-dist', 'graphify-out',
]);

/** `foo.test.ts` / `bar.spec.js` etc. — excluded so the count is real source. */
function isTestFile(name: string): boolean {
  return /\.(test|spec)\./i.test(name);
}

/**
 * True when a file announces itself machine-generated in its opening lines.
 *
 * A build artifact that is COMMITTED escapes every directory rule — this repo's
 * own `packages/plugin/bin/scale.mjs` is a ~30k-line bundle, several times the
 * real source, and counting it inflated every build estimate by roughly 6×. The
 * `@generated` marker is the common convention for saying so, and matching it
 * generalizes to any target repo that follows it.
 */
function isGeneratedFile(full: string): boolean {
  let fd: number | undefined;
  try {
    // Read only the head: the marker is a banner, and these files can be huge.
    fd = fs.openSync(full, 'r');
    const buf = Buffer.alloc(256);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return /@generated|@preserve GENERATED|DO NOT EDIT/i.test(buf.subarray(0, n).toString('utf8'));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Walk `root` counting source lines (wc -l semantics: newline bytes) across
 * SOURCE_EXTS, skipping EXCLUDE_DIRS and test/spec files. Pure fs, no git.
 */
function scanSourceLoc(root: string): { files: number; loc: number } {
  let files = 0;
  let loc = 0;
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const name = e.name;
      const full = path.join(d, name);
      if (e.isDirectory()) {
        if (EXCLUDE_DIRS.has(name)) continue;
        walk(full);
      } else if (e.isFile()) {
        const ext = path.extname(name).toLowerCase();
        if (!SOURCE_EXTS.has(ext) || isTestFile(name)) continue;
        if (isGeneratedFile(full)) continue;
        try {
          const buf = fs.readFileSync(full);
          let n = 0;
          for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
          files++;
          loc += n;
        } catch {
          /* unreadable file — skip */
        }
      }
    }
  };
  walk(root);
  return { files, loc };
}

const usd = (n: number): string => `$${n.toFixed(2)}`;

/** Render the human-readable estimate table + header/footer. */
function renderEstimate(files: number, est: BuildEstimate): string {
  const lines: string[] = [];
  lines.push(
    `repo: ${files} files, ${est.loc.toLocaleString()} LOC → ~${est.components} components`,
  );
  lines.push('');

  const minutes = Math.round(est.minutes);
  const rows = est.models.map((m) => {
    const cost =
      m.costHigh > m.costLow ? `${usd(m.costLow)}–${usd(m.costHigh)}` : usd(m.costLow);
    return { name: m.name, cost, time: `~${minutes} min` };
  });

  const nameW = Math.max('Build model'.length, ...rows.map((r) => r.name.length));
  const costW = Math.max(9, ...rows.map((r) => r.cost.length));
  const pad = (s: string, w: number): string => s + ' '.repeat(Math.max(0, w - s.length));
  lines.push(
    `${pad('Build model', nameW)}  ${pad('est. cost', costW)}  est. time (single-agent)`,
  );
  lines.push(`${'-'.repeat(nameW)}  ${'-'.repeat(costW)}  ------------------------`);
  for (const r of rows) {
    lines.push(`${pad(r.name, nameW)}  ${pad(r.cost, costW)}  ${r.time}`);
  }

  lines.push('');
  lines.push(
    `Rough estimate (±~50%), calibrated on a measured ${
      MEASURED_BUILD.sourceLoc.toLocaleString()
    }-LOC single-agent build. cache_read dominates and grows super-linearly for`,
  );
  lines.push(
    'large single-agent builds; province fan-out keeps cost ~linear and parallelizes',
  );
  lines.push(
    'time (wall-clock ≈ time / #provinces). Interventions (quiz/socratic) are separate',
  );
  lines.push(
    `and cheap (~${usd(0.15)}–${usd(1)}/session) and run on ${MODEL_RATES.sonnet5!.name} or ` +
      `${MODEL_RATES.opus48!.name} (config.models.intervention).`,
  );
  return lines.join('\n');
}

program
  .command('estimate')
  .description(
    'Estimate the Mode B scale-map build cost for the current repo (per model, ' +
      'before you run it). Pure fs scan + arithmetic — no LLM, no API.',
  )
  .option('--json', 'emit machine-readable JSON instead of the table', false)
  .action((opts: { json?: boolean }) => {
    const cwd = process.cwd();
    const { files, loc } = scanSourceLoc(cwd);
    const est = estimateBuild(loc);

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            repo: { files, loc },
            components: est.components,
            tokens: est.tokens,
            seconds: est.seconds,
            minutes: est.minutes,
            models: est.models,
          },
          null,
          2,
        ),
      );
      return;
    }
    console.log(renderEstimate(files, est));
  });

// ---------------------------------------------------------------------------
// quest generate|list|complete  (STUB; `list` reads quests.json if present)
// ---------------------------------------------------------------------------
const quest = program.command('quest').description('Post-session quests');

quest
  .command('generate')
  .description('Generate quests for low-coverage touched components (detached/LLM)')
  .option('-k, --top <n>', 'top-K components to quiz (default 3)', '3')
  .option('--detached', 'invoked detached from the SessionEnd hook (no-op flag)', false)
  .action(async (opts: { top?: string; detached?: boolean }) => {
    // Heavy + LLM: runs DETACHED off the SessionEnd hook (§6.2). Post-session
    // conditions only; in-flow → no-op. Never throws fatally (detached-safe):
    // the LLM path falls back to deterministic synthesis when there's no API key.
    const cwd = process.cwd();
    const parsedK = Number(opts.top);
    const topK = Number.isFinite(parsedK) && parsedK > 0 ? Math.floor(parsedK) : 3;
    try {
      const res = await generateQuests(cwd, { topK });
      if (res.via === 'skip') {
        console.log('scale: quest generate — no-op (in-flow condition or no coverage memory).');
        return;
      }
      console.log(
        `scale: generated ${res.count} quest(s) via ${res.via} ` +
          `(model ${res.model}) → ${res.path}`,
      );
      if (res.components.length > 0) {
        console.log(`  components: ${res.components.join(', ')}`);
      }
    } catch (err) {
      // Detached-safe: log and exit 0 so a failure never surfaces to the hook.
      console.error(`scale: quest generate failed (non-fatal) — ${(err as Error).message}`);
    }
  });

quest
  .command('list')
  .description('List pending quests from quests.json')
  .action(() => {
    const dir = stateDir();
    const quests = readQuestsSafe(dir);
    if (quests.length === 0) {
      console.log('scale: no quests found.');
      return;
    }
    for (const q of quests) {
      console.log(
        `  ${q.id}  [${q.status}]  ${q.componentId}  ${q.modality}/${q.origin}` +
          `  (${q.items.length} item(s))`,
      );
    }
  });

quest
  .command('complete')
  .description('Record a quest outcome, mark it completed, and update coverage')
  .argument('<questId>', 'quest to complete')
  .option('--results <json>', "quiz results: JSON array of {dim,score}, e.g. '[{\"dim\":\"concepts\",\"score\":1}]'")
  .option('--socratic <json>', "socratic rubric: JSON object of dim→score, e.g. '{\"structure\":0.8}'")
  .action(async (questId: string, opts: { results?: string; socratic?: string }) => {
    const cwd = process.cwd();
    const dir = stateDir(cwd);

    if (opts.results === undefined && opts.socratic === undefined) {
      console.error(
        "scale: usage — scale quest complete <questId> --results '<json [{dim,score}]>'" +
          "  (or --socratic '<json {dim:score}>')",
      );
      process.exitCode = 1;
      return;
    }

    // Both paths go through the SAME shared functions the web endpoint uses, so
    // a quest completes identically on the CLI and in the browser.
    let completion;
    if (opts.socratic !== undefined) {
      let dims: unknown;
      try {
        dims = JSON.parse(opts.socratic);
      } catch {
        console.error('scale: --socratic must be a JSON object of dim→score.');
        process.exitCode = 1;
        return;
      }
      completion = await completeSocraticQuest(cwd, questId, dims);
    } else {
      let results: unknown;
      try {
        results = JSON.parse(opts.results!);
      } catch {
        console.error('scale: --results must be a JSON array of {dim,score}.');
        process.exitCode = 1;
        return;
      }
      if (!Array.isArray(results)) {
        console.error('scale: --results must be a JSON array of {dim,score}.');
        process.exitCode = 1;
        return;
      }
      completion = await completeQuizQuest(cwd, questId, results);
    }

    if (!completion) {
      console.error(`scale: unknown quest "${questId}".`);
      process.exitCode = 1;
      return;
    }

    const { componentId, recorded, component } = completion;
    console.log(
      `scale: quest ${questId} completed — recorded ${recorded} result(s) for "${componentId}".`,
    );
    console.log(
      `  ${componentId} → ${component.state}  ` +
        `[structure ${fmt(component.dims.structure)}, concepts ${fmt(component.dims.concepts)}, ` +
        `rationale ${fmt(component.dims.rationale)}]`,
    );
    const mean = meanDims(component.dims);
    const validateDim = readConfigSafe(dir)?.thresholds.validateDim ?? 0.6;
    const verdict = component.state === 'validated' ? 'validated' : 'needs more validation';
    console.log(
      `  comprehension ${mean.toFixed(2)} / ${validateDim.toFixed(2)} (${verdict})`,
    );
  });

// ---------------------------------------------------------------------------
// map layout|drift|index  (STUB; `index` builds file→component from .scale/)
// ---------------------------------------------------------------------------
const map = program.command('map').description('Map layout, drift, and index operations');

map
  .command('layout')
  .description('Compute/extend the frozen spatial layout → .scale/map.json (deterministic)')
  .option(
    '--relayout',
    'recompute the whole layout from scratch (deterministic), ignoring existing ' +
      'coordinates; without it, existing node coords are preserved incrementally',
    false,
  )
  .action((opts: { relayout?: boolean }) => {
    const cwd = process.cwd();
    const scaleDir = path.join(cwd, '.scale');
    if (!fs.existsSync(scaleDir)) {
      console.error(`scale: no coverage-memory dir at ${scaleDir} — nothing to lay out.`);
      process.exitCode = 1;
      return;
    }
    const loaded = loadScaleDir(cwd);
    const existing = readMapJsonSafe(cwd);
    const existingIds = new Set((existing?.nodes ?? []).map((n) => n.id));
    const newCount = loaded.papers.filter((p) => !existingIds.has(p.id)).length;

    const mapJson = computeLayout(
      {
        provinces: loaded.provinces,
        nodes: loaded.papers.map((p) => ({ id: p.id, province: p.province })),
        edges: loaded.edges,
        builtFromSha: headSha(cwd) || existing?.builtFromSha || '',
      },
      // --relayout forces a full recompute; otherwise honor existing coords.
      opts.relayout ? null : existing,
      { relayout: !!opts.relayout },
    );

    fs.writeFileSync(
      path.join(scaleDir, 'map.json'),
      JSON.stringify(mapJson, null, 2) + '\n',
    );
    if (opts.relayout) {
      console.log(
        `scale: relaid out ${mapJson.nodes.length} components across ` +
          `${mapJson.provinces.length} provinces → .scale/map.json`,
      );
    } else {
      console.log(
        `scale: ${mapJson.provinces.length} province(s), ` +
          `${mapJson.nodes.length} component(s) (${newCount} new) → .scale/map.json`,
      );
    }
  });

map
  .command('drift')
  .description('Flag components whose sources changed since map.builtFromSha (minimal stub)')
  .action(() => {
    // Minimal documented stub (PLAN §4.3 / §5.1). Full drift wires real git
    // churn per component in Phase 3. For now: report the reference SHA the map
    // was built from vs current HEAD so the shape of the command is real.
    const cwd = process.cwd();
    const map = readMapJsonSafe(cwd);
    if (!map) {
      console.log('scale: no .scale/map.json — run `scale map layout` first.');
      return;
    }
    const head = headSha(cwd);
    console.log(
      `scale: map built from "${map.builtFromSha || '(unset)'}", HEAD is "${head || '(no git)'}".`,
    );
    console.log(
      '  drift detection (per-component source churn) — not implemented (Phase 3).',
    );
  });

map
  .command('index')
  .description('Build the file→component reverse index → .scale/index.json (gitignored)')
  .option('-o, --out <path>', 'write index JSON to this path (default .scale/index.json)')
  .action((opts: { out?: string }) => {
    const cwd = process.cwd();
    const scaleDir = path.join(cwd, '.scale');
    if (!fs.existsSync(scaleDir)) {
      console.error(`scale: no coverage-memory dir at ${scaleDir} — nothing to index.`);
      process.exitCode = 1;
      return;
    }
    const loaded = loadScaleDir(cwd);
    const index = buildFileComponentIndex(componentSourcesIndex(loaded));
    const outPath = opts.out
      ? path.resolve(cwd, opts.out)
      : path.join(scaleDir, 'index.json');
    fs.writeFileSync(outPath, JSON.stringify(index, null, 2) + '\n');
    console.log(
      `scale: indexed ${loaded.papers.length} component(s), ` +
        `${Object.keys(index).length} file(s) → ${path.relative(cwd, outPath) || outPath}`,
    );
  });

// ---------------------------------------------------------------------------
// serve  (REAL) — local web map app
// ---------------------------------------------------------------------------
program
  .command('serve')
  .description('Serve the local web map app (pure Node; reads .scale/ from cwd)')
  .option('-p, --port <number>', 'port', '4318')
  .option(
    '--host <addr>',
    'bind address; defaults to loopback. The server has no auth and accepts API ' +
      'keys, so only widen this on a trusted network',
    '127.0.0.1',
  )
  .action((opts: { port: string; host: string }) => {
    const port = Number(opts.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      console.error(`scale: invalid port "${opts.port}".`);
      process.exitCode = 1;
      return;
    }
    startServer({ port, host: opts.host, cwd: process.cwd() });
  });

// ---------------------------------------------------------------------------
// config get|set  (REAL) — read/write config.json validated by the schema
// ---------------------------------------------------------------------------
const config = program
  .command('config')
  .description('Read/write config.json (condition, budgets, thresholds)');

/** Resolve a dotted path within an object; returns undefined if absent. */
function getPath(obj: unknown, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>(
    (acc, k) =>
      acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined,
    obj,
  );
}

/** Immutably set a dotted path, returning a new object. */
function setPath(
  obj: Record<string, unknown>,
  dotted: string,
  value: unknown,
): Record<string, unknown> {
  const keys = dotted.split('.');
  const out = structuredClone(obj);
  let cursor: Record<string, unknown> = out;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]!;
    if (typeof cursor[k] !== 'object' || cursor[k] === null) cursor[k] = {};
    cursor = cursor[k] as Record<string, unknown>;
  }
  cursor[keys[keys.length - 1]!] = value;
  return out;
}

config
  .command('get')
  .description('Print config.json, or a single dotted key (e.g. condition.timing)')
  .argument('[key]', 'dotted key path')
  .action((key: string | undefined) => {
    const dir = stateDir();
    let cfg: ScaleConfig;
    try {
      cfg = readConfig(dir);
    } catch {
      console.error('scale: no config found — run `scale init` first.');
      process.exitCode = 1;
      return;
    }
    if (!key) {
      console.log(JSON.stringify(cfg, null, 2));
      return;
    }
    const value = getPath(cfg, key);
    if (value === undefined) {
      console.error(`scale: no such config key "${key}".`);
      process.exitCode = 1;
      return;
    }
    console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  });

config
  .command('set')
  .description('Set a dotted key and re-validate the whole config')
  .argument('<key>', 'dotted key path (e.g. condition.modality)')
  .argument('<value>', 'value (JSON if parseable, else string)')
  .action((key: string, rawValue: string) => {
    const dir = stateDir();
    let cfg: ScaleConfig;
    try {
      cfg = readConfig(dir);
    } catch {
      console.error('scale: no config found — run `scale init` first.');
      process.exitCode = 1;
      return;
    }
    // Try to parse as JSON (numbers, booleans, arrays, objects); else keep string.
    let value: unknown = rawValue;
    try {
      value = JSON.parse(rawValue);
    } catch {
      /* leave as string */
    }
    const next = setPath(cfg as unknown as Record<string, unknown>, key, value);
    try {
      const saved = writeConfig(dir, next);
      console.log(`scale: set ${key} → ${JSON.stringify(getPath(saved, key))}`);
    } catch (err) {
      console.error(`scale: invalid config after set — ${(err as Error).message}`);
      process.exitCode = 1;
    }
  });

// ---------------------------------------------------------------------------
// reset  (REAL) — clear the state dir, with a confirmation guard
// ---------------------------------------------------------------------------
program
  .command('reset')
  .description('Delete the ~/.scale/<repo-id>/ state dir (demo/pilot reset)')
  .option('-y, --yes', 'skip the confirmation prompt', false)
  .action(async (opts: { yes?: boolean }) => {
    const dir = stateDir();
    if (!fs.existsSync(dir)) {
      console.log(`scale: nothing to reset (no state at ${dir}).`);
      return;
    }
    if (!opts.yes) {
      const ok = await confirm(`Delete all SCALE state at ${dir}? [y/N] `);
      if (!ok) {
        console.log('scale: reset aborted.');
        return;
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`scale: reset — removed ${dir}`);
  });

function confirm(prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

// ---------------------------------------------------------------------------

program.parseAsync(process.argv).catch((err) => {
  console.error(`scale: ${(err as Error).message}`);
  process.exit(1);
});
