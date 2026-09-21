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
import { execFileSync, spawn } from 'node:child_process';

import { Command } from 'commander';
import {
  checkPartition,
  partitionPasses,
  GRANULARITY_MAX_PER_FILE,
  partitionTarget,
  CHILDREN_PER_NODE,
  PER_LOC,
  type Language,
  type ScaleConfig,
  type EvidenceEntry,
  type MapJson,
  type LoadedScale,
  type DimName,
  type FileComponentIndex,
  type MapEdge,
  buildFileComponentIndex,
  loadScaleDir,
  docById,
  slugify,
  componentSourcesIndex,
  componentsForFile,
  computeLayout,
  emptyComponentCoverage,
  meanDims,
  gateEditDecision,
  checkBrief,
  quizSpecLine,
  causeOfDrift,
  pathMatchesAny,
  migrateLegacyConfig,
  resolveConfig,
  isLead,
  policyLeads,
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
  DEFAULT_TOP_K,
} from './quest.js';
import {
  buildReviewQueue,
  formatReviewItem,
  formatReviewDiff,
  gitTerritoryDiff,
  readEvidenceRecords,
  reviewAlreadyOpened,
  territoryFiles,
  touchedSinceLastCheck,
  DEFAULT_DIFF_MAX_BYTES,
} from './review.js';
import { loadDependsOnEdges, DEPS_MIN_COUNT } from './deps.js';
import { translateDoc } from './translate.js';
import {
  loadFileComponentIndex,
  recomputeCoverageFromDisk,
  myIdentities,
  currentIdentityEmails,
  coverageCounts,
  type RecomputeResult,
} from './coverage.js';

import {
  pruneLocksToKnown,
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
  syncLocksWithDrift,
  pendingDigest,
  markDigestShown,
  notePendingUnlock,
  clearPendingUnlock,
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
  appendTelemetry,
  readTelemetrySafe,
  recordConfigDelta,
  outOfBandEdits,
  summarizeTelemetry,
} from './telemetry.js';
import { unsetPath, explainConfig, LlmProviderSchema } from '@scale/core';
import {
  ensureServer,
  stopServer,
  resolveViewer,
  viewerUrl,
  agentViewerBase,
  publicViewerUrl,
  DEFAULT_PORT,
} from './serve-state.js';
import { buildSetupStatus } from './setup.js';
import { keyStatus, setKeyFromInput } from './keys.js';
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
  for (const p of loaded.docs) {
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

/** Round a coverage progress/dim value to a compact 0.x string. */
function fmt(n: number): string {
  return n.toFixed(2).replace(/\.?0+$/, '') || '0';
}

/**
 * Build the ≤3-line SessionStart coverage summary (injected into the agent's
 * context). Line 1: unification progress. Line 2: the weakest unconquered
 * territory. Line 3: territory that needs re-validation (stale). Kept terse.
 * On quiz modality one extra line states the check's shape (items/focus/
 * grounding) so the tutor never has to shell out for it. When the junior's
 * interaction language is 'ko', one more line tells the agent to deliver
 * comprehension checks in Korean; 'en' adds nothing.
 */
function contextSummary(
  res: RecomputeResult,
  config: ScaleConfig,
  dir: string,
  viewer: { url: string; running: boolean },
): string {
  const language: Language = config.language;
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
    )}% (${counts.validated} validated, ${counts.explored} explored, ${counts.fog} fog` +
      // `stale` was omitted, so a rebellion made the breakdown stop summing to
      // the total — "1 territories … (0 validated, 0 explored, 0 fog)".
      `${counts.stale > 0 ? `, ${counts.stale} stale` : ''}).`,
  );

  const weak = scored
    .filter((s) => s.state === 'fog' || s.state === 'explored')
    .sort((a, b) => a.mean - b.mean)
    .slice(0, 3)
    .map((s) => (s.state === 'fog' ? `${s.id} (fog)` : `${s.id} (explored ${fmt(s.mean)})`));
  if (weak.length > 0) lines.push(`You're weak on: ${weak.join(', ')}.`);

  // Rebellion digest. Cadence-limited (default daily) because on a real team
  // these arrive with every merged PR, and a notice repeated every session is a
  // notice nobody reads. It names WHO changed the territory — that is the whole
  // point of the authorship split, and it is what makes the re-lock legible
  // rather than arbitrary.
  const digest = pendingDigest(dir, config.drift.digest);
  if (digest.length > 0) {
    const shown = digest.slice(0, 3).map(({ id, entry }) => {
      const who =
        entry.cause === 'self'
          ? 'your own rewrite'
          : entry.foreignAuthors.length > 0
            ? entry.foreignAuthors.join(', ')
            : 'someone else';
      return `${id} (${who})`;
    });
    const more = digest.length > shown.length ? ` +${digest.length - shown.length} more` : '';
    lines.push(
      `Rebellion — ${digest.length} territory you had earned changed and is locked again: ` +
        `${shown.join('; ')}${more}. Pass its check (/scale-study <id>) to unlock it.`,
    );
    markDigestShown(dir);
  }

  const stale = scored.filter((s) => s.state === 'stale').map((s) => s.id);
  if (stale.length > 0) {
    lines.push(
      `${stale.length} territory needs re-validation (stale): ${stale.join(', ')}.`,
    );
  }

  // The lock picture, for the AGENT: how much of the map this user may edit,
  // and — for an async user — which denied territories still owe a check. This
  // is the reminder the async design promised ("later") and never delivered;
  // without it a denied component was forgotten the moment the session ended.
  const locks = readLocksSafe(dir);
  const unlockedSet = new Set(Object.keys(locks.components));
  const unlockedCount = map.nodes.filter(
    (n) => unlockedSet.has(n.id) || (coverage.components[n.id]?.state ?? 'fog') === 'validated',
  ).length;
  const owed = Object.keys(locks.pendingUnlocks).sort();
  if (owed.length > 0) {
    lines.push(
      `Unlocked for editing: ${unlockedCount}/${map.nodes.length}. ` +
        `${owed.length} territory still owes a check from an earlier denied edit: ` +
        `${owed.slice(0, 5).join(', ')}${owed.length > 5 ? ` +${owed.length - 5} more` : ''}. ` +
        `The junior can pass it with /scale-study <id> here, or in the map viewer ` +
          `at ${viewer.url} (/scale-open <id> opens that component's panel).`,
    );
  } else if (config.gate.enabled) {
    lines.push(`Unlocked for editing: ${unlockedCount}/${map.nodes.length}.`);
  }

  // The post-session CHAT review, as one line the agent can act on. `owed`
  // above names the async denies; this counts the whole queue — owed checks
  // PLUS territory touched since it was last checked — because that is what
  // `/scale-review` will actually walk. Reuses the coverage this command just
  // recomputed and reads evidence exactly once, so the SessionStart latency
  // budget (§7.1) pays for one extra file read and no git.
  const queued = buildReviewQueue({
    coverage,
    map,
    config,
    pending: locks.pendingUnlocks,
    touched: touchedSinceLastCheck(readEvidenceRecords(dir)),
    limit: DEFAULT_TOP_K,
  });
  if (queued.length > 0) {
    lines.push(
      language === 'ko'
        ? `review: 컴포넌트 ${queued.length}개가 검토를 기다리고 있습니다 — /scale-review`
        : `review: ${queued.length} component(s) waiting — /scale-review`,
    );
  }

  // The check's SHAPE, in the same words the deny reason uses. A junior who
  // raised `quiz.items` expects the NEXT check to be longer, and the tutor
  // only learns that from a line it is already reading (core's quizSpecLine).
  if (config.gate.modality === 'quiz') {
    lines.push(quizSpecLine(config.quiz));
  }

  // The viewer URL, so the agent can quote something clickable instead of
  // telling the junior to "run scale serve" — which is the terminal trip this
  // whole surface exists to remove.
  lines.push(
    `Map viewer: ${viewer.url}` +
      (viewer.running ? '' : ' (not running yet)') +
      ` — /scale-open opens it, /scale-open <id> opens one component.`,
  );

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
    if (eff.config.gate.modality === 'quiz') {
      console.log(`  ${quizSpecLine(eff.config.quiz)}`);
    }
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
    // Rebellion: this is the moment fresh git-measured drift exists, so it is
    // where re-locking happens (PLAN-GATE §4 S2). Territory the user had earned
    // and whose code has since moved goes back behind the gate.
    const detail: Record<
      string,
      { sinceSha?: string | null; foreignAuthors?: string[]; cause?: 'foreign' | 'self' }
    > = {};
    for (const [id, comp] of Object.entries(res.coverage.components)) {
      if (comp.state !== 'stale') continue;
      const c = res.churn[id];
      detail[id] = {
        sinceSha: comp.lastValidatedSha,
        foreignAuthors: c?.foreignAuthors ?? [],
        cause: causeOfDrift(c ?? { foreign: 0, self: 0 }, res.sizes[id] ?? 0, res.config) ?? 'foreign',
      };
    }
    syncLocksWithDrift(dir, res.coverage.components, detail);
    // The map is at hand here, so this is where a deleted/renamed doc stops
    // haunting the owed-check line and the viewer header (PLAN-GATE §14.4).
    pruneLocksToKnown(
      dir,
      res.map.nodes.map((n) => n.id),
    );

    // Per-user interaction language (config is optional pre-`init` → 'en').
    // The viewer probe is bounded (300 ms) because this is the SessionStart
    // hook path; a viewer that does not answer still yields its default URL.
    const view = await resolveViewer(cwd, {}, 300);
    console.log(
      // `publicViewerUrl`: this text is read by Claude and lands in the
      // transcript, so it must not carry the API bearer token.
      contextSummary(res, contextConfig, dir, {
        url: publicViewerUrl(view.url),
        running: view.running,
      }),
    );
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

    const closed = withSessionLock(dir, () => {
      const existing = readSessionSafe(dir);
      if (!existing) return null;
      const openWindows = Math.max(0, existing.openWindows - 1);
      writeSession(dir, { ...existing, openWindows });
      return { remaining: openWindows, session: existing };
    });
    // Lock contention here is harmless: the idle backstop still ends the period,
    // and under-counting a close only means the budget persists a little longer,
    // which errs toward fewer interruptions.
    if (closed === null) return;
    const remaining = closed.remaining;
    if (remaining === 0) {
      // The period is over: write its tallies and look for edits that went
      // around the tools (PLAN-GATE §15). One git read, off the edit path.
      const config = loadEffectiveConfig(cwd, dir).config;
      const now = nowIso();
      const locks = readLocksSafe(dir);
      const map = readMapJsonSafe(cwd);
      const s = closed.session;
      appendTelemetry(dir, {
        v: 1,
        type: 'session_end',
        ts: now,
        user: config.user,
        sessionId: s.sessionId,
        startedAt: s.startedAt,
        durationMs: s.startedAt ? Math.max(0, Date.parse(now) - Date.parse(s.startedAt)) : 0,
        ...s.counters,
        unlocked: Object.keys(locks.components).length,
        owed: Object.keys(locks.pendingUnlocks).length,
        components: map?.nodes.length ?? 0,
      });
      try {
        for (const row of outOfBandEdits(cwd, dir, s, now)) appendTelemetry(dir, { ...row, user: config.user });
      } catch {
        /* git unavailable — the tallies still landed */
      }
    }
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
/**
 * Who git thinks this user is, plus how much of the recent history that claim
 * actually matches. The ratio is the diagnostic: a participant whose laptop is
 * configured with a different address than their commits carry would otherwise
 * have every one of their own commits read as a collaborator's, re-locking the
 * whole map with nothing on screen to explain it.
 */
