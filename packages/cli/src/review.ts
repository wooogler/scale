/**
 * `scale review …` — the CHAT-based post-session check path (PLAN-GATE §4 S3).
 *
 * The async arm of the study denies an edit, TEACHES instead of quizzing, and
 * leaves the comprehension check owed for "later". Until now "later" existed
 * only inside the map viewer's quest runner; this module is the other surface
 * for it: a queue the `/scale-review` command walks in chat, one component at a
 * time, running the SAME check the junior would have had in the flow.
 *
 * PROCESS PARITY IS THE POINT. The experiment manipulates WHEN the check
 * happens and nothing else, so this module deliberately owns no policy of its
 * own:
 *   - the instruction the tutor follows comes from core's `checkBrief` — the
 *     one generator the in-flow deny also uses;
 *   - the queue is picked by `pickComponents()` from quest.ts, the same
 *     function the web quest path uses, so the two never disagree on what is
 *     worth reviewing;
 *   - recording, unlocking and skipping stay with `scale record` /
 *     `noteCheckOutcome` / `scale gate defer`.
 * What lives here is the bookkeeping the chat path needs and nothing else:
 * "what does this user still owe", "what did they touch since their last
 * check", and "what code did they actually write in that territory".
 *
 * Everything in here is pure over injected data except the two thin I/O
 * wrappers at the bottom (`readEvidenceRecords`, `gitTerritoryDiff`).
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

import type { MapJson, ScaleConfig, UserCoverage } from '@scale/core';
import { meanDims, emptyComponentCoverage } from '@scale/core';

import { paths } from './state.js';
import { pickComponents } from './quest.js';

/** Default byte cap for `scale review diff` (a few thousand lines of patch). */
export const DEFAULT_DIFF_MAX_BYTES = 60_000;

/**
 * One raw evidence line, read defensively.
 *
 * `evidence.jsonl` is append-only and spans schema versions, so the pure
 * helpers below take `unknown`-shaped records and validate field by field
 * rather than parsing through zod: one malformed historical row must never
 * empty the review queue.
 */
export type RawEvidence = Record<string, unknown>;

/**
 * What a user did to ONE component since that component was last checked or
 * skipped. This is the "touched" half of the review queue.
 */
export interface TouchWindow {
  componentId: string;
  /** ISO ts of the EARLIEST touch/prompt in the window — the diff's anchor. */
  since: string;
  /** ISO ts of the most recent touch/prompt in the window. */
  lastTouch: string;
  /** Repo-relative files from `touch` rows in the window (deduped, sorted). */
  files: string[];
  /**
   * Distinct UTC days the component was touched on, as a cheap stand-in for
   * "how many work stretches this spans". Evidence rows carry no session id
   * (only telemetry does), and adding one would mean a new persistent marker
   * for a number that is decoration on a queue line — so the day count is what
   * is honestly available from the log itself.
   */
  sessions: number;
}

/** Evidence types that count as the user TOUCHING a component. */
const TOUCH_TYPES = new Set(['touch', 'prompt']);

/**
 * Per-component touch activity NEWER than that component's last comprehension
 * check or skip (PLAN-GATE §4 S3).
 *
 * "Last checked" is the latest of its `quiz_result` / `socratic_result` /
 * `intervention{outcome:'deferred'}` rows: a graded check closes the window,
 * and so does an explicit skip — the junior said "not this one", and a review
 * that re-queued it the next morning would be nagging, not teaching.
 *
 * Deriving the window from the evidence log rather than from a new "last
 * reviewed" marker is deliberate: coverage is already a fold over this log, and
 * a second source of truth for the same question would eventually disagree with
 * it (and would have to be migrated, backed up, and reset alongside it).
 */
