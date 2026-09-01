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
  type Language,
  type EvidenceEntry,
  type MapJson,
  type LoadedScale,
  type DimName,
  type FileComponentIndex,
  type MapEdge,
  buildFileComponentIndex,
  loadScaleDir,
  paperById,
  componentSourcesIndex,
  componentsForFile,
  computeLayout,
  emptyComponentCoverage,
  meanDims,
  gateEditDecision,
  pathMatchesAny,
  migrateLegacyConfig,
  resolveConfig,
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
import { loadDependsOnEdges, DEPS_MIN_COUNT } from './deps.js';
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
  readConfigSafe,
  readCoverageSafe,
  readUserConfigRaw,
  writeUserConfigRaw,
  readPolicyRaw,
  loadEffectiveConfig,
  readLocksSafe,
  noteCheckOutcome,
  appendEvidence,
  readQuestsSafe,
  type SessionRecord,
  defaultSession,
  readSessionSafe,
  writeSession,
  readPendingEdits,
  writePendingEdits,
  withSessionLock,
  isSessionAdoptable,
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

/**
 * Score at or above which a single check counts as `completed` rather than
 * `attempted`. This is the tutor rubric's band boundary (0.0-0.3 cannot state
 * it / 0.4-0.6 shaky / 0.7-1.0 explains it), NOT `thresholds.validateDim` —
 * that bar measures a component's cumulative comprehension across many checks
 * and is not comparable to one item's score.
 */
const ITEM_PASS_SCORE = 0.5;

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
    } else if (
      type === 'intervention' &&
      // 'attempted' counts: a check the junior got WRONG is still a check that
      // was delivered, and the gate's job is delivery, not a pass mark (PLAN
      // §6.1). The failure is recorded and visible in the score; it does not
      // hold the commit hostage.
      (e.outcome === 'deferred' || e.outcome === 'completed' || e.outcome === 'attempted')
    ) {
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

    // SPARSE on purpose (PLAN-GATE §2): only the user label is an explicit
    // choice here. Everything else resolves at read time from schema defaults
    // and the repo's committed team policy, so a later policy change actually
    // reaches this user instead of being shadowed by materialized defaults.
    writeUserConfigRaw(dir, { user: opts.user ?? process.env.USER ?? 'user' });
    const eff = loadEffectiveConfig(process.cwd(), dir);

    console.log(`scale: initialized state for repo-id "${resolveRepoId()}"`);
    console.log(`  dir:    ${dir}`);
    console.log(`  config: ${paths.config(dir)}`);
    console.log(
      `  gate: ${eff.config.gate.assessment}/${eff.config.gate.modality} ` +
        `(${eff.config.gate.enforcement})  user: ${eff.config.user}` +
        (eff.policyApplied ? '  [team policy applied]' : ''),
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

    // The interruption budget belongs to the REPO's current work period, not to
    // a window. Matching on session id alone still reset it whenever a SECOND
    // Claude Code window opened here, which silently refilled the counter and
    // nulled the cooldown — so `gate.ts`'s "≤ maxPerSession per session" was not
    // true. Any still-active record is therefore adopted, whichever session id
    // it carries, and a fresh budget starts only once the repo has gone quiet
    // long enough to be a new work period (see isSessionAdoptable).
    const sessionId = sessionIdOf(await readHookPayload()) || crypto.randomUUID();
    const contextConfig = loadEffectiveConfig(cwd, dir).config;
    const backstopMs = contextConfig.budgets.sessionIdleResetMinutes * 60_000;
    // Under the lock: two windows starting together would otherwise both read
    // "no adoptable record" and both write a fresh budget, and a gate reading
    // between the truncate and the write would see a torn file.
    withSessionLock(dir, () => {
      const existing = readSessionSafe(dir);
      // A new budget period begins only when the previous one is actually over:
      // either every window that was attached to it has closed (openWindows back
      // to zero), or the idle backstop fired because a SessionEnd was lost. A
      // window opening alongside others JOINS the running period — that is what
      // makes `maxPerSession` count a stretch of work rather than a terminal.
      const continuing = existing && isSessionAdoptable(existing, backstopMs) && existing.openWindows > 0;
      const next = continuing
        ? { ...existing, openWindows: existing.openWindows + 1 }
        : { ...defaultSession(sessionId, nowIso()), openWindows: 1 };
      writeSession(dir, next);
    });

    let res: RecomputeResult;
    try {
      res = recomputeCoverageFromDisk(cwd);
    } catch (err) {
      console.log(`SCALE: coverage unavailable (${(err as Error).message}).`);
      return;
    }
    // Per-user interaction language (config is optional pre-`init` → 'en').
    console.log(contextSummary(res, contextConfig.language));
  });