function resolveIdentityStatus(
  cwd: string,
  config: ScaleConfig,
): { emails: string[]; recentCommits: number; mineOfRecent: number } {
  const emails = [...myIdentities(cwd, config)].sort();
  const authors = git(cwd, ['log', '--format=%aE', '-50'])
    .split('\n')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const mine = emails.length === 0 ? 0 : authors.filter((a) => emails.includes(a)).length;
  return { emails, recentCommits: authors.length, mineOfRecent: mine };
}

function buildStatus(
  cwd: string,
  res: RecomputeResult,
  dir: string,
  viewer: { url: string; running: boolean },
) {
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
    rebellions: Object.keys(locks.drifted).sort(),
    identity: resolveIdentityStatus(cwd, config),
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
    viewer,
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
  // Identity is load-bearing and silently wrong is its worst failure: every
  // commit read as a stranger's re-locks the whole map, every commit read as
  // yours means rebellion never fires. Neither is visible anywhere else, so it
  // is stated here with the evidence — how much of the recent history it
  // actually matched.
  const idLabel =
    s.identity.emails.length > 0 ? s.identity.emails.join(', ') : '(none — all churn reads as yours)';
  lines.push(
    `  git identity: ${idLabel}` +
      (s.identity.recentCommits > 0
        ? `   (${s.identity.mineOfRecent}/${s.identity.recentCommits} of recent commits read as yours)`
        : ''),
  );
  if (s.rebellions.length > 0) {
    lines.push(`  re-locked by rebellion: ${s.rebellions.join(', ')}`);
  }
  // The map viewer is the other half of this CLI, and a URL is the only form of
  // it a junior can act on without a terminal — so it is stated here, with
  // whether it is actually up and what to type when it is not.
  lines.push(
    `  Map viewer: ${s.viewer.url}` +
      (s.viewer.running ? ' (running)' : ' (not running — /scale-open starts it)'),
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
  .action(async (opts: { json?: boolean }) => {
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
    const view = await resolveViewer(cwd, {}, 300);
    // Token-free: `scale status` (and its --json) is quoted back into chat.
    const status = buildStatus(cwd, res, dir, {
      url: publicViewerUrl(view.url),
      running: view.running,
    });
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
    // dozen unrelated unlocks. A file no doc anchors gates nothing.
    const kept = files.filter((f) => !pathMatchesAny(f, config.exempt.paths));
    if (kept.length === 0) {
      emit(true, null, null);
      return;
    }
    const index = loadFileComponentIndex(cwd, loadScaleDir(cwd));
    const touched = new Set<string>();
    let unanchored = 0;
    for (const f of kept) {
      const ids = index[f] ?? [];
      if (ids.length === 0) unanchored++;
      for (const id of ids) touched.add(id);
    }
    if (touched.size === 0) {
      // Nothing to gate — but an edit that lands ONLY on unanchored files while
      // a deny is outstanding is still a redirect worth a row.
      noteUnanchoredRedirect(dir, config, unanchored);
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

    // Apply any rebellion the snapshot already knows about before reading the
    // ledger. Pure file work, no git — the drift itself was measured by
    // whichever recompute ran last, and this only makes it bite. Without it a
    // rebellion noticed mid-session would not gate until the next SessionStart.
    syncLocksWithDrift(dir, coverage.components);
    const locks = readLocksSafe(dir);

    // Where to send the junior, as a clickable link. Deliberately the RECORDED
    // viewer without a health probe: this runs on the PreToolUse path in front
    // of every edit, and a link that is occasionally stale costs nothing, while
    // even a 200 ms probe per keystroke-sized edit would be felt. `/scale-open`
    // (in the deny text) starts the server if it is not up.
    // …and token-free: the deny reason is written into the transcript for
    // Claude and the junior to read (`agentViewerBase`).
    const viewerBase = agentViewerBase(cwd);
    const viewerUrlFor = (component: string): string =>
      viewerUrl(viewerBase, { component });

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
        drifted: Object.fromEntries(
          Object.entries(locks.drifted).map(([id, d]) => [
            id,
            { cause: d.cause, authors: d.foreignAuthors },
          ]),
        ),
        recentlyAddressed,
        now,
        importance,
        viewerUrlFor,
      });

      const counters = { ...session.counters, edits: session.counters.edits + 1 };
      const driftCause = locks.drifted[decision.component ?? '']?.cause;
      const cause: 'locked' | 'drift_foreign' | 'drift_self' =
        driftCause === 'foreign' ? 'drift_foreign' : driftCause === 'self' ? 'drift_self' : 'locked';

      if (decision.action === 'deny' && decision.component) {
        if (decision.spendBudget) {
          // A fresh deny: spend a budget slot INSIDE the lock.
          writeSession(dir, {
            ...session,
            interventionsThisSession: session.interventionsThisSession + 1,
            lastInterventionAt: now,
            lastDenyAt: now,
            pendingComponent: decision.component,
            counters: { ...counters, denies: counters.denies + 1 },
          });
          return {
            kind: 'deny' as const,
            component: decision.component,
            reason: decision.reason ?? null,
            now,
            cause,
            budgetUsed: session.interventionsThisSession + 1,
            sessionId: session.sessionId,
          };
        }
        // A re-deny of the still-pending component: no budget movement, and no
        // second `requested` evidence row — the intervention is already open.
        writeSession(dir, { ...session, counters: { ...counters, redenies: counters.redenies + 1 } });
        return {
          kind: 'redeny' as const,
          component: decision.component,
          reason: decision.reason ?? null,
          now,
          cause,
          budgetUsed: session.interventionsThisSession,
          sessionId: session.sessionId,
        };
      }

      if (decision.advisory && decision.component) {
        // Advisory: no budget spend, no block — the evidence row written
        // outside the lock enters recentlyAddressed and rate-limits repeats.
        writeSession(dir, { ...session, counters: { ...counters, advisories: counters.advisories + 1 } });
        return {
          kind: 'advisory' as const,
          component: decision.component,
          now,
          cause,
          budgetUsed: session.interventionsThisSession,
          sessionId: session.sessionId,
        };
      }

      // Allow. Clear the pending marker if this allow resolved it.
      const resolved =
        !!session.pendingComponent && recentlyAddressed.includes(session.pendingComponent);
      // REDIRECT (PLAN-GATE §15): a deny is still outstanding on some other
      // component, no check has cleared it, and this edit was allowed somewhere
      // else. Not proof of avoidance — the row records the gap and the target.
      const redirect =
        !resolved &&
        !!session.pendingComponent &&
        !touched.has(session.pendingComponent) &&
        !!session.lastDenyAt
          ? {
              denied: session.pendingComponent,
              editedInstead: [...touched].filter((id) => id !== session.pendingComponent),
              msSinceDeny: Math.max(0, Date.parse(now) - Date.parse(session.lastDenyAt)),
              sessionId: session.sessionId,
            }
          : null;
      writeSession(dir, {
        ...session,
        pendingComponent: resolved ? null : session.pendingComponent,
        counters: {
          ...counters,
          allows: counters.allows + 1,
          redirects: counters.redirects + (redirect ? 1 : 0),
        },
      });
      return redirect ? { kind: 'redirect' as const, ...redirect, now } : null;
    });

    if (!decided) {
      // Either the gate allowed, or the lock was contended and another gate is
      // mid-decision. Both allow.
      emit(true, null, null);
      return;
    }

    if (decided.kind === 'redirect') {
      appendTelemetry(dir, {
        v: 1,
        type: 'redirect',
        ts: decided.now,
        user: config.user,
        sessionId: decided.sessionId,
        denied: decided.denied,
        editedInstead: decided.editedInstead,
        unanchoredFiles: unanchored,
        msSinceDeny: decided.msSinceDeny,
      });
      emit(true, null, null);
      return;
    }

    appendTelemetry(dir, {
      v: 1,
      type: 'gate',
      ts: decided.now,
      user: config.user,
      sessionId: decided.sessionId,
      decision: decided.kind,
      component: decided.component,
      cause: decided.cause,
      enforcement: config.gate.enforcement,
      assessment: config.gate.assessment,
      modality: config.gate.modality,
      budgetUsed: decided.budgetUsed,
      budgetMax: config.budgets.maxPerSession,
    });

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
    // Under ASYNC assessment the check is owed LATER, so the deny must leave a
    // trace something can act on: SessionEnd generates the quest for it, the
    // viewer marks it, and SessionStart reminds. A sync deny is resolved in
    // chat right now and leaves none. (A denied edit writes no `touch`, so
    // without this the component the user was actually blocked on was
    // invisible to every downstream picker.)
    if (config.gate.assessment === 'async') {
      notePendingUnlock(dir, decided.component, sessionId, decided.now);
    }
    emit(false, decided.component, decided.reason);
  });