export function touchedSinceLastCheck(entries: Iterable<RawEvidence>): Map<string, TouchWindow> {
  /** componentId → epoch ms of its most recent check/skip. */
  const lastCheck = new Map<string, number>();
  /** componentId → touch events, unsorted. */
  const touches = new Map<string, { ts: number; iso: string; files: string[] }[]>();

  for (const e of entries) {
    const type = typeof e.type === 'string' ? e.type : '';
    const iso = typeof e.ts === 'string' ? e.ts : '';
    const ts = Date.parse(iso);
    if (!Number.isFinite(ts)) continue;

    if (TOUCH_TYPES.has(type)) {
      const ids = Array.isArray(e.componentIds) ? e.componentIds : [];
      const files = Array.isArray(e.files)
        ? e.files.filter((f): f is string => typeof f === 'string')
        : [];
      for (const id of ids) {
        if (typeof id !== 'string' || !id) continue;
        const list = touches.get(id) ?? [];
        list.push({ ts, iso, files });
        touches.set(id, list);
      }
      continue;
    }

    const id = typeof e.componentId === 'string' ? e.componentId : '';
    if (!id) continue;
    const closes =
      type === 'quiz_result' ||
      type === 'socratic_result' ||
      (type === 'intervention' && e.outcome === 'deferred');
    if (!closes) continue;
    if ((lastCheck.get(id) ?? -Infinity) < ts) lastCheck.set(id, ts);
  }

  const out = new Map<string, TouchWindow>();
  for (const [id, list] of touches) {
    const cutoff = lastCheck.get(id) ?? -Infinity;
    const after = list.filter((t) => t.ts > cutoff).sort((a, b) => a.ts - b.ts);
    if (after.length === 0) continue;
    const files = new Set<string>();
    const days = new Set<string>();
    for (const t of after) {
      for (const f of t.files) files.add(f);
      days.add(t.iso.slice(0, 10));
    }
    out.set(id, {
      componentId: id,
      since: after[0]!.iso,
      lastTouch: after[after.length - 1]!.iso,
      files: [...files].sort(),
      sessions: days.size,
    });
  }
  return out;
}

/**
 * The subset of `files` that lies inside a component's declared `sources`.
 *
 * WHY: a `touch` row lists every file of ONE edit event and credits every
 * component those files map to, so a two-file edit spanning two territories
 * records both files against both components. Left alone, that hands each
 * review brief a file list (and each `review diff` a patch) containing code
 * from someone else's territory — grounding a check in the wrong mechanism.
 *
 * Prefix matching, because a doc's `sources` entry may name a directory as
 * easily as a file. An EMPTY result is returned as such: the caller decides
 * whether to fall back (the file→component index has a nearest-directory
 * fallback, so a component can legitimately be credited by a file its doc does
 * not list).
 */