// ---------------------------------------------------------------------------
// session end  (REAL) — SessionEnd hook: release this window's hold on the
// budget period. Pure file read/write under the session lock, no LLM.
// ---------------------------------------------------------------------------
const session = program
  .command('session')
  .description('Budget-period accounting for the interruption gate (PLAN §6.1)');

session
  .command('end')
  .description(
    'Release this window\'s hold on the current budget period (SessionEnd hook). ' +
      'When the last window closes the period ends, so the NEXT SessionStart ' +
      'starts a fresh interruption budget.',
  )
  .action(async () => {
    const cwd = process.cwd();
    const dir = stateDir(cwd);
    // Nothing to release if state was never set up — stay silent and exit 0 so
    // the hook is a clean no-op.
    if (!readSessionSafe(dir)) return;

    const remaining = withSessionLock(dir, () => {
      const existing = readSessionSafe(dir);
      if (!existing) return null;
      const openWindows = Math.max(0, existing.openWindows - 1);
      writeSession(dir, { ...existing, openWindows });
      return openWindows;
    });
    // Lock contention here is harmless: the idle backstop still ends the period,
    // and under-counting a close only means the budget persists a little longer,
    // which errs toward fewer interruptions.
    if (remaining === null) return;
    console.log(
      remaining === 0
        ? 'scale: budget period ended (last window closed).'
        : `scale: window released (${remaining} still open).`,
    );
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
  const eff = loadEffectiveConfig(cwd, dir);
  const config = eff.config;
  const quests = readQuestsSafe(dir);
  const pending = quests.filter((q) => q.status === 'pending');
  const locks = readLocksSafe(dir);

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

  // A component is unlocked for editing when a passed check put it in the
  // ledger OR it is validated (grandfathered) — mirror of gateEditDecision.
  const unlockedSet = new Set(Object.keys(locks.components));
  const unlockedCount = map.nodes.filter(
    (n) =>
      unlockedSet.has(n.id) || (coverage.components[n.id]?.state ?? 'fog') === 'validated',
  ).length;

  return {
    repoId: resolveRepoId(cwd),
    user: config.user,
    gate: config.gate,
    policy: {
      present: eff.policyPresent,
      applied: eff.policyApplied,
      error: eff.policyError,
    },
    locks: { unlocked: unlockedCount, locked: map.nodes.length - unlockedCount },
    models: config.models,
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
  const gateLabel = s.gate.enabled
    ? `${s.gate.assessment}/${s.gate.modality} (${s.gate.enforcement})`
    : 'disabled';
  // Intervention model only — the build model is the Claude Code session's, not
  // anything SCALE stores (see ModelsConfigSchema).
  const models = resolveInterventionModel(s.models);
  lines.push(`  user: ${s.user}   gate: ${gateLabel}   models: ${models}`);
  const policyLabel = s.policy.applied
    ? 'team defaults applied'
    : s.policy.present
      ? `present but ignored — ${s.policy.error ?? 'invalid'}`
      : 'none';
  lines.push(
    `  policy: ${policyLabel}   territories unlocked for editing: ` +
      `${s.locks.unlocked}/${s.locks.unlocked + s.locks.locked}`,
  );
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
// gate edit  (REAL) — deterministic edit-gate decision (hook path, no LLM)
// ---------------------------------------------------------------------------
const gate = program
  .command('gate')
  .description(
    'Edit-gate policy decisions (PLAN-GATE §3). `edit` answers the ' +
      "PreToolUse(Edit|Write|MultiEdit) hook; `defer` is the user's " +
      'session-scoped skip.',
  );

/** Fresh in-flow markers older than this are ignored (PLAN §6.1 TTL). */
const MARKER_TTL_MINUTES = 10;

gate
  .command('edit')
  .description(
    'Decide whether an Edit/Write into locked territory is denied. Reads the ' +
      'PreToolUse hook payload on stdin, prints one JSON line ' +
      '{"allow":bool,"component":str|null,"reason":str|null}, always exit 0. ' +
      'Pure file I/O — no LLM, no network, and no coverage recompute (edits ' +
      'are too frequent for git churn scans; the snapshot is read as-is). ' +
      'The hook (not the CLI) blocks the edit.',
  )
  .action(async () => {
    const cwd = process.cwd();
    const dir = stateDir(cwd);

    // Always emit a single JSON line + exit 0; the CLI never itself blocks.
    const emit = (allow: boolean, component: string | null, reason: string | null): void => {
      console.log(JSON.stringify({ allow, component, reason }));
    };

    const payload = await readHookPayload();
    const files = editedFilesOf(payload).map((f) => relToRepo(cwd, f));
    const sessionId = sessionIdOf(payload);

    // Record propose timestamps for the diff_review pairing FIRST, whatever the
    // decision — this call replaced `log review`'s propose phase in the
    // pre-edit hook, and post-edit still closes the pair (PLAN §5 diff_review).
    if (files.length > 0) {
      const pending = readPendingEdits(dir);
      const at = nowIso();
      for (const f of files) pending[pendingKey(sessionId, f)] = at;
      writePendingEdits(dir, pending);
    }

    // No files, or no coverage memory at all → nothing is locked.
    if (files.length === 0 || !fs.existsSync(path.join(cwd, '.scale'))) {
      emit(true, null, null);
      return;
    }

    // Effective config: schema defaults < committed team policy < user
    // overrides (PLAN-GATE §2). A broken policy fails open to user-only.
    const config = loadEffectiveConfig(cwd, dir).config;
    if (!config.gate.enabled) {
      emit(true, null, null);
      return;
    }

    // Exempt paths out, then files → components through the EXACT index only.
    // The nearest-directory fallback is banned on this path (PLAN-GATE §3.2-1):
    // it sprays an unanchored file across every component in the directory
    // (measured at up to 11 here), which would gate new-file creation on a
    // dozen unrelated unlocks. A file no paper anchors gates nothing.
    const kept = files.filter((f) => !pathMatchesAny(f, config.exempt.paths));
    if (kept.length === 0) {
      emit(true, null, null);
      return;
    }
    const index = loadFileComponentIndex(cwd, loadScaleDir(cwd));
    const touched = new Set<string>();
    for (const f of kept) for (const id of index[f] ?? []) touched.add(id);
    if (touched.size === 0) {
      emit(true, null, null);
      return;
    }

    // Coverage SNAPSHOT (latency contract §7.1 — no recompute per edit). An
    // absent snapshot means every component reads as fog, which locks exactly
    // as a never-checked user should be locked.
    const coverage =
      readCoverageSafe(dir) ?? { user: currentUser(dir), updatedAt: '', components: {} };
    const map = readMapJsonSafe(cwd);
    const importance: Record<string, number> = {};
    if (map) for (const n of map.nodes) importance[n.id] = n.importance;
    const locks = readLocksSafe(dir);

    // Budget accounting is a read-decide-write; take the session lock for the
    // whole decision (same rationale as the old commit gate: losing the race
    // means another gate is deciding right now, so allow).
    const decided = withSessionLock(dir, () => {
      const stored = readSessionSafe(dir);
      const session: SessionRecord =
        stored && isSessionAdoptable(stored, config.budgets.sessionIdleResetMinutes * 60_000)
          ? stored
          : defaultSession(sessionId || crypto.randomUUID(), nowIso());

      const now = nowIso();
      const recentlyAddressed = recentlyAddressedComponents(
        dir,
        new Date(now),
        MARKER_TTL_MINUTES,
      );

      const decision = gateEditDecision({
        touched: [...touched],
        coverage,
        config,
        session: {
          interventionsThisSession: session.interventionsThisSession,
          lastInterventionAt: session.lastInterventionAt,
          pendingComponent: session.pendingComponent,
        },
        unlocked: Object.keys(locks.components),
        sessionSkips: session.sessionSkips,
        recentlyAddressed,
        now,
        importance,
      });

      if (decision.action === 'deny' && decision.component) {
        if (decision.spendBudget) {
          // A fresh deny: spend a budget slot INSIDE the lock.
          writeSession(dir, {
            ...session,
            interventionsThisSession: session.interventionsThisSession + 1,
            lastInterventionAt: now,
            pendingComponent: decision.component,
          });
          return {
            kind: 'deny' as const,
            component: decision.component,
            reason: decision.reason ?? null,
            now,
          };
        }
        // A re-deny of the still-pending component: no budget movement, and no
        // second `requested` evidence row — the intervention is already open.
        return {
          kind: 'redeny' as const,
          component: decision.component,
          reason: decision.reason ?? null,
          now,
        };
      }

      if (decision.advisory && decision.component) {
        // Advisory: no budget spend, no block — the evidence row written
        // outside the lock enters recentlyAddressed and rate-limits repeats.
        return { kind: 'advisory' as const, component: decision.component, now };
      }

      // Allow. Clear the pending marker if this allow resolved it.
      if (session.pendingComponent && recentlyAddressed.includes(session.pendingComponent)) {
        writeSession(dir, { ...session, pendingComponent: null });
      }
      return null;
    });

    if (!decided) {
      // Either the gate allowed, or the lock was contended and another gate is
      // mid-decision. Both allow.
      emit(true, null, null);
      return;
    }

    if (decided.kind === 'redeny') {
      emit(false, decided.component, decided.reason);
      return;
    }

    // Accounting rows land outside the lock (async append, best-effort — a
    // write failure must not turn the decision into noise).
    if (decided.kind === 'advisory') {
      try {
        await appendEvidence(dir, {
          type: 'intervention',
          ts: decided.now,
          user: currentUser(dir),
          componentId: decided.component,
          timing: 'inflow',
          modality: config.gate.modality,
          outcome: 'advisory',
          trigger: 'edit',
        });
      } catch {
        /* keep going */
      }
      emit(true, decided.component, null);
      return;
    }

    try {
      await appendEvidence(dir, {
        type: 'intervention',
        ts: decided.now,
        user: currentUser(dir),
        componentId: decided.component,
        timing: 'inflow',
        modality: config.gate.modality,
        outcome: 'requested',
        trigger: 'edit',
      });
    } catch {
      /* keep going — the deny is what matters to the hook */
    }
    emit(false, decided.component, decided.reason);
  });

// ---------------------------------------------------------------------------
// gate defer  (REAL) — the user's "skip" escape hatch (defer = drop, PLAN §6.1)
// ---------------------------------------------------------------------------
gate
  .command('defer')
  .description(
    'Skip the edit-gate check for a component (PLAN-GATE §3.1): a SESSION-scoped ' +
      'unlock. The territory stops gating until the current budget period ends, ' +
      'then locks again — nothing is queued, nothing is durably unlocked. ' +
      'Pure file append, no LLM.',
  )
  .argument('<componentId>', 'component whose edit-gate check the user is skipping')
  .option(
    '--by <who>',
    "who chose to skip: 'user' (the junior declined) or 'agent' (the agent " +
      'skipped without asking, e.g. no junior was in the loop). Only ' +
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
    // Modality is accounting metadata; effective config works pre-`init`.
    const config = loadEffectiveConfig(cwd, dir).config;
    const now = nowIso();

    // Two clears, and both matter: the evidence marker satisfies the immediate
    // retry (recentlyAddressed, TTL 10 min), while `sessionSkips` holds the
    // skip open for the REST of the budget period — skip means "not this
    // session", not "not for the next ten minutes".
    await appendEvidence(dir, {
      type: 'intervention',
      ts: now,
      user: currentUser(dir),
      componentId,
      timing: 'inflow',
      modality: config.gate.modality,
      outcome: 'deferred',
      trigger: 'edit',
      by: opts.by,
    });

    withSessionLock(dir, () => {
      const stored = readSessionSafe(dir);
      const session: SessionRecord =
        stored && isSessionAdoptable(stored, config.budgets.sessionIdleResetMinutes * 60_000)
          ? stored
          : defaultSession(crypto.randomUUID(), now);
      writeSession(dir, {
        ...session,
        sessionSkips: session.sessionSkips.includes(componentId)
          ? session.sessionSkips
          : [...session.sessionSkips, componentId],
        pendingComponent:
          session.pendingComponent === componentId ? null : session.pendingComponent,
      });
    });

    console.log(
      `scale: skipped '${componentId}' (by ${opts.by}) — unlocked for THIS session only; ` +
        'retry the edit. It locks again next session.',
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
  .option(
    '--by <who>',
    "who produced this result: 'user' (the junior answered) or 'agent' (the " +
      'agent answered on their behalf). Only a user result is comprehension ' +
      'data; an agent result still satisfies the gate but is excluded from the ' +
      "junior's scores in analysis",
    'user',
  )
  .action(
    async (
      componentId: string,
      opts: { dim?: string; score?: string; socratic?: string; origin?: string; by?: string },
    ) => {
      const cwd = process.cwd();
      const dir = stateDir(cwd);
      if (opts.origin !== 'session' && opts.origin !== 'voluntary') {
        console.error("scale: --origin must be 'session' or 'voluntary'.");
        process.exitCode = 1;
        return;
      }
      if (opts.by !== 'user' && opts.by !== 'agent') {
        console.error(`scale: --by must be 'user' or 'agent' (got '${opts.by}').`);
        process.exitCode = 1;
        return;
      }
      const origin = opts.origin;
      const by = opts.by;
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
          by,
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
          by,
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
      // Close the in-flow intervention this result answers. The gate opened it
      // with outcome 'requested' and nothing ever closed it, so `completed` had
      // a consumer and no producer and a FAILED check was indistinguishable from
      // a passed one in the accounting stream. A recorded result still satisfies
      // the gate whatever it scored — the gate delivers checks, it does not
      // withhold commits until the junior is right (PLAN §6.1) — so the honest
      // fix is to name the difference, not to start blocking.
      const achieved =
        entry.type === 'quiz_result'
          ? entry.score
          : (() => {
              const vals = Object.values(entry.dims).filter(
                (v): v is number => typeof v === 'number',
              );
              return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
            })();
      // NOT `thresholds.validateDim`. That bar is cumulative — it asks whether a
      // component has been understood across repeated checks — and one item's
      // score is not comparable to it. This is the tutor rubric's own boundary:
      // 0.0-0.3 is "cannot state it", 0.4-0.6 "shaky", 0.7-1.0 "explains it", so
      // anything above the bottom band demonstrated something.
      const outcome = achieved >= ITEM_PASS_SCORE ? 'completed' : 'attempted';
      // `timing` reports the assessment this user is assigned to — never
      // re-derived from where the check came from (deriving it from `--origin`
      // once mislabeled in both directions). The legacy evidence vocabulary is
      // kept: sync → 'inflow', async → 'postsession'.
      const effConfig = loadEffectiveConfig(cwd, dir).config;
      try {
        await appendEvidence(dir, {
          type: 'intervention',
          ts: entry.ts,
          user: entry.user,
          componentId,
          timing: effConfig.gate.assessment === 'async' ? 'postsession' : 'inflow',
          modality: entry.type === 'quiz_result' ? 'quiz' : 'socratic',
          outcome,
          by,
        });
      } catch {
        /* accounting only — the graded result above is what moves coverage */
      }

      // The unlock ledger (PLAN-GATE §3.1): a passed check BY THE USER opens
      // the edited territory durably. Single funnel shared with quest
      // completion, so the ledger cannot disagree across surfaces.
      const unlock = noteCheckOutcome(cwd, dir, componentId, achieved, by, sha, entry.ts);

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
      const validateDim = effConfig.thresholds.validateDim;
      const verdict =
        comp.state === 'validated' ? 'validated' : 'needs more validation';
      console.log(
        `  ${componentId}: ${comp.state} — comprehension ${mean.toFixed(2)} / ` +
          `${validateDim.toFixed(2)} (${verdict})`,
      );
      if (unlock.unlocked) {
        console.log(`  territory UNLOCKED for editing (check passed, by ${by}).`);
      } else if (!unlock.alreadyUnlocked && unlock.checks > 0) {
        console.log(
          `  unlock progress: ${unlock.checks}/${effConfig.unlock.checksRequired} passed check(s).`,
        );
      }
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
  .option(
    '--by <who>',
    "who produced these answers: 'user' (the junior) or 'agent'. Same contract " +
      'as `scale record --by`: an agent answering on the junior\'s behalf must ' +
      'say so, or it lands in the study as the junior\'s comprehension',
    'user',
  )
  .action(async (questId: string, opts: { results?: string; socratic?: string; by?: string }) => {
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
    if (opts.by !== 'user' && opts.by !== 'agent') {
      console.error(`scale: --by must be 'user' or 'agent' (got '${opts.by}').`);
      process.exitCode = 1;
      return;
    }
    const by = opts.by;

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
      completion = await completeSocraticQuest(cwd, questId, dims, by);
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
      completion = await completeQuizQuest(cwd, questId, results, by);
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
    const validateDim = loadEffectiveConfig(cwd, dir).config.thresholds.validateDim;
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

    const nodeIds = new Set(loaded.papers.map((p) => p.id));
    const dependsOn = loadDependsOnEdges(cwd, nodeIds);
    const mapJson = computeLayout(
      {
        provinces: loaded.provinces,
        nodes: loaded.papers.map((p) => ({ id: p.id, province: p.province })),
        edges: [...loaded.edges, ...dependsOn],
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
      if (dependsOn.length > 0) {
        console.log(
          `scale: merged ${dependsOn.length} depends_on edge(s) from .scale/deps.json ` +
            `(min ${DEPS_MIN_COUNT} AST edges).`,
        );
      }
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
  .description(
    'Read/write the user config (gate, budgets, thresholds). `get` shows the ' +
      'EFFECTIVE config (schema defaults < team policy < your overrides); ' +
      '`set` writes a personal override into your sparse config.json.',
  );

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
  .description('Print the EFFECTIVE config, or a single dotted key (e.g. gate.assessment)')
  .argument('[key]', 'dotted key path')
  .option('--raw', 'print your sparse user overrides file instead of the effective view', false)
  .action((key: string | undefined, opts: { raw?: boolean }) => {
    const cwd = process.cwd();
    const dir = stateDir(cwd);
    if (!configExists(dir)) {
      console.error('scale: no config found — run `scale init` first.');
      process.exitCode = 1;
      return;
    }
    const view: unknown = opts.raw
      ? (readUserConfigRaw(dir) ?? {})
      : loadEffectiveConfig(cwd, dir).config;
    if (!key) {
      console.log(JSON.stringify(view, null, 2));
      return;
    }
    const value = getPath(view, key);
    if (value === undefined) {
      console.error(`scale: no such config key "${key}".`);
      process.exitCode = 1;
      return;
    }
    console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  });

config
  .command('set')
  .description(
    'Set a dotted key as a personal override (kept sparse so team-policy ' +
      'defaults stay live) and re-validate the effective config',
  )
  .argument('<key>', 'dotted key path (e.g. gate.modality)')
  .argument('<value>', 'value (JSON if parseable, else string)')
  .action((key: string, rawValue: string) => {
    const cwd = process.cwd();
    const dir = stateDir(cwd);
    if (!configExists(dir)) {
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
    // Operate on the RAW sparse file, never the materialized view — writing the
    // effective config back would freeze every default as an explicit override.
    // Legacy keys (condition.*, inflow.*) are migrated on the way through, so a
    // `set condition.timing inflow` still lands as the gate.* it means.
    const raw = readUserConfigRaw(dir) ?? { user: process.env.USER ?? 'user' };
    const next = migrateLegacyConfig(setPath(raw, key, value)) as Record<string, unknown>;
    const policy = readPolicyRaw(cwd);
    try {
      resolveConfig(next, policy.parseError ? undefined : policy.raw); // validate effective
      writeUserConfigRaw(dir, next);
      const effective = loadEffectiveConfig(cwd, dir).config;
      console.log(`scale: set ${key} → ${JSON.stringify(getPath(next, key) ?? getPath(effective, key))}`);
    } catch (err) {
      console.error(`scale: invalid config after set — ${(err as Error).message.split('\n')[0]}`);
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