/**
 * An allowed edit that touched only files no doc anchors, while a deny was
 * outstanding: recorded as a redirect with an empty `editedInstead`. Also
 * counts the edit/allow in the session tallies.
 */
function noteUnanchoredRedirect(dir: string, config: ScaleConfig, unanchored: number): void {
  const now = nowIso();
  const out = withSessionLock(dir, () => {
    const session = readSessionSafe(dir);
    if (!session) return null;
    const redirect = !!session.pendingComponent && !!session.lastDenyAt;
    writeSession(dir, {
      ...session,
      counters: {
        ...session.counters,
        edits: session.counters.edits + 1,
        allows: session.counters.allows + 1,
        redirects: session.counters.redirects + (redirect ? 1 : 0),
      },
    });
    return redirect
      ? {
          denied: session.pendingComponent!,
          msSinceDeny: Math.max(0, Date.parse(now) - Date.parse(session.lastDenyAt!)),
          sessionId: session.sessionId,
        }
      : null;
  });
  if (!out) return;
  appendTelemetry(dir, {
    v: 1,
    type: 'redirect',
    ts: now,
    user: config.user,
    sessionId: out.sessionId,
    denied: out.denied,
    editedInstead: [],
    unanchoredFiles: unanchored,
    msSinceDeny: out.msSinceDeny,
  });
}

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

    const skipped = withSessionLock(dir, () => {
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
        counters: { ...session.counters, skips: session.counters.skips + 1 },
      });
      return {
        sessionId: session.sessionId,
        msSinceDeny: session.lastDenyAt
          ? Math.max(0, Date.parse(now) - Date.parse(session.lastDenyAt))
          : null,
      };
    });
    appendTelemetry(dir, {
      v: 1,
      type: 'skip',
      ts: now,
      user: config.user,
      sessionId: skipped?.sessionId ?? null,
      component: componentId,
      by: opts.by,
      enforcement: config.gate.enforcement,
      msSinceDeny: skipped?.msSinceDeny ?? null,
    });
    // Skipping is a decision about this territory; it stops being an open
    // to-do. The next deny re-adds it if the user comes back to it.
    clearPendingUnlock(dir, componentId);

    console.log(
      `scale: skipped '${componentId}' (by ${opts.by}) — unlocked for THIS session only; ` +
        'retry the edit. It locks again next session.',
    );
  });

// ---------------------------------------------------------------------------
// review  (REAL) — the CHAT post-session check path (PLAN-GATE §4 S3)
//
// The commands `/scale-review` drives. They carry NO policy of their own: the
// queue is `pickComponents()` (the same picker the web quest path uses), the
// brief is core's `checkBrief` (the same generator the in-flow deny uses), and
// recording/unlocking/skipping stay with `scale record` and `scale gate defer`.
// The only thing that differs between this path and the in-flow gate is WHEN
// the check happens — which is the variable the study manipulates.
// ---------------------------------------------------------------------------
const review = program
  .command('review')
  .description(
    'Post-session comprehension review in chat: the checks this user owes ' +
      '(async denies) and the territory they touched since it was last checked. ' +
      'Driven by /scale-review.',
  );

/**
 * componentId → its doc's title and declared sources. Titles make the queue
 * readable; sources narrow a touch row's file list to the territory it is
 * actually about (see `territoryFiles`).
 */
function docFacts(cwd: string): { titles: Record<string, string>; sources: Record<string, string[]> } {
  const titles: Record<string, string> = {};
  const sources: Record<string, string[]> = {};
  try {
    for (const d of loadScaleDir(cwd).docs) {
      titles[d.frontmatter.id] = d.frontmatter.title;
      sources[d.frontmatter.id] = d.frontmatter.sources;
    }
  } catch {
    /* no .scale/ — ids are their own labels and nothing narrows */
  }
  return { titles, sources };
}