export function filesInTerritory(files: string[], sources: string[]): string[] {
  if (sources.length === 0) return [...files];
  return files.filter((f) =>
    sources.some((s) => f === s || f.startsWith(s.endsWith('/') ? s : `${s}/`)),
  );
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

/** One component the junior should review now. Mirrors the JSON shape 1:1. */
export interface ReviewItem {
  componentId: string;
  title: string;
  /** `owed` — an async deny recorded it; `touched` — worked on, still low. */
  reason: 'owed' | 'touched';
  /** ISO ts the reason dates from: the deny, or the first touch in the window. */
  since: string;
  lastTouch: string | null;
  files: string[];
  sessions: number;
  coverage: { state: string; mean: number };
}

export interface ReviewQueueInput {
  coverage: UserCoverage;
  map: MapJson;
  config: ScaleConfig;
  /** `locks.pendingUnlocks` — componentId → the deny that owes a check. */
  pending: Record<string, { at: string }>;
  /** Output of {@link touchedSinceLastCheck}. */
  touched: Map<string, TouchWindow>;
  /** componentId → doc title; a missing title falls back to the id. */
  titles?: Record<string, string>;
  /** componentId → the doc's declared sources, for {@link filesInTerritory}. */
  sources?: Record<string, string[]>;
  limit: number;
}

/**
 * The ordered review queue: owed checks first, then touched ∩ low-coverage
 * ranked by importance × comprehension gap.
 *
 * Selection is `pickComponents()` — the SAME picker the post-session quest
 * generator runs — so a junior in the chat arm and a junior in the viewer arm
 * are pointed at the same territory in the same order. The one thing done to
 * its answer is a filter: `pickComponents` falls back to "the K lowest-coverage
 * components overall" when nothing was touched, which is a sane way to fill a
 * quest batch but wrong for a review — the review is about what THIS user just
 * did, and inventing items for territory they never opened would turn an empty
 * queue into homework.
 */
export function buildReviewQueue(input: ReviewQueueInput): ReviewItem[] {
  const { coverage, map, config, pending, touched, limit } = input;
  const titles = input.titles ?? {};
  if (limit <= 0) return [];

  // Sorted for determinism: `pickComponents` preserves the order it is handed.
  const owed = Object.keys(pending).sort();
  const picked = pickComponents(
    coverage,
    map,
    new Set(touched.keys()),
    config,
    limit,
    owed,
  );

  const items: ReviewItem[] = [];
  for (const id of picked) {
    const isOwed = pending[id] !== undefined;
    const window = touched.get(id);
    if (!isOwed && !window) continue; // fallback pick — not this user's doing
    const comp = coverage.components[id] ?? emptyComponentCoverage();
    items.push({
      componentId: id,
      title: titles[id] ?? id,
      reason: isOwed ? 'owed' : 'touched',
      since: isOwed ? pending[id]!.at : window!.since,
      lastTouch: window?.lastTouch ?? null,
      files: territoryFiles(window?.files ?? [], input.sources?.[id] ?? []),
      sessions: window?.sessions ?? 0,
      coverage: { state: comp.state, mean: meanDims(comp.dims) },
    });
  }
  return items;
}

/**
 * Touched files narrowed to the component's own territory, falling back to the
 * unnarrowed list when the narrowing empties it (the file→component index's
 * nearest-directory fallback can credit a component with a file its doc does
 * not list, and dropping that file would leave a touched item with no grounding
 * at all).
 */
export function territoryFiles(files: string[], sources: string[]): string[] {
  const narrowed = filesInTerritory(files, sources);
  return narrowed.length > 0 ? narrowed : files;
}

/** `owed  gate-core — Edit gate (explored 0.31) · 2 file(s) since 2026-09-19` */
export function formatReviewItem(item: ReviewItem): string {
  const files = `${item.files.length} file(s)`;
  return (
    `${item.reason.padEnd(7)} ${item.componentId} — ${item.title} ` +
    `(${item.coverage.state} ${item.coverage.mean.toFixed(2)}) · ${files} since ` +
    `${item.since.slice(0, 10)}`
  );
}

// ---------------------------------------------------------------------------
// The grounding diff — what the junior actually wrote in that territory
// ---------------------------------------------------------------------------

/** Raw git output for one territory, before formatting. */
export interface TerritoryDiff {
  /** `git log -p --since=<since>` over the files (may be ''). */
  commits: string;
  /** Working-tree (+ staged) diff for the same files (may be ''). */
  worktree: string;
  /** False when git could not be run at all — the caller degrades to a note. */
  ok: boolean;
}

/**
 * Cut `text` to at most `maxBytes` BYTES, on a line boundary, with a trailing
 * `… truncated` marker.
 *
 * Bytes rather than characters because the cap exists to protect a context
 * window and a terminal, both of which pay per byte; and on a line boundary
 * because half a hunk header reads as corruption to whoever (or whatever) is
 * about to interpret the patch.
 */
export function truncateDiff(text: string, maxBytes: number = DEFAULT_DIFF_MAX_BYTES): string {
  if (maxBytes <= 0) return '… truncated';
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= maxBytes) return text;
  let cut = buf.subarray(0, maxBytes).toString('utf8');
  const lastNewline = cut.lastIndexOf('\n');
  // Keep whole lines when there is at least one; a single enormous line is
  // truncated mid-line rather than dropped entirely (it may be the only content).
  if (lastNewline > 0) cut = cut.slice(0, lastNewline);
  return `${cut}\n… truncated`;
}

export interface ReviewDiffInput {
  componentId: string;
  /** Window anchor — the ISO ts the changes are measured from. */
  since: string;
  files: string[];
  diff: TerritoryDiff;
  maxBytes?: number;
}

/**
 * The grounding block for one review item: a header naming the territory and
 * its window, then the commits and the working tree.
 *
 * Empty is a legitimate answer (the junior may have edited nothing since, or
 * the deny may have blocked the only edit), and it is stated rather than left
 * blank — a tutor reading an empty diff must know it looked and found nothing,
 * not that the lookup failed.
 */
export function formatReviewDiff(input: ReviewDiffInput): string {
  const { componentId, since, files, diff } = input;
  const head = [
    `# scale review diff — ${componentId} (since ${since})`,
    `# files: ${files.length > 0 ? files.join(', ') : '(none recorded)'}`,
  ];
  if (!diff.ok) {
    head.push('# git unavailable here — no diff could be read (the check is still valid).');
    return head.join('\n');
  }
  const sections: string[] = [];
  if (diff.commits.trim()) sections.push(`--- commits since then ---\n${diff.commits.trimEnd()}`);
  if (diff.worktree.trim()) sections.push(`--- working tree ---\n${diff.worktree.trimEnd()}`);
  if (sections.length === 0) {
    head.push('# no changes to these files in this window.');
    return head.join('\n');
  }
  return truncateDiff(
    `${head.join('\n')}\n${sections.join('\n\n')}`,
    input.maxBytes ?? DEFAULT_DIFF_MAX_BYTES,
  );
}

