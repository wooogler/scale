/**
 * Gather what changed in a component since the user last validated it, for the
 * recovery check's grounding (PLAN-GATE §4 S2b).
 *
 * The impure half of the drift block: git lives here, the budget and rendering
 * live in `@scale/core`'s `paperGrounding`. Everything fails to `null`, which
 * simply means the check is grounded in the paper alone — the same check the
 * junior would have got before this existed.
 *
 * NOT on the hook path. This runs at quest generation and at tutor time, both
 * of which already talk to a model.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

import type { DriftContext, DriftHunk } from '@scale/core';

/**
 * Git invocations are pinned against the user's own config.
 *
 * A developer's `~/.gitconfig` can set an external diff driver, colour, a
 * different algorithm, or mnemonic prefixes — and any of those would change
 * what we parse, or in the case of `diff.external` hand execution to a program
 * of theirs. The output feeds a prompt, so it has to be a function of the
 * repository and nothing else.
 */
const PINNED_CONFIG = [
  '--no-pager',
  '-c',
  'color.ui=false',
  '-c',
  'diff.noprefix=false',
  '-c',
  'diff.mnemonicPrefix=false',
  '-c',
  'diff.algorithm=myers',
];

/**
 * Per-command flags that neutralize user-configured diff programs.
 *
 * `--no-ext-diff`, NOT `-c diff.external=`: an empty `diff.external` does not
 * mean "no external diff", it means "run the empty string as one", and git
 * duly reports `cannot run : No such file or directory` and dies. The flag is
 * the supported way to say it, and `--no-textconv` covers the filter form.
 */
const PINNED_FLAGS = ['--no-ext-diff', '--no-textconv'];