/**
 * Everything the review commands need about ONE component: why it is up for
 * review, the window the reason dates from, and the files to ground it in.
 *
 * Shared by `start` and `diff` so the brief the tutor reads and the diff it
 * reads are talking about the same window. Returns null when the component is
 * not in the map (an id that names nothing cannot be reviewed).
 */
function resolveReviewTarget(
  cwd: string,
  dir: string,
  componentId: string,
): {
  reason: 'owed' | 'touched';
  /** ISO window anchor; '' when nothing dates it (see `gitTerritoryDiff`). */
  since: string;
  files: string[];
  config: ScaleConfig;
} | null {
  const config = loadEffectiveConfig(cwd, dir).config;
  const map = readMapJsonSafe(cwd);
  if (!map || !map.nodes.some((n) => n.id === componentId)) return null;

  const pending = readLocksSafe(dir).pendingUnlocks[componentId];
  const window = touchedSinceLastCheck(readEvidenceRecords(dir)).get(componentId);
  // An owed check outranks a touch: it is the one the gate actually denied.
  const reason: 'owed' | 'touched' = pending ? 'owed' : 'touched';
  // The window anchor is the EARLIEST relevant touch — the junior's own work is
  // what the check is grounded in. A denied edit leaves no touch row at all, so
  // an owed component with no touches falls back to the deny's timestamp.
  const since = window?.since ?? pending?.at ?? '';
  // Files, narrowed to THIS territory (a touch row credits every component the
  // edit spanned, so an unnarrowed list grounds the check in someone else's
  // code). With none recorded — an owed deny writes no touch row at all — the
  // component's own sources are the territory: better an honest "here is the
  // code this covers" than nothing to read.
  const sources =
    componentSourcesIndex(loadScaleDir(cwd)).find((s) => s.id === componentId)?.sources ?? [];
  const narrowed = territoryFiles(window?.files ?? [], sources);
  const files = narrowed.length > 0 ? narrowed : sources;
  return { reason, since, files, config };
}

review
  .command('queue')
  .description(
    'The ordered list of components to review now: owed checks first (async ' +
      'denies), then territory touched since its last check, ranked by ' +
      'importance × comprehension gap. Same picker as post-session quests.',
  )
  .option('--json', 'machine-readable (the shape /scale-review reads)', false)
  .option('--limit <n>', `how many items at most (default ${DEFAULT_TOP_K})`)
  .action((opts: { json?: boolean; limit?: string }) => {
    const cwd = process.cwd();
    const dir = stateDir(cwd);
    const config = loadEffectiveConfig(cwd, dir).config;
    const parsedLimit = opts.limit === undefined ? NaN : Number(opts.limit);
    const limit =
      Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.trunc(parsedLimit) : DEFAULT_TOP_K;

    let res: RecomputeResult;
    try {
      res = recomputeCoverageFromDisk(cwd);
    } catch (err) {
      if (opts.json) {
        console.log(JSON.stringify({ error: (err as Error).message, items: [] }, null, 2));
      } else {
        console.error(`scale: cannot read coverage (${(err as Error).message}).`);
      }
      process.exitCode = 1;
      return;
    }

    const facts = docFacts(cwd);
    const items = buildReviewQueue({
      coverage: res.coverage,
      map: res.map,
      config,
      pending: readLocksSafe(dir).pendingUnlocks,
      touched: touchedSinceLastCheck(readEvidenceRecords(dir)),
      titles: facts.titles,
      sources: facts.sources,
      limit,
    });

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            assessment: config.gate.assessment,
            modality: config.gate.modality,
            enforcement: config.gate.enforcement,
            language: config.language,
            // The check's SHAPE travels with the queue for the same reason it
            // rides on the deny: the tutor must not need a second CLI call to
            // learn how many items to write.
            quiz: config.gate.modality === 'quiz' ? quizSpecLine(config.quiz) : null,
            viewer: agentViewerBase(cwd),
            items,
          },
          null,
          2,
        ),
      );
      return;
    }

    if (items.length === 0) {
      console.log('scale: nothing to review.');
      return;
    }
    console.log(
      `scale: ${items.length} component(s) to review ` +
        `(${config.gate.assessment}/${config.gate.modality}) — ` +
        'run `scale review start <id>` for each.',
    );
    for (const item of items) console.log(`  ${formatReviewItem(item)}`);
  });

review
  .command('start')
  .description(
    'Open the review check for one component: print the SAME brief the edit ' +
      'gate would have printed in-flow (core checkBrief) and record the ' +
      'intervention as requested. The check itself is the scale-tutor skill.',
  )
  .argument('<componentId>', 'component to review')
  .option('--json', 'machine-readable', false)
  .action(async (componentId: string, opts: { json?: boolean }) => {
    const cwd = process.cwd();
    const dir = stateDir(cwd);
    const target = resolveReviewTarget(cwd, dir, componentId);
    if (!target) {
      console.error(`scale: '${componentId}' is not a component in this repo's map.`);
      process.exitCode = 1;
      return;
    }
    const { config, reason, since, files } = target;
    const viewer = agentViewerBase(cwd);
    const brief = checkBrief(
      componentId,
      config,
      { kind: 'review', reason, since: since || nowIso(), files },
      viewerUrl(viewer, { component: componentId }),
    );

    // The SAME accounting row the gate writes when it denies — `requested` is
    // all either path can honestly claim (it asks for a check; the tutor is
    // what delivers it). `trigger: 'review'` is the only difference, and it is
    // what lets the analysis separate the two arms.
    const entries = readEvidenceRecords(dir);
    const startedAt = readSessionSafe(dir)?.startedAt ?? '';
    if (!reviewAlreadyOpened(entries, componentId, startedAt)) {
      try {
        await appendEvidence(dir, {
          type: 'intervention',
          ts: nowIso(),
          user: currentUser(dir),
          componentId,
          // Reports the assessment this user is ASSIGNED to, exactly as
          // `scale record` does — never re-derived from where the check ran.
          timing: config.gate.assessment === 'async' ? 'postsession' : 'inflow',
          modality: config.gate.modality,
          outcome: 'requested',
          trigger: 'review',
        });
      } catch {
        /* accounting only — the junior still gets their check */
      }
    }

    if (opts.json) {
      console.log(
        JSON.stringify({ componentId, brief, reason, since, files, viewer }, null, 2),
      );
      return;
    }
    console.log(brief);
  });