/** One git invocation, best-effort: stdout, or null when git says no. */
function git(cwd: string, args: string[], maxBuffer: number): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer,
    });
  } catch {
    return null;
  }
}

/**
 * Commits touching `files` since `since`, plus the current working-tree diff
 * for the same files. Thin wrapper — no formatting, no policy.
 *
 * Author is deliberately NOT filtered: a territory the junior touched may also
 * have moved under them, and "what changed here since you started" is the
 * context the check needs. `--since` on `git log` is a commit-DATE filter, so a
 * rebased or cherry-picked commit can fall outside the window; that is an
 * acceptable miss for a grounding aid, and the working-tree diff (where
 * uncommitted work lives) is unaffected.
 */
export function gitTerritoryDiff(
  cwd: string,
  files: string[],
  since: string,
  maxBytes: number = DEFAULT_DIFF_MAX_BYTES,
): TerritoryDiff {
  if (files.length === 0) return { commits: '', worktree: '', ok: true };
  // Read a little more than the cap so the truncation marker is honest about
  // there being more, then let `truncateDiff` do the cutting.
  const buffer = Math.max(maxBytes * 4, 1 << 20);
  // No window anchor (an owed deny that left no touch rows, on a component
  // never checked) → the working tree alone. An unbounded `git log -p` over a
  // component's whole history is not "what the junior changed"; it is the file.
  const commits = since
    ? git(cwd, ['log', '-p', '--no-color', `--since=${since}`, '--', ...files], buffer)
    : '';
  const worktree = git(cwd, ['diff', '--no-color', 'HEAD', '--', ...files], buffer);
  // Every attempted call failing is the "git unavailable" signal (not a repo,
  // no git on PATH). One failing is ordinary — an empty repo has no HEAD to
  // diff against, and that is not a reason to suppress the commit log.
  const attempted = since ? [commits, worktree] : [worktree];
  if (attempted.every((r) => r === null)) return { commits: '', worktree: '', ok: false };
  return { commits: commits ?? '', worktree: worktree ?? '', ok: true };
}

// ---------------------------------------------------------------------------
// Evidence I/O — one read, defensively parsed
// ---------------------------------------------------------------------------

/**
 * Every parseable line of `evidence.jsonl`, as raw records.
 *
 * ONE read: `scale context` runs on the SessionStart hook path (< 200 ms), and
 * this log is the only extra file the review nudge needs, so the whole thing is
 * read once and the pure helpers fold over it in memory.
 */
export function readEvidenceRecords(dir: string): RawEvidence[] {
  let text: string;
  try {
    text = fs.readFileSync(paths.evidence(dir), 'utf8');
  } catch {
    return [];
  }
  const out: RawEvidence[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        out.push(parsed as RawEvidence);
      }
    } catch {
      /* a torn/legacy line is skipped, never fatal */
    }
  }
  return out;
}

/**
 * True when this session has already opened a review check for `componentId` —
 * i.e. an `intervention{trigger:'review', outcome:'requested'}` row exists at
 * or after `sessionStartedAt`.
 *
 * `scale review start` is the accounting row that says "the check was put in
 * front of the junior", and the skill may legitimately re-print a brief (the
 * junior scrolled away, the agent lost the thread). Counting that as a second
 * intervention would inflate exactly the number the study reads.
 */
export function reviewAlreadyOpened(
  entries: Iterable<RawEvidence>,
  componentId: string,
  sessionStartedAt: string,
): boolean {
  const cutoff = Date.parse(sessionStartedAt);
  if (!Number.isFinite(cutoff)) return false;
  for (const e of entries) {
    if (e.type !== 'intervention' || e.componentId !== componentId) continue;
    if (e.trigger !== 'review' || e.outcome !== 'requested') continue;
    const ts = typeof e.ts === 'string' ? Date.parse(e.ts) : NaN;
    if (Number.isFinite(ts) && ts >= cutoff) return true;
  }
  return false;
}