function git(cwd: string, args: string[], flags: string[] = []): string | null {
  try {
    return execFileSync('git', [...PINNED_CONFIG, ...args.slice(0, 1), ...flags, ...args.slice(1)], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/** `@@ -a,b +c,d @@ <enclosing declaration>` — the tail is git's own context. */
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@(?: (.*))?$/;
/** `diff --git a/<path> b/<path>` — the start of the next file's section. */
const FILE_HEADER = /^diff --git a\/(.*) b\/(.*)$/;

/**
 * Tidy git's hunk-context string into something worth naming as a "region".
 *
 * The heuristic reports the nearest preceding line that looks like a
 * declaration, so a hunk near the top of a file yields an `import` — noise in a
 * list meant to say WHICH PARTS of the component moved. Imports are dropped and
 * the rest is trimmed to its signature head, since a full generic signature can
 * run longer than the hunk it labels.
 */
function declarationName(raw: string): string {
  const s = raw.trim();
  if (!s || /^import\b/.test(s) || /^\/\//.test(s)) return '';
  // Git's heuristic picks the nearest preceding line that merely LOOKS like a
  // declaration, which for markdown, CSS or a run of assignments is any old
  // line — and "regions touched: const a7 = 7" invites a `structure` item built
  // on nothing. Require an actual declaring keyword.
  if (!/^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:function|class|interface|type|enum|const|let|var|public|private|protected|static|def|fn|func|struct|impl|trait|module|namespace)\b/.test(s)) {
    return '';
  }
  // Cut at the opening brace/paren so `function f(a: X, b: Y): Z {` reads `function f`.
  const head = s.split(/[({=]/)[0]?.trim() ?? s;
  const name = head || s;
  return name.length > 60 ? `${name.slice(0, 57)}…` : name;
}

/**
 * Split a unified diff into hunks, keeping the enclosing-declaration names git
 * puts after the `@@`. Git's built-in heuristic finds these for TS/JS without a
 * custom diff driver (verified on this repo).
 */
function parseHunks(diff: string): { hunks: DriftHunk[]; regions: string[] } {
  const hunks: DriftHunk[] = [];
  const regions: string[] = [];
  let path = '';
  let current: { header: string; body: string[]; churn: number } | null = null;

  const flush = (): void => {
    if (!current) return;
    hunks.push({
      header: current.header,
      body: current.body.join('\n'),
      churn: current.churn,
      ...(path ? { path } : {}),
    });
    current = null;
  };

  for (const line of diff.split('\n')) {
    // A hunk ENDS at the next file's header. Without this the following file's
    // `diff --git`, `index`, `--- a/…` and `+++ b/…` lines were appended to the
    // previous hunk's body — and the last two begin with `-`/`+`, so they were
    // counted as churn. Churn is the sole ranking key for the budget, so a
    // multi-file component was ranked on a systematic over-count and could drop
    // the very hunk the recovery check needed.
    const fileMatch = FILE_HEADER.exec(line);
    if (fileMatch) {
      flush();
      path = fileMatch[2] ?? fileMatch[1] ?? '';
      continue;
    }
    const m = HUNK_HEADER.exec(line);
    if (m) {
      flush();
      current = { header: line, body: [], churn: 0 };
      const region = declarationName(m[1] ?? '');
      if (region && !regions.includes(region)) regions.push(region);
      continue;
    }
    if (!current) continue; // index/---/+++ lines between a file header and its first hunk
    current.body.push(line);
    if (line.startsWith('+') || line.startsWith('-')) current.churn++;
  }
  flush();
  return { hunks, regions };
}

/**
 * Build the drift context for one component, or null when there is nothing to
 * show (no anchor, no sources, an unresolvable sha, or an empty diff).
 *
 * `sinceSha` is the component's `lastValidatedSha` — the point the junior's
 * understanding is anchored to, which is exactly where the changes they have
 * not seen begin.
 */
export function driftContext(
  cwd: string,
  sinceSha: string | null,
  sources: string[],
  cause: 'foreign' | 'self',
  /** How much may reach the model — see `drift.shareDiff`. */
  share: 'full' | 'metadata' | 'off' = 'full',
): DriftContext | null {
  if (share === 'off') return null;
  if (!sinceSha || sources.length === 0) return null;
  // The anchor reaches a git argv position, where a leading `-` would be read as
  // an option rather than a revision. It always comes from our own coverage
  // record, but that record is a JSON file on disk, so the shape is checked here
  // rather than assumed.
  if (!/^[0-9a-f]{4,40}$/i.test(sinceSha)) return null;
  const range = `${sinceSha}..HEAD`;

  // %x1f is a unit separator — a subject can contain anything else.
  const logOut = git(cwd, ['log', `--format=%h%x1f%aE%x1f%s`, range, '--', ...sources], PINNED_FLAGS);
  if (logOut === null) return null; // unresolvable anchor → paper-only grounding
  const commits = logOut
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [sha = '', author = '', subject = ''] = l.split('\x1f');
      return { sha, author, subject };
    });

  const numOut = git(cwd, ['diff', '--numstat', range, '--', ...sources], PINNED_FLAGS) ?? '';
  const files = numOut
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [a = '', d = '', ...rest] = l.split('\t');
      // `-\t-` means git called the file binary and reports no counts. Rendering
      // that as `+0 −0` says "unchanged", which is the opposite of the truth for
      // a wholesale binary replacement.
      const binary = a === '-' || d === '-';
      const added = Number(a);
      const deleted = Number(d);
      return {
        path: rest.join('\t'),
        added: Number.isFinite(added) ? added : 0,
        deleted: Number.isFinite(deleted) ? deleted : 0,
        ...(binary ? { binary: true } : {}),
      };
    })
    .filter((f) => f.path);

  // -U1, not -U3: measured on this repo it costs 12% fewer characters for the
  // same hunks, which is 12% more hunks inside the same budget.
  const diff = git(cwd, ['diff', '-U1', range, '--', ...sources], PINNED_FLAGS);
  if (!diff) return null;
  const { hunks, regions } = parseHunks(diff);
  if (hunks.length === 0) return null;

  // A fresh id per request, so the fence markers cannot be predicted by
  // someone writing the code earlier — see DriftContext.fenceId.
  return {
    sinceSha,
    cause,
    commits,
    files,
    regions,
    // `metadata` keeps the shape of the change — who, which files, which
    // declarations — and sends no source lines at all.
    hunks: share === 'metadata' ? [] : hunks,
    fenceId: crypto.randomUUID().slice(0, 8),
  };
}