review
  .command('diff')
  .description(
    'The code this user changed in one territory since its review window ' +
      'opened — commits plus the working tree, for grounding the check. ' +
      'Capped; degrades to a note when git is unavailable.',
  )
  .argument('<componentId>', 'component whose territory to diff')
  .option('--max-bytes <n>', `byte cap on the output (default ${DEFAULT_DIFF_MAX_BYTES})`)
  .action((componentId: string, opts: { maxBytes?: string }) => {
    const cwd = process.cwd();
    const dir = stateDir(cwd);
    const target = resolveReviewTarget(cwd, dir, componentId);
    if (!target) {
      console.error(`scale: '${componentId}' is not a component in this repo's map.`);
      process.exitCode = 1;
      return;
    }
    const parsed = opts.maxBytes === undefined ? NaN : Number(opts.maxBytes);
    const maxBytes =
      Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : DEFAULT_DIFF_MAX_BYTES;
    const { since, files } = target;
    console.log(
      formatReviewDiff({
        componentId,
        since: since || '(no window recorded)',
        files,
        diff: gitTerritoryDiff(cwd, files, since, maxBytes),
        maxBytes,
      }),
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
 * Measure the repo's shape for {@link estimateBuild}: source lines AND the file
 * count, which is now load-bearing rather than decoration. Every exclusion below
 * therefore lowers the component target, not just the price — a repo written in
 * a language outside the extension allow-list scans as zero files and zero lines,
 * and the estimate then reports the floor. The estimate says so (the file count
 * is printed and `granularityLimited` is true when it binds), but a caller
 * reading only the component number would not notice.
 *
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
function renderEstimate(est: BuildEstimate): string {
  const lines: string[] = [];
  const p = est.partition;
  if (est.files === 0) {
    // The floor would otherwise print a confident "~5 components" for a repo the
    // scan could not read at all — an unlisted language, or the wrong directory.
    lines.push(
      `repo: no source files recognized under this directory (${est.loc.toLocaleString()} LOC).`,
      '  The extension allow-list found nothing, so there is no partition to size and',
      '  the cost below is meaningless. Check you are in the repo root, and that its',
      '  language is one the scanner knows.',
      '',
    );
  }
  lines.push(
    `repo: ${est.files} files, ${est.loc.toLocaleString()} LOC → ~${est.components} components ` +
      `(build within ${p.min}–${p.max})`,
  );
  // Which limit bound the target is load-bearing, not trivia: it tells the
  // cartographer whether the number reflects how much code there is or how
  // coarsely the anchors can point at it.
  if (p.boundBy === 'files') {
    lines.push(
      `  capped by FILE COUNT: this repo wants ~${p.demand}, but sources anchor whole files, ` +
        `so ${p.byFiles} file(s) resolve at most ${p.byFiles} components.`,
    );
    lines.push(
      '  Going finer would put several components on one file, and the edit gate, coverage',
      '  credit and drift all key off the file — they would move together.',
    );
  } else if (p.boundBy === 'floor') {
    lines.push(
      `  at the FLOOR: ${est.loc.toLocaleString()} LOC would round to ${p.byLoc}, which is too ` +
        `few to carry a map, so the minimum of ${p.demand} applies.`,
    );
  } else {
    lines.push(`  from LOC (~${PER_LOC.locPerComponent} lines each); ${p.byFiles} files leave room.`);
  }
  lines.push(
    `  shape: ${p.topGroups} top-level group(s), ${p.depth} grouping level(s) above the components` +
      (p.needsHierarchy ? ' — too many for one flat province layer.' : '.'),
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
    const est = estimateBuild({ loc, files });

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            repo: { files, loc },
            components: est.components,
            partition: est.partition,
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
    console.log(renderEstimate(est));
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
        console.log(
          'scale: quest generate — no-op (sync assessment, or no coverage memory). ' +
            'Quests are generated for async users, whose checks are owed later.',
        );
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
// doc show  (REAL) — read a component doc, optionally translated (🧠 LLM)
// ---------------------------------------------------------------------------
const doc = program.command('doc').description('Read the component docs in `.scale/`');

doc
  .command('show')
  .description(
    'Print a component doc. With --lang ko it is translated at RENDER TIME and ' +
      'cached per user — the committed doc itself always stays English (🧠 LLM ' +
      'on a cache miss; no key just means you get the English source).',
  )
  .argument('<id>', 'component id (the frontmatter `id`, not the folder name)')
  .option(
    '--lang <lang>',
    "render language: 'en' or 'ko'. Defaults to your effective config.language",
  )
  .option('--json', 'emit the whole TranslationResult as JSON', false)
  .option('--refresh', 'ignore any cached translation and translate again', false)
  .action(async (id: string, opts: { lang?: string; json?: boolean; refresh?: boolean }) => {
    const cwd = process.cwd();
    const dir = stateDir(cwd);
    const config = loadEffectiveConfig(cwd, dir).config;

    const lang = opts.lang ?? config.language;
    if (lang !== 'en' && lang !== 'ko') {
      console.error(`scale: unsupported --lang "${lang}" (expected 'en' or 'ko').`);
      process.exitCode = 1;
      return;
    }

    const found = docById(loadScaleDir(cwd), id);
    if (!found) {
      console.error(`scale: no component doc with id "${id}" in ${path.join(cwd, '.scale')}.`);
      process.exitCode = 1;
      return;
    }

    const result = await translateDoc({
      doc: found,
      lang,
      config,
      dir,
      refresh: !!opts.refresh,
    });

    if (opts.json) {
      console.log(JSON.stringify({ id: found.id, lang, ...result }, null, 2));
      return;
    }

    console.log(result.frontmatter.title);
    // One line that says, always, which text the reader is looking at. A
    // silent fallback to English is the failure mode worth spending a line on:
    // the reader asked for Korean, and a doc that merely "looks untranslated"
    // is indistinguishable from one whose translation quietly failed.
    console.log(
      result.translated
        ? `(translated · ${result.cached ? 'cached' : 'fresh'} · ${result.model})`
        : result.error
          ? `(English source — ${result.error.message})`
          : '(English source)',
    );
    console.log('');
    console.log(result.body);
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
    const newCount = loaded.docs.filter((p) => !existingIds.has(p.id)).length;

    const nodeIds = new Set(loaded.docs.map((p) => p.id));
    const dependsOn = loadDependsOnEdges(cwd, nodeIds);
    const mapJson = computeLayout(
      {
        provinces: loaded.provinces,
        nodes: loaded.docs.map((p) => ({ id: p.id, province: p.province })),
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
      `scale: indexed ${loaded.docs.length} component(s), ` +
        `${Object.keys(index).length} file(s) → ${path.relative(cwd, outPath) || outPath}`,
    );
  });

map
  .command('check')
  .description(
    'Hold a built .scale/ to the sizing contract: partition size against ' +
      '`scale estimate`, components per source file, and children per group. ' +
      'Pure fs scan + arithmetic — no LLM, no git.',
  )
  .option('--json', 'emit machine-readable JSON instead of the report', false)
  .action((opts: { json?: boolean }) => {
    const cwd = process.cwd();
    // A documented `--json` form that answers with zero bytes on its error paths
    // is not machine-readable; every exit here carries the same shape.
    const bail = (error: string): void => {
      if (opts.json) console.log(JSON.stringify({ ok: false, error }, null, 2));
      else console.error(`scale: ${error}`);
      process.exitCode = 1;
    };
    const scaleDir = path.join(cwd, '.scale');
    if (!fs.existsSync(scaleDir)) {
      bail(`no coverage-memory dir at ${scaleDir} — nothing to check.`);
      return;
    }
    const loaded = loadScaleDir(cwd);
    const built = loaded.docs.length;
    if (built === 0) {
      bail('no component docs found — nothing to check.');
      return;
    }

    const { files, loc } = scanSourceLoc(cwd);
    const target = partitionTarget({ loc, files });

    // Components per ANCHORED file, not per scanned file: the ratio that
    // matters is over the files docs actually claim, since those are the only
    // ones the file→component index can route an edit through.
    const index = buildFileComponentIndex(componentSourcesIndex(loaded));
    const allAnchored = Object.keys(index);
    // Density is judged against SOURCE files only, because that is the surface
    // the target's ceiling was computed against. Counting every anchored path
    // would let a partition dilute its own density with manifests and docs: ten
    // components over five source files and five markdown files would measure
    // 1.0 while the code they actually gate is at 2.0.
    // A path that is not on disk can never route an edit, so counting it would
    // let a partition improve its measured density by anchoring files that do
    // not exist — the density check exists precisely to guarantee routing.
    const deadAnchors = allAnchored.filter((f) => !fs.existsSync(path.resolve(cwd, f)));
    const sourceAnchored = allAnchored.filter(
      (f) =>
        SOURCE_EXTS.has(path.extname(f).toLowerCase()) &&
        !isTestFile(path.basename(f)) &&
        fs.existsSync(path.resolve(cwd, f)),
    );
    const anchoredFiles = sourceAnchored.length;
    // JSON.stringify turns Infinity into null, which reads as "no data" rather
    // than "the worst possible density"; the machine surface says so in a field
    // that survives serialization.
    const perFile = anchoredFiles > 0 ? built / anchoredFiles : null;
    const worst = Object.entries(index)
      .map(([file, ids]) => ({ file, n: ids.length }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 5);

    // Group sizes, read off the store's own folder layout.
    const byProvince = new Map<string, number>();
    for (const doc of loaded.docs) {
      const prov = doc.province || '(none)';
      byProvince.set(prov, (byProvince.get(prov) ?? 0) + 1);
    }
    const groups = [...byProvince.entries()].map(([id, n]) => ({ id, n })).sort((a, b) => b.n - a.n);

    const findings: ReturnType<typeof checkPartition> = [];
    if (deadAnchors.length > 0) {
      // A warning, not a failure. A path that is gone cannot route an edit, but
      // neither does it make the rest of the partition unresolvable — the harm
      // is that the doc still teaches code that no longer exists. It is kept
      // out of the density denominator above, so it can no longer flatter the
      // ratio either. (This is how the check found that this repo's own memory
      // still anchors the commit hook removed in PLAN-GATE §6.)
      findings.push({
        level: 'warn',
        code: 'stale-anchor',
        message:
          `${deadAnchors.length} anchored path(s) no longer exist ` +
          `(e.g. ${deadAnchors.slice(0, 3).join(', ')}). Those docs describe code that is gone.`,
      });
    }
    findings.push(...checkPartition(
      { components: built, anchoredFiles, groupSizes: groups.map((g) => g.n) },
      target,
    ));

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            built,
            target,
            repo: { files, loc },
            anchoredFiles,
            anchoredPaths: allAnchored.length,
            deadAnchors,
            perFile,
            groups,
            worst,
            findings,
          },
          null,
          2,
        ),
      );
      if (!partitionPasses(findings)) process.exitCode = 1;
      return;
    }

    const out: string[] = [];
    out.push('scale map check — partition vs the sizing contract');
    out.push('');
    out.push(`  built            ${built} components in ${groups.length} group(s)`);
    out.push(
      `  estimate         ${target.target} (band ${target.min}–${target.max}) ` +
        `from ${files} files, ${loc.toLocaleString()} LOC`,
    );
    out.push(
      `  per file         ${perFile === null ? 'no source files anchored' : perFile.toFixed(2) + ' components per anchored source file'} ` +
        `(max ${GRANULARITY_MAX_PER_FILE}; ${anchoredFiles} source of ${allAnchored.length} anchored)`,
    );
    out.push(
      `  shape            ${target.depth} grouping level(s), ${target.topGroups} at the top` +
        (target.needsHierarchy ? ' — needs more than a flat province layer' : ''),
    );
    if (worst.length > 0 && worst[0]!.n > 1) {
      out.push('');
      out.push('  files claimed by more than one component:');
      for (const w of worst) {
        if (w.n > 1) out.push(`    ${String(w.n).padStart(3)}  ${w.file}`);
      }
    }
    out.push('');
    if (findings.length === 0) {
      out.push('  OK — the partition is within the contract.');
    } else {
      for (const f of findings) {
        out.push(`  ${f.level === 'fail' ? 'FAIL' : 'WARN'}  ${f.message}`);
      }
    }
    console.log(out.join('\n'));
    if (!partitionPasses(findings)) process.exitCode = 1;
  });

// ---------------------------------------------------------------------------
// serve  (REAL) — local web map app
// ---------------------------------------------------------------------------
/** Open a URL in the platform browser, detached; never throws, never waits. */
function openInBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args as string[], { detached: true, stdio: 'ignore' });
    child.on('error', () => {
      /* no opener on this box — the URL is printed either way */
    });
    child.unref();
  } catch {
    /* ignore */
  }
}

/**
 * The deep-link target from `--component` / `--section` / `--settings`.
 *
 * `--section` is normalized through core's {@link slugify} rather than being
 * validated against the doc: callers type the heading as they read it
 * (`--section "Design decisions"`), and the viewer already treats a section it
 * cannot find as "no section" and shows the doc from the top. Rejecting the
 * spelling here would turn a link that works into an error at the one moment
 * someone is trying to hand a reader a pointer. A section without a component
 * is dropped for the same reason `viewerUrl` ignores it — there is nowhere to
 * anchor it.
 */
function targetFromOpts(opts: {
  component?: string;
  section?: string;
  settings?: string | boolean;
}): {
  component?: string;
  section?: string;
  settings?: string;
} {
  if (opts.component) {
    const section = opts.section ? slugify(opts.section) : '';
    return { component: opts.component, ...(section ? { section } : {}) };
  }
  if (opts.settings !== undefined) {
    return { settings: typeof opts.settings === 'string' ? opts.settings : '' };
  }
  return {};
}

program
  .command('serve')
  .description(
    'The local web map app. Bare `scale serve` runs it in the foreground; ' +
      '`ensure` starts a detached one if none is up, `stop` stops it, `url` ' +
      'prints where it is, `open` opens it in a browser.',
  )
  .argument('[action]', 'ensure | stop | url | open (omit to run in the foreground)')
  .option('-p, --port <number>', 'port', String(DEFAULT_PORT))
  .option(
    '--host <addr>',
    'bind address; defaults to loopback. Off loopback the API requires a bearer ' +
      'token (see --token), because this server writes config and accepts API keys',
    '127.0.0.1',
  )
  .option(
    '--token <secret>',
    'bearer token the API requires (Authorization: Bearer … or ?token=…). ' +
      'Generated for you when --host is not loopback and none is given; the ' +
      'printed URL carries it, so open THAT on the phone',
  )
  .option(
    '--idle-minutes <n>',
    'exit cleanly after N minutes with no HTTP request. Off by default in the ' +
      'foreground; `ensure` passes 240, because nobody is watching that one',
  )
  .option('--component <id>', 'deep-link to a component panel (url, open)')
  .option(
    '--section <slug>',
    "deep-link to one section of that component's doc — `concepts`, " +
      '`decisions`, or a heading slug such as `design-decisions` (needs --component)',
  )
  .option('--settings [tab]', 'deep-link to Settings: general|gate|checks|team (url, open)')
  .option('--json', 'machine-readable output (ensure, url)', false)
  .action(
    async (
      action: string | undefined,
      opts: {
        port: string;
        host: string;
        token?: string;
        idleMinutes?: string;
        component?: string;
        section?: string;
        settings?: string | boolean;
        json?: boolean;
      },
    ) => {
      const cwd = process.cwd();
      const port = Number(opts.port);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        console.error(`scale: invalid port "${opts.port}".`);
        process.exitCode = 1;
        return;
      }
      let idleMinutes: number | undefined;
      if (opts.idleMinutes !== undefined) {
        const n = Number(opts.idleMinutes);
        if (!Number.isFinite(n) || n <= 0) {
          console.error(`scale: invalid --idle-minutes "${opts.idleMinutes}".`);
          process.exitCode = 1;
          return;
        }
        idleMinutes = n;
      }

      switch (action ?? 'run') {
        case 'run':
          startServer({
            port,
            host: opts.host,
            cwd,
            token: opts.token,
            idleMinutes,
            // The foreground server IS the viewer for this repo: record it, and
            // take the state file with it on Ctrl-C.
            trackState: true,
          });
          return;

        case 'ensure': {
          try {
            const res = await ensureServer({
              cwd,
              port,
              host: opts.host,
              token: opts.token,
              // A viewer started on the user's behalf must not outlive their
              // interest in it by days. Four hours is a working day's session.
              idleMinutes: idleMinutes ?? 240,
            });
            if (opts.json) console.log(JSON.stringify(res));
            else console.log(res.url);
          } catch (err) {
            // One line, exit 1 — every caller of this is a hook or a skill that
            // must carry on regardless.
            console.error(`scale: ${(err as Error).message}`);
            process.exitCode = 1;
          }
          return;
        }

        case 'stop': {
          const res = await stopServer(cwd);
          if (opts.json) console.log(JSON.stringify(res));
          else if (res.stopped) console.log(`scale: stopped the map viewer (pid ${res.pid}).`);
          else console.log('scale: no map viewer of ours was running.');
          return;
        }

        case 'url': {
          const view = await resolveViewer(cwd, targetFromOpts(opts), 300);
          if (opts.json) console.log(JSON.stringify(view));
          else console.log(view.url);
          return;
        }

        case 'open': {
          try {
            const res = await ensureServer({
              cwd,
              port,
              host: opts.host,
              token: opts.token,
              idleMinutes: idleMinutes ?? 240,
            });
            // The tokened URL on purpose: this one goes to the user's terminal
            // and browser, and off loopback it is useless without the token.
            const url = viewerUrl(res.url, targetFromOpts(opts));
            openInBrowser(url);
            console.log(url);
          } catch (err) {
            console.error(`scale: ${(err as Error).message}`);
            process.exitCode = 1;
          }
          return;
        }

        default:
          console.error(
            `scale: unknown \`serve\` action "${action}" — use ensure, stop, url or open.`,
          );
          process.exitCode = 1;
      }
    },
  );

// ---------------------------------------------------------------------------
// keys status|set  (REAL) — the API keys the intervention model needs
//
// The key ONLY ever arrives on stdin. Not as an argument, not through an
// option: argv is readable by every process on the box via `ps`, it lands in
// shell history, and a hook transcript would keep a copy forever.
// ---------------------------------------------------------------------------

/** How long `keys set --stdin` waits for the key before giving up. */
const STDIN_BUDGET_MS = 30_000;

/**
 * Read stdin to the end, bounded.
 *
 * The bound is the point: with no pipe attached (a hook that forgot to write
 * one, a skill that spawned us wrongly) an unbounded read is a `scale` process
 * that waits for a key that is never coming, holding a terminal — or a hook —
 * forever. Thirty seconds is longer than any paste and shorter than anyone's
 * patience.
 *
 * On a TTY we still read, because "paste it here" is a perfectly good way to
 * enter a key that must never be an argument; we just say so, on stderr, so
 * the hint cannot end up in whatever is capturing stdout.
 */
function readStdin(timeoutMs: number = STDIN_BUDGET_MS): Promise<string> {
  if (process.stdin.isTTY) {
    console.error('scale: paste the key and press Ctrl-D (Ctrl-C to abort).');
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const onData = (c: Buffer): number => chunks.push(Buffer.from(c));
    const done = (fn: () => void): void => {
      clearTimeout(timer);
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
      process.stdin.off('error', onError);
      process.stdin.pause();
      fn();
    };
    const onEnd = (): void => done(() => resolve(Buffer.concat(chunks).toString('utf8')));
    const onError = (err: Error): void => done(() => reject(err));
    const timer = setTimeout(
      () =>
        done(() =>
          reject(new Error(`nothing arrived on stdin within ${Math.round(timeoutMs / 1000)}s`)),
        ),
      timeoutMs,
    );
    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.on('error', onError);
  });
}

program
  .command('keys')
  .description(
    'API keys for the intervention model. `status` says whether each provider ' +
      'has one; `set <provider> --stdin` stores one read from stdin.',
  )
  .argument('[action]', 'status | set', 'status')
  .argument('[provider]', 'anthropic | openai (for `set`)')
  .option('--stdin', 'read the key from stdin (required for `set`)', false)
  .option('--json', 'machine-readable output', false)
  .action(
    async (
      action: string,
      provider: string | undefined,
      opts: { stdin?: boolean; json?: boolean },
    ) => {
      if (action === 'status') {
        const status = keyStatus();
        // The contract is `{ present }` per provider — deliberately narrower
        // than the web API's status, which also carries a masked tail. A CLI
        // answer gets pasted into chat logs; a boolean cannot leak.
        const out = {
          anthropic: { present: status.anthropic.configured },
          openai: { present: status.openai.configured },
        };
        if (opts.json) console.log(JSON.stringify(out));
        else {
          for (const p of ['anthropic', 'openai'] as const) {
            const src = status[p].source;
            console.log(
              `${p.padEnd(10)} ${out[p].present ? `configured (${src === 'env' ? 'environment' : 'stored'})` : 'not set'}`,
            );
          }
        }
        return;
      }

      if (action !== 'set') {
        console.error('scale: usage — scale keys status [--json] | scale keys set <provider> --stdin');
        process.exitCode = 1;
        return;
      }

      const parsed = LlmProviderSchema.safeParse(provider);
      if (!parsed.success) {
        console.error('scale: usage — scale keys set <anthropic|openai> --stdin');
        process.exitCode = 1;
        return;
      }
      if (!opts.stdin) {
        console.error(
          'scale: --stdin is required. The key is read from stdin only — never from ' +
            'an argument, which `ps` and your shell history would keep.',
        );
        process.exitCode = 1;
        return;
      }
      let raw: string;
      try {
        raw = await readStdin();
      } catch (err) {
        console.error(
          `scale: ${(err as Error).message}. Pipe the key in, e.g. ` +
            '`pbpaste | scale keys set anthropic --stdin`.',
        );
        process.exitCode = 1;
        return;
      }
      if (!raw.trim()) {
        console.error(
          'scale: nothing on stdin. Pipe the key in, e.g. `pbpaste | scale keys set anthropic --stdin`.',
        );
        process.exitCode = 1;
        return;
      }
      try {
        setKeyFromInput(parsed.data, raw);
      } catch (err) {
        console.error(`scale: could not store the key — ${(err as Error).message}`);
        process.exitCode = 1;
        return;
      }
      // Never the key, never a masked tail, never a length.
      console.log(`scale: stored the ${parsed.data} key.`);
    },
  );

// ---------------------------------------------------------------------------
// setup status  (REAL) — one answer to "is SCALE usable here, for me, now?"
// ---------------------------------------------------------------------------
program
  .command('setup')
  .description('Report what SCALE still needs in this repo (config, memory, key, viewer)')
  .argument('[action]', 'only `status` is supported', 'status')
  .option('--json', 'machine-readable output', false)
  .action(async (action: string, opts: { json?: boolean }) => {
    if (action !== 'status') {
      console.error('scale: usage — scale setup status [--json]');
      process.exitCode = 1;
      return;
    }
    const s = await buildSetupStatus(process.cwd());
    if (opts.json) {
      console.log(JSON.stringify(s));
      return;
    }
    console.log(`SCALE setup — ${s.repoId}`);
    console.log(`  state      ${s.stateDir}`);
    console.log(`  config     ${s.initialized ? `yes (user: ${s.user ?? '—'})` : 'not initialized'}`);
    console.log(
      `  memory     ${s.memory.present ? `${s.memory.components} component(s)` : 'none — run /scale-map'}`,
    );
    console.log(`  provider   ${s.provider}${s.keyPresent ? ' (key present)' : ' — NO API KEY'}`);
    console.log(`  gate       ${s.gate.assessment}/${s.gate.modality} (${s.gate.enforcement})`);
    console.log(`  language   ${s.language}`);
    console.log(`  viewer     ${s.viewer.url}${s.viewer.running ? '' : '  (not running)'}`);
  });

// ---------------------------------------------------------------------------
// policy show  (REAL) — the committed team policy, and whether you may edit it
// ---------------------------------------------------------------------------
program
  .command('policy')
  .description('Show the committed team policy (.scale/policy.json) and your role in it')
  .argument('[action]', 'only `show` is supported', 'show')
  .action((action: string) => {
    if (action !== 'show') {
      console.error('scale: usage — scale policy show');
      console.error('  (edit the policy in the Settings modal Team tab, or in an editor)');
      process.exitCode = 1;
      return;
    }
    const cwd = process.cwd();
    const dir = stateDir(cwd);
    const file = path.join(cwd, '.scale', 'policy.json');
    const policy = readPolicyRaw(cwd);
    const eff = loadEffectiveConfig(cwd, dir);
    const identity = currentIdentityEmails(cwd, eff.config);
    const leads = policyLeads(policy.raw);
    const lead = isLead(policy.raw, identity);

    console.log(`policy file: ${file}`);
    if (!policy.present) {
      console.log('  (none committed — every setting falls back to the schema defaults)');
    } else if (policy.parseError) {
      console.log('  ⚠ present but NOT valid JSON — it is being ignored entirely');
    } else {
      console.log(JSON.stringify(policy.raw, null, 2));
      if (eff.policyError) console.log(`  ⚠ ignored: ${eff.policyError}`);
    }

    console.log(
      `\nleads: ${leads.length > 0 ? leads.join(', ') : '(nobody listed — anyone may edit)'}`,
    );
    console.log(
      `your git identity: ${identity.length > 0 ? identity.join(', ') : '(none resolved)'}`,
    );
    console.log(`you are: ${lead ? 'a TEAM LEAD' : 'a member'}`);
    if (lead && leads.length === 0) {
      console.log(
        '  Nobody is a lead yet, so anyone can edit the policy. Add yourself to ' +
          '`leads` to close it.',
      );
    }
    // Said out loud every time, because a list of names in a JSON file reads
    // like an access control and is not one.
    console.log(
      '\nNote: `leads` gates the Settings UI, not the file. Anyone who can write ' +
        'the repo can edit .scale/policy.json directly — use git review / ' +
        'CODEOWNERS on that path for the real control.',
    );
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

/** Render one config leaf as `value (source: …)`, or every leaf when key is absent. */
function explainKey(cwd: string, dir: string, key: string | undefined, json: boolean): void {
  const policy = readPolicyRaw(cwd);
  const sources = explainConfig(
    readUserConfigRaw(dir) ?? { user: process.env.USER ?? 'user' },
    policy.parseError ? undefined : policy.raw,
  );
  const render = (k: string): string => {
    const leaf = sources[k]!;
    const label =
      leaf.source === 'user'
        ? 'user override'
        : leaf.source === 'policy'
          ? 'team policy'
          : 'default';
    const extra =
      leaf.source === 'user' && leaf.policyValue !== undefined
        ? `; team default: ${JSON.stringify(leaf.policyValue)}`
        : leaf.source === 'user' && leaf.defaultValue !== undefined
          ? `; default: ${JSON.stringify(leaf.defaultValue)}`
          : '';
    return `${k} = ${JSON.stringify(leaf.value)}  (source: ${label}${extra})`;
  };

  if (!key) {
    if (json) console.log(JSON.stringify(sources));
    else for (const k of Object.keys(sources).sort()) console.log(render(k));
    return;
  }
  const leaf = sources[key];
  if (!leaf) {
    console.error(`scale: no such config key "${key}".`);
    process.exitCode = 1;
    return;
  }
  if (json) {
    console.log(
      JSON.stringify({
        key,
        value: leaf.value,
        source: leaf.source,
        ...(leaf.policyValue !== undefined ? { policyValue: leaf.policyValue } : {}),
        ...(leaf.defaultValue !== undefined ? { defaultValue: leaf.defaultValue } : {}),
      }),
    );
  } else {
    console.log(render(key));
  }
}

config
  .command('get')
  .description('Print the EFFECTIVE config, or a single dotted key (e.g. gate.assessment)')
  .argument('[key]', 'dotted key path')
  .option('--raw', 'print your sparse user overrides file instead of the effective view', false)
  .option(
    '--explain',
    'also say WHERE the value comes from: your override, the team policy, or ' +
      'the schema default (and what the team default would be)',
    false,
  )
  .option('--json', 'machine-readable output (with --explain)', false)
  .action((key: string | undefined, opts: { raw?: boolean; explain?: boolean; json?: boolean }) => {
    const cwd = process.cwd();
    const dir = stateDir(cwd);
    if (!configExists(dir)) {
      console.error('scale: no config found — run `scale init` first.');
      process.exitCode = 1;
      return;
    }

    // --explain answers a different question from --raw: not "what did I write"
    // but "why is the effective value what it is". The provenance comes from
    // core's explainConfig — the SAME function the web Settings page renders its
    // chips from, so chat and the browser can never disagree about whose value
    // is in force.
    if (opts.explain) {
      explainKey(cwd, dir, key, opts.json === true);
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
    const before = loadEffectiveConfig(cwd, dir).config;
    const raw = readUserConfigRaw(dir) ?? { user: process.env.USER ?? 'user' };
    const next = migrateLegacyConfig(setPath(raw, key, value)) as Record<string, unknown>;
    const policy = readPolicyRaw(cwd);
    try {
      resolveConfig(next, policy.parseError ? undefined : policy.raw); // validate effective
      writeUserConfigRaw(dir, next);
      const effective = loadEffectiveConfig(cwd, dir).config;
      recordConfigDelta(dir, cwd, before, effective, 'cli', false);
      console.log(`scale: set ${key} → ${JSON.stringify(getPath(next, key) ?? getPath(effective, key))}`);
    } catch (err) {
      console.error(`scale: invalid config after set — ${(err as Error).message.split('\n')[0]}`);
      process.exitCode = 1;
    }
  });

config
  .command('unset')
  .description(
    'Remove a personal override so the team default (or schema default) applies ' +
      'again. Logged as a reset in telemetry.',
  )
  .argument('<key>', 'dotted key path (e.g. gate.enforcement)')
  .action((key: string) => {
    const cwd = process.cwd();
    const dir = stateDir(cwd);
    if (!configExists(dir)) {
      console.error('scale: no config found — run `scale init` first.');
      process.exitCode = 1;
      return;
    }
    if (key === 'user') {
      console.error('scale: `user` is your identity, not an override — set it instead.');
      process.exitCode = 1;
      return;
    }
    const before = loadEffectiveConfig(cwd, dir).config;
    const raw = migrateLegacyConfig(
      readUserConfigRaw(dir) ?? { user: process.env.USER ?? 'user' },
    ) as Record<string, unknown>;
    if (getPath(raw, key) === undefined) {
      console.log(`scale: ${key} is not overridden in your config — nothing to unset.`);
      return;
    }
    const next = unsetPath(raw, key);
    const policy = readPolicyRaw(cwd);
    try {
      resolveConfig(next, policy.parseError ? undefined : policy.raw);
      writeUserConfigRaw(dir, next);
      const effective = loadEffectiveConfig(cwd, dir).config;
      recordConfigDelta(dir, cwd, before, effective, 'cli', true);
      console.log(`scale: unset ${key} → now ${JSON.stringify(getPath(effective, key))} (team/schema default)`);
    } catch (err) {
      console.error(`scale: invalid config after unset — ${(err as Error).message.split('\n')[0]}`);
      process.exitCode = 1;
    }
  });

// ---------------------------------------------------------------------------
// telemetry  (REAL) — the shippable study stream, local only for now
// ---------------------------------------------------------------------------
const telemetry = program
  .command('telemetry')
  .description(
    'Study telemetry kept in ~/.scale/<repo-id>/telemetry.jsonl: config overrides, ' +
      'gate denies, skips, redirects, out-of-band edits, unlocks, re-locks, session ' +
      'tallies. Nothing leaves the machine; the collection path is a separate decision.',
  );

telemetry
  .command('summary')
  .description('Counts and the learning-vs-avoidance ratios over the whole log')
  .option('--json', 'machine-readable', false)
  .action((opts: { json?: boolean }) => {
    const dir = stateDir(process.cwd());
    const rows = readTelemetrySafe(dir);
    const s = summarizeTelemetry(rows);
    if (opts.json) {
      console.log(JSON.stringify(s, null, 2));
      return;
    }
    if (rows.length === 0) {
      console.log(`scale: no telemetry yet (${paths.telemetry(dir)}).`);
      return;
    }
    const pct = (x: number | null): string => (x === null ? '—' : `${Math.round(x * 100)}%`);
    console.log(`telemetry: ${s.rows} rows, ${s.sessions} closed session(s) — ${paths.telemetry(dir)}`);
    console.log(`  gate:      ${s.denies} deny, ${s.redenies} re-deny`);
    console.log(`  learning:  ${s.unlocks} unlock (${s.recoveries} recovered after drift), ${s.relocks} re-lock`);
    console.log(
      `  avoidance: ${s.skips.user} skip (user) + ${s.skips.agent} (agent), ${s.redirects} redirect, ` +
        `${s.outOfBand} out-of-band; ${pct(s.avoidanceRate)} of denied components never unlocked ` +
        `(${s.deniedComponents - s.unlockedAfterDeny}/${s.deniedComponents})`,
    );
    console.log(
      `  overrides: ${s.overrides.loosen} loosen, ${s.overrides.tighten} tighten, ` +
        `${s.overrides.neutral} neutral, ${s.overrides.unknown} unclassified, ${s.overrides.resets} reset`,
    );
    if (s.medianOwedMs !== null) {
      console.log(`  owed checks cleared after a median of ${Math.round(s.medianOwedMs / 60000)} min`);
    }
  });

telemetry
  .command('path')
  .description('Print the telemetry file path')
  .action(() => console.log(paths.telemetry(stateDir(process.cwd()))));

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
