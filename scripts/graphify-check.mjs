#!/usr/bin/env node
/**
 * Map fidelity report — compare the LLM-authored coverage memory in `.scale/`
 * against ground truth (PLAN-GRAPHIFY.md §4, P0.3).
 *
 * Every structural claim in `.scale/` — where a component's boundary falls, which
 * files anchor it, which components relate to which — was written by an LLM during
 * the `/scale-map` build. Nothing has ever checked those claims against the code.
 * This script does the checking. It is STRICTLY READ-ONLY: it never writes to
 * `.scale/` or anywhere else, so it is safe to run at any point in the study. The
 * only subprocesses it runs are read-only git plumbing (`ls-files`, `rev-parse`,
 * `diff`), and every one of them degrades to a printed note if git is unavailable.
 *
 * Two modes, because the interesting metrics have different prerequisites:
 *
 *   ANCHOR MODE (always available) — needs only `.scale/` plus the filesystem:
 *     0. stale anchors   — anchors that changed since map.json's builtFromSha
 *     1. orphan files    — source files no component claims
 *     2. bad anchors     — paths a paper claims that are missing / not a file /
 *                          spelled with the wrong case
 *     3. double-claimed  — files claimed by more than one component
 *
 *   GRAPH MODE (adds three metrics) — needs a graphify AST graph, supplied with
 *   `--graph <path>` or auto-detected at `graphify-out/graph.json`:
 *     4. link recall     — AST-connected component pairs that the map also links
 *     5. link precision  — map-linked component pairs that AST edges corroborate
 *     6. cohesion        — how much of each component's edge mass stays inside it
 *
 *   graphify is NEVER a dependency of this repo (PLAN-GRAPHIFY §3). With no
 *   graph.json present the script prints the anchor metrics, notes which metrics
 *   were skipped and why, and still exits 0.
 *
 * Attribution rule, load-bearing everywhere: file → component uses EXACT `sources`
 * matching only. The one exception is the ADVISORY owner set printed beside each
 * orphan, which is explicitly labelled and never enters a metric.
 *
 * Usage:
 *   npm run check:map                                   # anchor mode
 *   node scripts/graphify-check.mjs                     # the same thing
 *   node scripts/graphify-check.mjs --graph out/g.json  # + graph metrics
 *   node scripts/graphify-check.mjs --json              # machine-readable
 *
 * Exit codes: 0 = report produced (even when it finds problems — findings are the
 * point, not a failure). 1 only on a real error, of which there are exactly six:
 *   - no `.scale/` directory at the repo root
 *   - `.scale/` exists but holds no valid component paper
 *   - `@scale/core` cannot be imported (unbuilt or uninstalled)
 *   - an unknown argument, or `--graph` with no path
 *   - an explicit `--graph <path>` that does not exist (an explicit request that
 *     cannot be honoured is an error; a MISSING auto-detected graph is not)
 *   - a graph.json that cannot be read or parsed, or has no nodes/links arrays
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';

const TOOLCHAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The repository being audited. Defaults to this one; `--root <dir>` audits any
 * other checkout with a `.scale/`, so link precision can be measured on a second
 * codebase rather than generalised from one.
 */
function rootArg() {
  const eq = process.argv.find((a) => a.startsWith('--root='));
  if (eq) return resolve(eq.slice('--root='.length));
  const i = process.argv.indexOf('--root');
  const v = i >= 0 ? process.argv[i + 1] : null;
  return v && !v.startsWith('--') ? resolve(v) : TOOLCHAIN;
}
const ROOT = rootArg();

// ---------------------------------------------------------------------------
// Audit surface — the constants below decide what "orphan" even means, so they
// are declared up front rather than buried in the walk.
//
// The surface is DERIVED, not listed: every file git tracks or would track
// (`git ls-files --cached --others --exclude-standard`) minus the exclusions
// here. A hardcoded root list silently exempts whatever it forgets — papers in
// this repo already anchor `scripts/`, `packages/core/fixtures/`,
// `.claude-plugin/` and repo-root `*.md`, none of which live under a `src/`.
// Deriving makes THIS LIST the single auditable definition of the surface, and
// the report cross-checks it: any path a paper claims that these exclusions
// would hide is printed back as a finding.
// ---------------------------------------------------------------------------

/**
 * Fallback roots, used only when git is unavailable (no repo, no git binary).
 * The derived surface is strictly better; this keeps the script useful in a
 * tarball export rather than failing.
 */
const FALLBACK_SCAN_ROOTS = [
  'packages/cli/src',
  'packages/core/src',
  'packages/web/src',
  'packages/plugin',
  'scripts',
];

/**
 * Directory names pruned anywhere in a path. `__tests__` is test code (never a
 * learning target — no paper should anchor it), `dist` / `web-dist` are compiler
 * and bundler output, `node_modules` is vendored. Matching on the NAME rather
 * than a path makes the rule total: a package added later cannot smuggle a build
 * directory back into the scan.
 */
const EXCLUDED_DIR_NAMES = new Set([
  '__tests__',
  'dist',
  'web-dist',
  'node_modules',
  '.git',
]);

/**
 * Repo-relative path prefixes pruned outright.
 *   `.scale`             — the coverage memory itself. It is the artifact under
 *                          audit, not a learning target; scanning it would
 *                          report every paper as an orphan of itself. (The
 *                          `scale-sample` fixture tree under packages/core is
 *                          NOT covered by this prefix, and two of its files are
 *                          legitimately anchored by papers.)
 *   `packages/plugin/bin` — the single-file CLI bundle `scripts/build-plugin.mjs`
 *                          generates. Tens of thousands of generated lines that
 *                          would swamp the orphan count while being exactly the
 *                          thing no paper should ever anchor.
 */
const EXCLUDED_PATH_PREFIXES = ['.scale', 'packages/plugin/bin'];

/**
 * File names pruned wherever they appear. Only genuinely generated artifacts
 * belong here — a manifest a human maintains (package.json, tsconfig.json) stays
 * in the surface, because hiding it is the same mistake as a hardcoded root list.
 */
const EXCLUDED_FILE_NAMES = new Set(['package-lock.json']);

/**
 * Extensions counted as source. An allowlist rather than a denylist so that a
 * future binary asset (an image, a font, a `.tsbuildinfo`) cannot silently
 * appear as an "orphan source file" nobody wrote. `.jsonl` and `.html` are here
 * because papers already anchor `packages/core/fixtures/evidence.jsonl` and the
 * web entry point is real hand-written source.
 */
const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.css',
  '.html',
  '.md',
  '.json',
  '.jsonl',
]);

/**
 * Path spellings that collide with `Object.prototype` members. `.scale/` is
 * unvalidated LLM output and `buildFileComponentIndex` builds a plain object, so
 * a source entry spelled `constructor` makes `index[key]` return an inherited
 * function and crashes the build with a raw V8 stack. Filtered out before the
 * index is built and reported as a finding instead.
 */
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/** A user-facing failure: reported on stderr, exit 1, no stack trace. */
class CheckError extends Error {}

/** Abort with a non-zero exit. Errors go to stderr so `--json` stdout stays pure. */
function fail(message) {
  throw new CheckError(message);
}

let asJson = false;

/** Human-report line. Silenced under --json so stdout is parseable JSON only. */
function say(line = '') {
  if (!asJson) console.log(line);
}

function parseArgv(argv) {
  const options = { graphArg: null, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') options.json = true;
    else if (a === '--root') {
      // Consumed by rootArg() before the report runs; accepted here so the
      // strict unknown-argument guard does not reject it.
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) fail('--root needs a path');
      i++;
    } else if (a.startsWith('--root=')) {
      if (a.slice('--root='.length) === '') fail('--root needs a path');
    }
    else if (a === '--graph') {
      // Guard against `--graph --json` swallowing the next flag as a filename.
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) fail('--graph needs a path');
      options.graphArg = argv[++i];
    } else if (a.startsWith('--graph=')) {
      const value = a.slice('--graph='.length);
      // `--graph=` used to yield '' and fall through to auto-detection, silently
      // reporting on a different graph than the one explicitly requested.
      if (value === '') fail('--graph needs a path');
      options.graphArg = value;
    } else if (a === '-h' || a === '--help') options.help = true;
    else fail(`unknown argument: ${a} (try --help)`);
  }
  return options;
}

function printHelp() {
  console.log(
    [
      'Usage: node scripts/graphify-check.mjs [--root <dir>] [--graph <path>] [--json]',
      '',
      '  --root <dir>    repository to audit (default: this one). Any checkout',
      '                  with a .scale/ works — a second repo is what turns one',
      '                  precision number into a measurement.',
      '  --graph <path>  graphify graph.json to enable link precision/recall +',
      '                  cohesion. Defaults to graphify-out/graph.json if present.',
      '  --json          emit the report as JSON on stdout (nothing else).',
      '',
      'Read-only. Exits 0 whenever it produces a report, including one full of',
      'findings; exit 1 means the report could not be produced at all.',
    ].join('\n'),
  );
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** Same normalization buildFileComponentIndex applies to its keys. */
const normalizePath = (p) =>
  String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

/**
 * Repo-relative POSIX path, matching the spelling used in every paper's `sources`.
 * A path outside the repo (a `--graph` pointing elsewhere) keeps its absolute
 * form rather than becoming an unreadable pile of `../`.
 */
const relToRepo = (abs) => {
  const rel = relative(ROOT, abs).split(sep).join('/');
  return rel === '' || rel.startsWith('../') ? abs : rel;
};

/**
 * Run read-only git plumbing. Returns null on ANY failure (git absent, not a
 * repo, bad revision) so every caller degrades with a note instead of throwing.
 */
function git(args) {
  try {
    return execFileSync('git', args, {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
}

const pct = (v) => (v === null || v === undefined ? 'n/a' : `${(v * 100).toFixed(1)}%`);
const pad = (s, w) => String(s).padEnd(w);
const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Is this repo-relative path part of the audit surface? */
function inAuditSurface(rel) {
  if (EXCLUDED_PATH_PREFIXES.some((p) => rel === p || rel.startsWith(p + '/'))) return false;
  const segments = rel.split('/');
  for (let i = 0; i < segments.length - 1; i++) {
    if (EXCLUDED_DIR_NAMES.has(segments[i])) return false;
  }
  const name = segments[segments.length - 1];
  if (EXCLUDED_FILE_NAMES.has(name)) return false;
  const dot = name.lastIndexOf('.');
  const ext = dot <= 0 ? '' : name.slice(dot);
  return SOURCE_EXTENSIONS.has(ext);
}

/** Recursive walk used only by the git-less fallback surface. */
function walk(absDir, out) {
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return; // unreadable directory — nothing to attribute, nothing to report
  }
  for (const e of [...entries].sort((a, b) => byString(a.name, b.name))) {
    const abs = resolve(absDir, e.name);
    const rel = relToRepo(abs);
    if (e.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(e.name)) continue;
      if (EXCLUDED_PATH_PREFIXES.some((p) => rel === p || rel.startsWith(p + '/'))) continue;
      walk(abs, out);
    } else if ((e.isFile() || e.isSymbolicLink()) && inAuditSurface(rel)) {
      // A symlink Dirent is neither isFile() nor isDirectory(), so an unclaimed
      // source reachable only through one used to be an invisible false negative.
      // Resolve it, but never RECURSE through one: not following symlinked
      // directories is what keeps a symlink cycle from hanging the walk.
      try {
        if (fs.statSync(abs).isFile()) out.push(rel);
      } catch {
        /* broken link — nothing to attribute */
      }
    }
  }
}

/**
 * LOC = newline-delimited lines, counting a final unterminated line. Matches
 * `wc -l` for newline-terminated files, which is what everything in this repo is.
 */
function countLoc(rel) {
  try {
    const text = fs.readFileSync(resolve(ROOT, rel), 'utf8');
    if (text === '') return 0;
    const n = text.split('\n').length;
    return text.endsWith('\n') ? n - 1 : n;
  } catch {
    return 0;
  }
}

/**
 * Lenient `sources:` reader for the province and root orientation papers, which
 * the loader never parses (paper-loader.ts skips depth 1 and only keeps a root
 * paper that fully validates — this repo's does not). Deliberately not a YAML
 * parser: it reads the frontmatter block, finds the top-level `sources:` key and
 * takes its `- item` lines. Used ONLY for anchor liveness, never for attribution.
 */
function lenientSources(absReadme) {
  let text;
  try {
    text = fs.readFileSync(absReadme, 'utf8');
  } catch {
    return [];
  }
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return [];
  const out = [];
  let inSources = false;
  for (const line of m[1].split(/\r?\n/)) {
    if (/^sources:\s*$/.test(line)) {
      inSources = true;
      continue;
    }
    if (!inSources) continue;
    const item = /^\s+-\s+(.+?)\s*$/.exec(line);
    if (item) {
      out.push(item[1].replace(/^['"]|['"]$/g, ''));
      continue;
    }
    if (/^\S/.test(line)) break; // next top-level key ends the block
  }
  return out;
}

// ---------------------------------------------------------------------------
// The report itself
// ---------------------------------------------------------------------------

async function run(options) {
  const { graphArg } = options;

  // -------------------------------------------------------------------------
  // Load the coverage memory
  // -------------------------------------------------------------------------

  if (!fs.existsSync(resolve(ROOT, '.scale'))) {
    fail(`no .scale/ directory at ${ROOT} — nothing to check`);
  }

  // @scale/core ships only a compiled entry (packages/core/package.json exposes no
  // source export), so a missing or stale dist is a build problem, not a bug here.
  // Dynamic import so the resolution failure is catchable and we can say so plainly.
  let core;
  try {
    core = await import('@scale/core');
  } catch (err) {
    const e = new CheckError(`cannot import @scale/core (${err?.code ?? 'import failed'}).`);
    // Same error code covers a fresh clone with no node_modules, where building
    // alone would not create the workspace link.
    e.hint = 'Run `npm install && npm run build` to install and compile packages/core/dist, then retry.';
    throw e;
  }
  const {
    loadScaleDir,
    componentSourcesIndex,
    buildFileComponentIndex,
    componentsForFile,
  } = core;

  // loadScaleDir takes the REPO ROOT and appends '.scale' itself. It never throws
  // on a missing/malformed tree — it returns empty results — so check the result.
  const loaded = loadScaleDir(ROOT);
  if (loaded.papers.length === 0) {
    fail('.scale/ exists but contains no valid component papers');
  }

  /**
   * File → component ids, EXACT paths only.
   *
   * Rebuilt in memory rather than read from `.scale/index.json`, because that file
   * is gitignored (PLAN §4.2) and absent on a fresh clone or in CI. The rebuild is
   * byte-identical to what `scale map index` writes, so this is strictly safer.
   *
   * Every metric lookup below is a raw `index[path]`. `componentsForFile()` from
   * @scale/core is used in exactly ONE place — the advisory owner set beside each
   * orphan — because on a miss it falls back to a nearest-ancestor-directory scan
   * that maps a single unclaimed file onto 6–11 components. That fallback is right
   * for crediting an edit at runtime, right as a labelled assignment PROPOSAL, and
   * catastrophic as a metric: it would report every file in packages/ as covered
   * and would fabricate a component pair for every AST edge.
   */
  const rawSources = componentSourcesIndex(loaded);
  const reservedAnchors = [];
  const safeSources = rawSources.map(({ id, sources }) => ({
    id,
    sources: sources.filter((s) => {
      if (RESERVED_KEYS.has(normalizePath(s))) {
        reservedAnchors.push({ path: normalizePath(s), component: id });
        return false;
      }
      return true;
    }),
  }));
  reservedAnchors.sort((a, b) => byString(a.path, b.path) || byString(a.component, b.component));

  // Re-key into a null-prototype object so no lookup can ever inherit a member.
  const builtIndex = buildFileComponentIndex(safeSources);
  const fileIndex = Object.create(null);
  for (const [k, v] of Object.entries(builtIndex)) {
    if (Array.isArray(v)) fileIndex[k] = v;
  }

  /** Exact owners of a path, or [] when no paper claims it. Never guesses. */
  const ownersOf = (p) => {
    const v = fileIndex[normalizePath(p)];
    return Array.isArray(v) ? v : [];
  };

  const componentIds = loaded.papers.map((p) => p.frontmatter.id).sort();
  const sourceEntryCount = loaded.papers.reduce(
    (n, p) => n + p.frontmatter.sources.length,
    0,
  );

  // Papers the loader dropped for invalid frontmatter reach stdout only as a
  // console.warn, and every path they anchor then shows up as a phantom orphan.
  // Count README-bearing component folders directly and report the difference.
  const paperFolders = [];
  const collectPaperFolders = (absDir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    if (depth >= 2 && entries.some((e) => e.isFile() && e.name.toLowerCase() === 'readme.md')) {
      paperFolders.push(relToRepo(absDir));
    }
    for (const e of entries) {
      if (e.isDirectory()) collectPaperFolders(resolve(absDir, e.name), depth + 1);
    }
  };
  collectPaperFolders(resolve(ROOT, '.scale'), 0);
  paperFolders.sort();
  const loadedFolders = new Set(loaded.papers.map((p) => relToRepo(p.path)));
  const papersSkipped = paperFolders.filter((f) => !loadedFolders.has(f));

  // -------------------------------------------------------------------------
  // Audit surface
  // -------------------------------------------------------------------------

  // `--cached --others --exclude-standard` = tracked files plus untracked files
  // git would track. A file added but not yet committed is exactly the orphan
  // this report exists to surface, so it must be in the surface.
  const lsFiles = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  let surfaceSource;
  let scannedFiles = [];
  if (lsFiles !== null) {
    surfaceSource = 'git ls-files (tracked + untracked, minus the exclusion list)';
    const seen = new Set();
    for (const rel of lsFiles.split('\0')) {
      if (rel === '' || seen.has(rel)) continue;
      seen.add(rel);
      if (!inAuditSurface(rel)) continue;
      // ls-files lists index entries whose file was deleted on disk; those are a
      // git-state finding, not an orphan.
      try {
        if (!fs.statSync(resolve(ROOT, rel)).isFile()) continue;
      } catch {
        continue;
      }
      scannedFiles.push(rel);
    }
  } else {
    surfaceSource = 'directory walk (git unavailable — surface may be incomplete)';
    for (const r of FALLBACK_SCAN_ROOTS) {
      if (fs.existsSync(resolve(ROOT, r))) walk(resolve(ROOT, r), scannedFiles);
    }
  }
  scannedFiles.sort();
  const scannedSet = new Set(scannedFiles);

  // The exclusion list is the definition of the surface, so it has to be
  // falsifiable: any real file a component paper claims that the list would hide
  // is a bug in the list (or in the paper), and is printed rather than swallowed.
  // Filled in after metric 2, which is what decides whether the path is a file.
  const claimedButExcluded = [];

  // -------------------------------------------------------------------------
  // Metric 0 — stale anchors
  // -------------------------------------------------------------------------

  // The failure class this whole report feeds: a paper whose anchors moved under
  // it since the map was built. Both stale papers PLAN-GRAPHIFY §1.2 names by
  // hand (config-schema, memory-builder-skill) are invisible to metrics 1-3
  // because their sources still exist — but they are mechanically obvious from
  // `git diff <builtFromSha>..HEAD`.
  const head = (git(['rev-parse', '--short', 'HEAD']) ?? '').trim() || null;
  let builtFromSha = null;
  let mapJson = null;
  try {
    mapJson = JSON.parse(fs.readFileSync(resolve(ROOT, '.scale', 'map.json'), 'utf8'));
    if (typeof mapJson?.builtFromSha === 'string') builtFromSha = mapJson.builtFromSha;
  } catch {
    mapJson = null;
  }

  // map.json is LLM-written and unvalidated, and this value is about to be
  // spliced into git's argv. Anything that is not sha-shaped is refused: a value
  // like `--output=X` would be read by `git diff` as an OPTION, which both
  // breaks this script's read-only contract (git writes the file) and returns
  // success with empty output, silently reporting "nothing changed".
  const SHA_RE = /^[0-9a-f]{4,40}$/i;
  let builtFromShaRejected = null;
  if (builtFromSha !== null && !SHA_RE.test(builtFromSha)) {
    builtFromShaRejected = builtFromSha;
    builtFromSha = null;
  }

  const stale = { available: false, note: null, changedFiles: 0, changedUnclaimed: 0, components: [] };
  if (builtFromShaRejected !== null) {
    stale.note =
      `.scale/map.json builtFromSha is not sha-shaped (${JSON.stringify(builtFromShaRejected)}) — ` +
      'refusing to pass it to git; section skipped.';
  } else if (!builtFromSha) {
    stale.note = mapJson
      ? '.scale/map.json carries no builtFromSha — cannot diff.'
      : '.scale/map.json is missing or unreadable — cannot diff.';
  } else if (!head) {
    stale.note = 'git is unavailable here — cannot diff builtFromSha against HEAD.';
  } else {
    // --no-renames keeps one path per row; a rename would otherwise print
    // `old => new` and never match an index key.
    const numstat = git(['diff', '--numstat', '--no-renames', `${builtFromSha}..HEAD`]);
    if (numstat === null) {
      stale.note = `git could not diff ${builtFromSha}..HEAD (unreachable sha?) — section skipped.`;
    } else {
      stale.available = true;
      const byComponent = new Map();
      for (const line of numstat.split('\n')) {
        if (line === '') continue;
        const parts = line.split('\t');
        if (parts.length < 3) continue;
        const [addedRaw, deletedRaw, path] = parts;
        stale.changedFiles++;
        const owners = ownersOf(path);
        if (owners.length === 0) {
          if (scannedSet.has(path)) stale.changedUnclaimed++;
          continue;
        }
        // '-' is git's marker for a binary file.
        const added = addedRaw === '-' ? 0 : Number(addedRaw) || 0;
        const deleted = deletedRaw === '-' ? 0 : Number(deletedRaw) || 0;
        for (const c of owners) {
          if (!byComponent.has(c)) byComponent.set(c, []);
          byComponent.get(c).push({ path, added, deleted });
        }
      }
      stale.components = [...byComponent.entries()]
        .map(([component, anchors]) => ({
          component,
          anchors: anchors.sort((a, b) => byString(a.path, b.path)),
          changedAnchors: anchors.length,
          changedLines: anchors.reduce((n, a) => n + a.added + a.deleted, 0),
        }))
        // The worklist ordering: most churn first, then most anchors moved.
        // Churn leads because anchor COUNT is not a staleness signal — a file
        // claimed by six components (index.ts here) hands all six an anchor
        // apiece, so counting anchors ranks by how widely a file is shared
        // rather than by how much the paper's subject actually moved.
        .sort(
          (a, b) =>
            b.changedLines - a.changedLines ||
            b.changedAnchors - a.changedAnchors ||
            byString(a.component, b.component),
        );
    }
  }

  // -------------------------------------------------------------------------
  // Metric 1 — orphan files (+ ADVISORY owner proposal)
  // -------------------------------------------------------------------------

  // An orphan is a file in the audit surface that appears in NO component's
  // `sources`. It is the direct cause of the miscredit described in
  // PLAN-GRAPHIFY §1.2: an edit to an unclaimed file falls through to the
  // nearest-directory fallback and lands credit on every component that shares a
  // leading path segment.
  // Not every orphan is the same kind of problem, and lumping them together
  // buries the ones that matter. Only `code` orphans cause the miscredit above,
  // because only they are edited during a coding session — so `code` is the tier
  // PLAN-GRAPHIFY P0.5's "orphan 0" acceptance criterion is about. The rest are
  // reported so the surface stays honest and auditable, not as a worklist.
  function orphanTier(rel) {
    if (rel.startsWith('packages/core/fixtures/')) return 'fixture';
    if (rel.endsWith('.md')) return 'docs';
    const base = rel.slice(rel.lastIndexOf('/') + 1);
    if (base === 'package.json' || base.startsWith('tsconfig') || base.endsWith('.config.ts')) {
      return 'config';
    }
    if (base.endsWith('.json') || base.endsWith('.jsonl') || base.endsWith('.css') || base.endsWith('.html')) {
      return 'config';
    }
    return 'code';
  }

  const orphanFiles = scannedFiles
    .filter((rel) => ownersOf(rel).length === 0)
    .map((rel) => ({
      path: rel,
      tier: orphanTier(rel),
      loc: countLoc(rel),
      // ADVISORY ONLY. This is the very fallback the metrics refuse to use: the
      // components that claim a sibling under the nearest anchored directory. It
      // is both the natural assignment proposal for a /scale-map sync AND the
      // exact miscredit surface this orphan causes today. It never feeds a metric.
      advisoryOwners: [...componentsForFile(fileIndex, rel)].sort(),
    }));
  const orphanLoc = orphanFiles.reduce((n, f) => n + f.loc, 0);

  // Grouped by directory so a whole directory of orphans reads as one decision.
  // componentsForFile keys off the directory, so the advisory set is uniform
  // within a group unless the fallback itself changes shape — checked, not assumed.
  const orphanDirs = [];
  for (const f of orphanFiles) {
    const i = f.path.lastIndexOf('/');
    const dir = i === -1 ? '.' : f.path.slice(0, i);
    let group = orphanDirs.find((g) => g.directory === dir);
    if (!group) {
      group = { directory: dir, files: [], advisoryOwners: f.advisoryOwners, uniform: true };
      orphanDirs.push(group);
    }
    if (group.advisoryOwners.join(',') !== f.advisoryOwners.join(',')) group.uniform = false;
    group.files.push(f);
  }
  orphanDirs.sort((a, b) => byString(a.directory, b.directory));

  // -------------------------------------------------------------------------
  // Metric 2 — bad anchors (dead / non-file / case-mismatched)
  // -------------------------------------------------------------------------

  // Every path any paper anchors, across all three tiers. The ORPHAN definition
  // stays component-only on purpose (that is what `scale map index` builds, so
  // that is what miscredits an edit), but a province or root paper teaching a
  // deleted file is the same staleness defect and used to be invisible.
  const anchorClaims = [];
  for (const paper of loaded.papers) {
    for (const src of paper.frontmatter.sources) {
      anchorClaims.push({ path: normalizePath(src), owner: paper.frontmatter.id, tier: 'component' });
    }
  }
  const scaleDir = resolve(ROOT, '.scale');
  for (const src of lenientSources(resolve(scaleDir, 'README.md'))) {
    anchorClaims.push({ path: normalizePath(src), owner: '.scale/README.md', tier: 'root' });
  }
  let provinceDirs = [];
  try {
    provinceDirs = fs
      .readdirSync(scaleDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    provinceDirs = [];
  }
  for (const slug of provinceDirs) {
    for (const src of lenientSources(resolve(scaleDir, slug, 'README.md'))) {
      anchorClaims.push({ path: normalizePath(src), owner: slug, tier: 'province' });
    }
  }

  // Case-exact existence: `fs.existsSync` is case-INSENSITIVE on the default
  // macOS filesystem, so a casing typo in a paper passes the liveness check on a
  // laptop and fails it in Linux CI — two different fidelity reports for one
  // commit. Verify every segment against its parent's real directory listing.
  const dirListings = new Map();
  const listDir = (absDir) => {
    if (!dirListings.has(absDir)) {
      let names = null;
      try {
        names = new Set(fs.readdirSync(absDir));
      } catch {
        names = null;
      }
      dirListings.set(absDir, names);
    }
    return dirListings.get(absDir);
  };
  const existsCaseExact = (rel) => {
    let cur = ROOT;
    for (const seg of rel.split('/')) {
      const names = listDir(cur);
      if (!names || !names.has(seg)) return false;
      cur = resolve(cur, seg);
    }
    return true;
  };
  const classifyAnchor = (rel) => {
    let st;
    try {
      st = fs.statSync(resolve(ROOT, rel));
    } catch {
      return 'missing';
    }
    // `sources` is documented as file-granularity (schema/paper.ts). A directory
    // passes existsSync, matches no file in the index, and silently orphans its
    // whole subtree with no explanation.
    if (!st.isFile()) return 'not-file';
    if (!existsCaseExact(rel)) return 'case-mismatch';
    return 'ok';
  };

  const deadSources = [];
  const nonFileAnchors = [];
  const caseMismatchedAnchors = [];
  const tierCounts = { component: 0, province: 0, root: 0 };
  for (const claim of anchorClaims) {
    tierCounts[claim.tier]++;
    const verdict = classifyAnchor(claim.path);
    const row = { path: claim.path, component: claim.owner, tier: claim.tier };
    if (verdict === 'missing') deadSources.push(row);
    else if (verdict === 'not-file') nonFileAnchors.push(row);
    else if (verdict === 'case-mismatch') caseMismatchedAnchors.push(row);
  }
  const sortRows = (rows) =>
    rows.sort((a, b) => byString(a.path, b.path) || byString(a.component, b.component));
  sortRows(deadSources);
  sortRows(nonFileAnchors);
  sortRows(caseMismatchedAnchors);

  // Now that anchors are classified: a claimed path the exclusion list hides is
  // only a surface bug if it is a real file (a missing or non-file anchor is
  // already reported above, and would double-report here).
  for (const p of Object.keys(fileIndex).sort()) {
    if (inAuditSurface(p)) continue;
    if (classifyAnchor(p) !== 'ok') continue;
    claimedButExcluded.push({ path: p, components: [...fileIndex[p]].sort() });
  }

  // -------------------------------------------------------------------------
  // Metric 3 — double-claimed files
  // -------------------------------------------------------------------------

  // Files more than one component anchors. This is NOT automatically a defect —
  // a large multi-command surface can genuinely host several components — but
  // every double claim splits an edit's credit and blurs a boundary, so the set
  // is worth seeing. Reported, not judged.
  const doubleClaimed = Object.keys(fileIndex)
    .filter((p) => fileIndex[p].length > 1)
    .sort()
    .map((p) => ({ path: p, components: [...fileIndex[p]].sort() }));

  // -------------------------------------------------------------------------
  // Graph mode — metrics 4-6
  // -------------------------------------------------------------------------

  /** Locate the graph: explicit --graph wins, else the canonical graphify output path. */
  const locateGraph = () => {
    if (graphArg) {
      const abs = isAbsolute(graphArg) ? graphArg : resolve(process.cwd(), graphArg);
      if (!fs.existsSync(abs)) fail(`--graph path does not exist: ${graphArg}`);
      return abs;
    }
    const auto = resolve(ROOT, 'graphify-out', 'graph.json');
    return fs.existsSync(auto) ? auto : null;
  };

  const graphPath = locateGraph();
  let graph = null;

  if (graphPath) {
    let raw;
    try {
      raw = fs.readFileSync(graphPath, 'utf8');
    } catch (err) {
      fail(`cannot read graph.json at ${relToRepo(graphPath)}: ${err.message}`);
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      fail(`graph.json at ${relToRepo(graphPath)} is not valid JSON: ${err.message}`);
    }
    // graphify writes networkx node_link_data, whose edge array is "links", NOT
    // "edges". Reading `.edges` yields undefined and a silently empty graph, so
    // accept either spelling and fail loudly if neither is an array.
    const rawNodes = data?.nodes;
    const rawLinks = data?.links ?? data?.edges;
    if (!Array.isArray(rawNodes) || !Array.isArray(rawLinks)) {
      fail(
        `graph.json at ${relToRepo(graphPath)} has no nodes/links arrays — ` +
          'is it a graphify export?',
      );
    }

    // Fingerprint the exact bytes the numbers came from. Without it two runs
    // against different extractions produce indistinguishable reports, and
    // PLAN-GRAPHIFY §3 wants the snapshot pinned for reproducibility.
    const graphSha = createHash('sha256').update(raw).digest('hex').slice(0, 12);
    const graphMeta = data?.metadata ?? data?.graph ?? null;

    // --- node → component attribution (exact match only, as above) -------------
    const nodeOwners = new Map(); // node id -> owning component ids
    const nodeFiles = new Map(); // component -> Set of files it owns that carry a node
    let nodesNoSourceFile = 0; // LLM-tier + external stubs: source_file "" or absent
    const unattributedFiles = new Set(); // real paths no component claims
    let nodesUnattributed = 0;
    let nodesOutsideRepo = 0;
    let nodesWithSourceFile = 0;
    for (const n of rawNodes) {
      if (!n || n.id === undefined || n.id === null) continue;
      // source_file is the ONLY reliable path: node ids are lossy casefolded slugs
      // and must never be reversed into a path. It can be "" (external type stubs)
      // or absent entirely (semantic-tier nodes), hence the truthiness check.
      const sf = n.source_file;
      if (!sf) {
        nodesNoSourceFile++;
        continue;
      }
      nodesWithSourceFile++;
      // graphify's source_file spelling depends on the cwd it was invoked from and
      // nothing pins it. An absolute path matches no repo-relative index key, so
      // without this the whole graph silently evaporates into "unattributed".
      const key = isAbsolute(String(sf)) ? relToRepo(resolve(String(sf))) : normalizePath(sf);
      if (isAbsolute(key)) {
        nodesOutsideRepo++;
        nodesUnattributed++;
        unattributedFiles.add(key);
        continue;
      }
      const owners = ownersOf(key);
      if (owners.length === 0) {
        nodesUnattributed++;
        unattributedFiles.add(key);
        continue;
      }
      nodeOwners.set(n.id, owners);
      for (const c of owners) {
        if (!nodeFiles.has(c)) nodeFiles.set(c, new Set());
        nodeFiles.get(c).add(key);
      }
    }

    // --- edge classification ---------------------------------------------------
    //
    // A file may be claimed by several components, so an edge's endpoints carry
    // SETS of owners, and one edge can be intra for one component while crossing
    // a boundary for others. Both facts are recorded, independently:
    //
    //   shared = owners(u) ∩ owners(v)  -> INTRA for each shared component.
    //     Some component contains both endpoints, so for THAT component the edge
    //     crosses nothing.
    //   onlyU = owners(u) \ owners(v), onlyV = owners(v) \ owners(u)
    //     -> CROSS for every pair in onlyU × onlyV.
    //
    // Treating a non-empty intersection as "pure intra" (the old rule) erased
    // every real crossing on either side of a shared file: an edge from a file
    // owned by {a,b} to one owned by {b,c} would corroborate nothing, though it
    // is exactly the evidence for a<->c. Because both differences are empty when
    // the two endpoints have identical owner sets, a file-internal edge inside a
    // six-component file still produces ZERO spurious crossings.
    //
    // Consequence: `intra` and `cross` are NON-EXCLUSIVE classifications — an edge
    // with partially overlapping owners is both. The report says so.
    const intra = new Map(); // component -> intra-component edge count
    const cross = new Map(); // component -> boundary-crossing edge count
    const crossPairs = new Set(); // "a|b" (sorted) for every AST-connected pair
    const crossPairsExtracted = new Set(); // same, EXTRACTED-confidence edges only
    const byRelation = new Map();
    const byConfidence = new Map();
    let linksTotal = 0;
    let linksSkipped = 0; // an endpoint was unattributed or dangling
    let linksSelfLoop = 0;
    let linksAttributed = 0;
    let intraEdges = 0;
    let crossEdges = 0;
    let multiOwnerCrossEdges = 0;
    const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
    const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

    for (const link of rawLinks) {
      if (!link) continue;
      linksTotal++;
      // PLAN-GRAPHIFY §2 records both fields; an export that omits them buckets as
      // 'unknown' rather than dropping the edge.
      bump(byRelation, typeof link.relation === 'string' ? link.relation : 'unknown');
      bump(byConfidence, typeof link.confidence === 'string' ? link.confidence : 'unknown');
      // A self-loop crosses no boundary and evidences no cohesion; the reference
      // edge loop already drops them, so the AST loop must too.
      if (link.source === link.target) {
        linksSelfLoop++;
        continue;
      }
      const A = nodeOwners.get(link.source);
      const B = nodeOwners.get(link.target);
      if (!A || !B) {
        linksSkipped++;
        continue;
      }
      linksAttributed++;
      const shared = A.filter((c) => B.includes(c));
      if (shared.length > 0) {
        intraEdges++;
        for (const c of shared) bump(intra, c);
      }
      const onlyA = A.filter((c) => !B.includes(c));
      const onlyB = B.filter((c) => !A.includes(c));
      if (onlyA.length > 0 && onlyB.length > 0) {
        crossEdges++;
        if (A.length > 1 || B.length > 1) multiOwnerCrossEdges++;
        for (const a of onlyA) bump(cross, a);
        for (const b of onlyB) bump(cross, b);
        for (const a of onlyA) {
          for (const b of onlyB) {
            crossPairs.add(pairKey(a, b));
            if (link.confidence === 'EXTRACTED') crossPairsExtracted.add(pairKey(a, b));
          }
        }
      }
    }

    // Attribution collapsing wholesale is a configuration error (wrong cwd, wrong
    // path format, wrong repo), not a finding about the map. Say so loudly and
    // refuse to score, rather than reporting "0% of the map's links have code
    // behind them".
    const attributionCollapsed =
      (nodesWithSourceFile > 0 && nodeOwners.size === 0) ||
      (linksTotal > 0 && linksSkipped > 0 && linksSkipped === linksTotal - linksSelfLoop);
    const unattributedSample = [...unattributedFiles].sort().slice(0, 5);

    // --- the map's own Related Work links --------------------------------------
    //
    // map.json is the committed artifact the report is about, so it is the primary
    // source. Its builtFromSha can lag HEAD; when the file is absent we fall back
    // to the edges loadScaleDir derives live from each paper's Related Work links,
    // and say which was used.
    let referenceEdgeSource = 'map.json';
    let mapEdges = Array.isArray(mapJson?.edges) ? mapJson.edges : null;
    if (!mapEdges) {
      referenceEdgeSource = 'papers (Related Work links; .scale/map.json unreadable)';
      mapEdges = loaded.edges;
    }
    // Unordered: a Related Work link in either direction is the same claim.
    const referencePairs = new Set();
    for (const e of mapEdges) {
      if (e?.kind !== 'reference') continue;
      if (!e.from || !e.to || e.from === e.to) continue;
      referencePairs.add(pairKey(e.from, e.to));
    }

    const componentsWithNodes = new Set();
    for (const owners of nodeOwners.values()) for (const c of owners) componentsWithNodes.add(c);

    // Metric 4 — link recall: of the component pairs the AST says are connected,
    // how many did the map remember to link? Low recall = missing Related Work.
    let recallHits = 0;
    for (const k of crossPairs) if (referencePairs.has(k)) recallHits++;
    // Metric 5 — link precision: of the pairs the map links, how many does the AST
    // corroborate? Low precision = Related Work asserting conceptual kinship with
    // no code path behind it (PLAN-GRAPHIFY §1.2 flags 24.3% edge density as suspect).
    let precisionHits = 0;
    for (const k of referencePairs) if (crossPairs.has(k)) precisionHits++;

    // Some reference pairs cannot be corroborated by ANY code-only extraction, so
    // they cap precision before a single edge is read. A pair (a,b) is corroborable
    // only if some edge can put a on one side and b on the other — that needs a
    // node-bearing file a owns and b does not, AND one b owns and a does not:
    //   - a component with no attributed node at all (three here anchor only .md
    //     files) can never be on either side;
    //   - a component whose node-bearing files are a SUBSET of the other's (the
    //     common case for a component sharing its only anchor with a bigger one)
    //     always lands in the intersection, never in a difference.
    // Reported alongside the literal figure, never instead of it.
    const corroborable = (k) => {
      const [a, b] = k.split('|');
      const A = nodeFiles.get(a);
      const B = nodeFiles.get(b);
      if (!A || !B) return false;
      return [...A].some((f) => !B.has(f)) && [...B].some((f) => !A.has(f));
    };
    const scorablePairs = [...referencePairs].filter(corroborable);
    let scorableHits = 0;
    for (const k of scorablePairs) if (crossPairs.has(k)) scorableHits++;
    const excludedNoNodes = [...referencePairs].filter(
      (k) => !k.split('|').every((c) => nodeFiles.has(c)),
    ).length;
    const excludedNested = referencePairs.size - scorablePairs.length - excludedNoNodes;
    const unscorableComponents = [
      ...new Set(
        [...referencePairs]
          .flatMap((k) => k.split('|'))
          .filter((c) => !componentsWithNodes.has(c)),
      ),
    ].sort();

    // Same two metrics restricted to edges graphify saw literally in the source.
    let extractedRecallHits = 0;
    for (const k of crossPairsExtracted) if (referencePairs.has(k)) extractedRecallHits++;
    let extractedPrecisionHits = 0;
    for (const k of referencePairs) if (crossPairsExtracted.has(k)) extractedPrecisionHits++;
    const hasExtracted = (byConfidence.get('EXTRACTED') ?? 0) > 0;

    // Metric 6 — cohesion: per component, intra / (intra + cross) incidences. A
    // component whose edges mostly leave it is a boundary drawn through a tight
    // cluster. Components with no attributed edges have no opinion and are excluded.
    const cohesion = componentIds
      .map((id) => {
        const i = intra.get(id) ?? 0;
        const x = cross.get(id) ?? 0;
        return {
          component: id,
          intra: i,
          cross: x,
          total: i + x,
          cohesion: i + x === 0 ? null : i / (i + x),
        };
      })
      .filter((c) => c.total > 0);
    // Deterministic ordering: weakest first, then heaviest (a low score backed by
    // more edges is the more actionable finding), then id.
    const weakest = [...cohesion]
      .sort(
        (a, b) =>
          a.cohesion - b.cohesion || b.total - a.total || byString(a.component, b.component),
      )
      .slice(0, 5);

    const scorable = !attributionCollapsed;
    graph = {
      path: relToRepo(graphPath),
      sha256: graphSha,
      meta: graphMeta,
      nodes: {
        total: rawNodes.length,
        attributed: nodeOwners.size,
        noSourceFile: nodesNoSourceFile,
        unattributed: nodesUnattributed,
        unattributedFiles: unattributedFiles.size,
        outsideRepo: nodesOutsideRepo,
        unattributedSample,
      },
      links: {
        total: linksTotal,
        skipped: linksSkipped,
        selfLoops: linksSelfLoop,
        attributed: linksAttributed,
        intra: intraEdges,
        cross: crossEdges,
        crossViaMultiOwnerFile: multiOwnerCrossEdges,
        byRelation: Object.fromEntries([...byRelation].sort((a, b) => byString(a[0], b[0]))),
        byConfidence: Object.fromEntries([...byConfidence].sort((a, b) => byString(a[0], b[0]))),
      },
      attributionCollapsed,
      componentsWithNodes: componentsWithNodes.size,
      componentsTotal: componentIds.length,
      referenceEdgeSource,
      linkRecall: {
        astPairs: crossPairs.size,
        matched: recallHits,
        value: !scorable || crossPairs.size === 0 ? null : recallHits / crossPairs.size,
      },
      linkPrecision: {
        referencePairs: referencePairs.size,
        matched: precisionHits,
        // Precision is undefined when there is nothing to corroborate WITH. The
        // old guard only covered an empty reference set, so an unusable graph
        // printed a confident 0.0%.
        value:
          !scorable || referencePairs.size === 0 || crossPairs.size === 0
            ? null
            : precisionHits / referencePairs.size,
        scorablePairs: scorablePairs.length,
        scorableMatched: scorableHits,
        scorableValue:
          !scorable || scorablePairs.length === 0 || crossPairs.size === 0
            ? null
            : scorableHits / scorablePairs.length,
        excludedPairs: referencePairs.size - scorablePairs.length,
        excludedNoNodes,
        excludedNested,
        excludedComponents: unscorableComponents,
      },
      extracted: hasExtracted
        ? {
            astPairs: crossPairsExtracted.size,
            recall:
              !scorable || crossPairsExtracted.size === 0
                ? null
                : extractedRecallHits / crossPairsExtracted.size,
            precision:
              !scorable || referencePairs.size === 0 || crossPairsExtracted.size === 0
                ? null
                : extractedPrecisionHits / referencePairs.size,
          }
        : null,
      cohesion: {
        // Edge-level: intra classifications / all classifications. Since the two
        // are non-exclusive, an edge with partially shared owners contributes to
        // both. NOT a weighted mean of the per-component rows below either, which
        // are incidences (a cross edge counts for every component on either side).
        overall:
          !scorable || intraEdges + crossEdges === 0
            ? null
            : intraEdges / (intraEdges + crossEdges),
        scored: cohesion.length,
        weakest,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Report
  // -------------------------------------------------------------------------

  const report = {
    mode: graph ? 'graph' : 'anchor',
    surface: { source: surfaceSource, files: scannedFiles.length },
    head,
    builtFromSha,
    components: componentIds.length,
    papersSkipped,
    sources: {
      entries: sourceEntryCount,
      unique: Object.keys(fileIndex).length,
      byTier: tierCounts,
    },
    scannedFiles: scannedFiles.length,
    staleAnchors: stale,
    orphanFiles: {
      count: orphanFiles.length,
      loc: orphanLoc,
      files: orphanFiles,
      directories: orphanDirs.map((g) => ({
        directory: g.directory,
        files: g.files.map((f) => f.path),
        advisoryOwners: g.uniform ? g.advisoryOwners : null,
      })),
    },
    deadSources: { count: deadSources.length, entries: deadSources },
    nonFileAnchors: { count: nonFileAnchors.length, entries: nonFileAnchors },
    caseMismatchedAnchors: { count: caseMismatchedAnchors.length, entries: caseMismatchedAnchors },
    reservedAnchors: { count: reservedAnchors.length, entries: reservedAnchors },
    claimedButExcluded: { count: claimedButExcluded.length, files: claimedButExcluded },
    doubleClaimed: { count: doubleClaimed.length, files: doubleClaimed },
    graph,
  };

  if (asJson) {
    // NO process.exit here: stdout to a pipe is async, and exiting before it
    // drains truncates the JSON at one pipe buffer (64 KB) with a 0 exit code.
    // Falling off the end of the script flushes it.
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  say('graphify-check — map fidelity report');
  say('');
  say(`ANCHOR METRICS — .scale/ vs the filesystem (no graphify needed)`);
  say(`  components            ${componentIds.length}`);
  say(
    `  claimed sources       ${report.sources.unique} unique paths ` +
      `(${sourceEntryCount} component entries; +${tierCounts.province} province, ` +
      `+${tierCounts.root} root, liveness-checked only)`,
  );
  say(`  scanned files         ${scannedFiles.length} — ${surfaceSource}`);
  say(
    `  map built from        ${builtFromSha ?? 'unknown'}` +
      `   HEAD ${head ?? 'unknown'}` +
      (builtFromSha && head
        ? builtFromSha === head || head.startsWith(builtFromSha) || builtFromSha.startsWith(head)
          ? '   (in sync)'
          : '   (map lags HEAD)'
        : ''),
  );
  if (papersSkipped.length > 0) {
    say('');
    say(`  PAPERS SKIPPED — ${papersSkipped.length} README folder(s) the loader rejected`);
    for (const f of papersSkipped) say(`     ${f}`);
    say('     Their anchors show up below as orphans and their links vanish from');
    say('     recall/precision. Fix the frontmatter before trusting the numbers.');
  }
  if (claimedButExcluded.length > 0) {
    say('');
    say(`  SURFACE GAP — ${claimedButExcluded.length} claimed path(s) the exclusion list hides`);
    for (const f of claimedButExcluded) say(`     ${f.path}  (${f.components.join(', ')})`);
  }
  if (reservedAnchors.length > 0) {
    say('');
    say(`  RESERVED ANCHORS — ${reservedAnchors.length} source(s) named after a JS prototype key`);
    for (const r of reservedAnchors) say(`     ${r.path}  ${r.component}`);
  }
  say('');

  say(`  0. STALE ANCHORS — anchors changed since the map was built`);
  if (!stale.available) {
    say(`     skipped: ${stale.note}`);
  } else if (stale.components.length === 0) {
    say(`     none (${stale.changedFiles} files changed since ${builtFromSha}, none anchored)`);
  } else {
    const w = Math.max(...stale.components.map((c) => c.component.length));
    for (const c of stale.components) {
      say(
        `     ${pad(c.component, w)}  ${String(c.changedAnchors).padStart(2)} anchor(s), ` +
          `${c.changedLines} lines changed`,
      );
      for (const a of c.anchors) say(`       ${a.path}  +${a.added}/-${a.deleted}`);
    }
    say(
      `     total: ${stale.components.length} components over ${stale.changedFiles} changed files ` +
        `(${stale.changedUnclaimed} changed files are unclaimed)`,
    );
    say('     Ordered as a sync worklist: most anchors moved first.');
  }
  say('');

  say(`  1. ORPHAN FILES — in the audit surface, claimed by no component`);
  if (orphanFiles.length === 0) {
    say('     none');
  } else {
    // The code tier first and in full: those are the files an edit actually
    // miscredits, and they are the P0.5 worklist. Everything else is summarized
    // so it cannot bury them.
    const codeOrphans = orphanFiles.filter((f) => f.tier === 'code');
    const otherOrphans = orphanFiles.filter((f) => f.tier !== 'code');
    const codeLoc = codeOrphans.reduce((n, f) => n + f.loc, 0);

    say(`     CODE tier — ${codeOrphans.length} files, ${codeLoc} LOC  (the P0.5 worklist)`);
    if (codeOrphans.length === 0) {
      say('       none');
    } else {
      const w = Math.max(...codeOrphans.map((f) => f.path.length));
      // Largest first: LOC is the size of the miscredit this orphan causes.
      for (const f of [...codeOrphans].sort((a, b) => b.loc - a.loc || byString(a.path, b.path))) {
        say(`       ${pad(f.path, w)}  ${String(f.loc).padStart(5)} LOC`);
        say(`         ADVISORY nearest-dir owners: ` +
          (f.advisoryOwners.length === 0
            ? '(none)'
            : `${f.advisoryOwners.join(', ')} (${f.advisoryOwners.length})`));
      }
    }

    const byTier = new Map();
    for (const f of otherOrphans) {
      const t = byTier.get(f.tier) ?? { files: 0, loc: 0 };
      t.files += 1;
      t.loc += f.loc;
      byTier.set(f.tier, t);
    }
    if (byTier.size > 0) {
      say('');
      say('     OTHER tiers — reported for surface honesty, not as a worklist:');
      for (const tier of [...byTier.keys()].sort()) {
        const t = byTier.get(tier);
        say(`       ${pad(tier, 8)} ${String(t.files).padStart(3)} files, ${String(t.loc).padStart(5)} LOC`);
      }
      say('     A paper CAN legitimately anchor a manifest, doc or fixture; these are');
      say('     unclaimed, not wrong. Decide the policy before treating them as work.');
    }
    say('');
    say('     Full per-directory listing:');
    for (const g of orphanDirs) {
      // The repo root groups under '.', where the path IS the basename.
      const baseOf = (f) => (g.directory === '.' ? f.path : f.path.slice(g.directory.length + 1));
      say(`     ${g.directory === '.' ? '<repo root>' : g.directory + '/'}`);
      const w = Math.max(...g.files.map((f) => baseOf(f).length));
      for (const f of g.files) {
        say(`       ${pad(baseOf(f), w)}  ${String(f.loc).padStart(5)} LOC`);
      }
      if (g.uniform) {
        say(
          `       ADVISORY nearest-dir owners: ` +
            (g.advisoryOwners.length === 0
              ? '(none — no anchored sibling directory)'
              : `${g.advisoryOwners.join(', ')} (${g.advisoryOwners.length})`),
        );
      } else {
        for (const f of g.files) {
          say(`       ADVISORY ${f.path}: ${f.advisoryOwners.join(', ') || '(none)'}`);
        }
      }
    }
    say(`     total: ${orphanFiles.length} files, ${orphanLoc} LOC`);
    say('     ADVISORY lines are the nearest-directory fallback: they are the');
    say('     assignment candidates AND the components this orphan miscredits');
    say('     today. They feed no metric on this page.');
  }
  say('');

  say(`  2. BAD ANCHORS — a paper claims a path that does not resolve to a file`);
  const anchorRows = (title, rows) => {
    if (rows.length === 0) return;
    say(`     ${title}`);
    const w = Math.max(...rows.map((d) => d.path.length));
    for (const d of rows) say(`       ${pad(d.path, w)}  ${d.component} [${d.tier}]`);
  };
  if (deadSources.length + nonFileAnchors.length + caseMismatchedAnchors.length === 0) {
    say('     none');
  } else {
    anchorRows('2a. absent from disk:', deadSources);
    anchorRows('2b. exists but is not a file (contract is file-granularity):', nonFileAnchors);
    anchorRows('2c. wrong case (resolves on macOS, missing on Linux):', caseMismatchedAnchors);
    say(
      `     total: ${deadSources.length} dead, ${nonFileAnchors.length} non-file, ` +
        `${caseMismatchedAnchors.length} case-mismatched`,
    );
  }
  say('');

  say(`  3. DOUBLE-CLAIMED — one file, several components (may be intentional)`);
  if (doubleClaimed.length === 0) {
    say('     none');
  } else {
    for (const d of doubleClaimed) {
      say(`     ${d.path}`);
      say(`       (${d.components.length}) ${d.components.join(', ')}`);
    }
    say(`     total: ${doubleClaimed.length} files`);
  }
  say('');

  if (!graph) {
    say('GRAPH METRICS — SKIPPED');
    say('  No graph.json found (looked for graphify-out/graph.json).');
    say('  Skipped: 4. link recall, 5. link precision, 6. cohesion.');
    say('  All three are defined over cross-boundary AST edges, which only a');
    say('  graphify extraction provides. Produce one and re-run with --graph:');
    say('    graphify extract . --code-only && graphify cluster-only . --no-label');
    say('    node scripts/graphify-check.mjs --graph graphify-out/graph.json');
  } else {
    say(`GRAPH METRICS — ${graph.path}  sha256:${graph.sha256}`);
    if (graph.meta !== null && graph.meta !== undefined) {
      say(`  graph metadata        ${JSON.stringify(graph.meta).slice(0, 200)}`);
    }
    say(
      `  nodes                 ${graph.nodes.total} total, ${graph.nodes.attributed} attributed`,
    );
    say(
      `                        skipped: ${graph.nodes.noSourceFile} without source_file, ` +
        `${graph.nodes.unattributed} unattributed (${graph.nodes.unattributedFiles} distinct files` +
        (graph.nodes.outsideRepo > 0 ? `, ${graph.nodes.outsideRepo} outside the repo` : '') +
        ')',
    );
    say(
      `  edges                 ${graph.links.total} total, ${graph.links.skipped} skipped ` +
        `(endpoint unattributed), ${graph.links.selfLoops} self-loops dropped`,
    );
    say(
      `                        ${graph.links.attributed} attributed → ${graph.links.intra} intra, ` +
        `${graph.links.cross} cross (non-exclusive: a partially shared edge is both; ` +
        `${graph.links.crossViaMultiOwnerFile} cross via a multi-owner file)`,
    );
    const buckets = (m) =>
      Object.entries(m)
        .map(([k, v]) => `${k} ${v}`)
        .join(', ');
    say(`  by relation           ${buckets(graph.links.byRelation) || 'none'}`);
    say(`  by confidence         ${buckets(graph.links.byConfidence) || 'none'}`);
    say(
      `  components with nodes ${graph.componentsWithNodes} of ${graph.componentsTotal}` +
        (graph.componentsWithNodes < graph.componentsTotal
          ? ' — the rest cannot earn AST edges, which caps precision'
          : ''),
    );
    say(`  reference edges from  ${graph.referenceEdgeSource}`);
    say('');
    if (graph.attributionCollapsed) {
      say('  !! ATTRIBUTION COLLAPSED — metrics 4-6 are NOT scored.');
      say('     No graph node (or no edge) matched any path a paper claims. That is a');
      say('     configuration error — a graph extracted from another cwd, another repo,');
      say('     or with absolute paths outside this root — not a finding about the map.');
      if (graph.nodes.unattributedSample.length > 0) {
        say('     unattributed sample:');
        for (const p of graph.nodes.unattributedSample) say(`       ${p}`);
      }
      say('');
    }
    say(
      `  4. LINK RECALL        ${pct(graph.linkRecall.value)}  ` +
        `(${graph.linkRecall.matched} of ${graph.linkRecall.astPairs} AST-connected pairs are linked in the map)`,
    );
    say(
      `  5. LINK PRECISION     ${pct(graph.linkPrecision.value)}  ` +
        `(${graph.linkPrecision.matched} of ${graph.linkPrecision.referencePairs} mapped pairs have a cross-boundary AST edge)`,
    );
    if (graph.linkPrecision.excludedPairs > 0) {
      const ex = graph.linkPrecision.excludedComponents;
      const shown = ex.slice(0, 6).join(', ') + (ex.length > 6 ? `, +${ex.length - 6} more` : '');
      say(
        `                        ${pct(graph.linkPrecision.scorableValue)} over the ` +
          `${graph.linkPrecision.scorablePairs} pairs a code-only extraction could ` +
          `corroborate at all`,
      );
      say(
        `                        (${graph.linkPrecision.excludedPairs} excluded: ` +
          `${graph.linkPrecision.excludedNoNodes} with a component owning no AST node` +
          (ex.length > 0 ? ` — ${shown}` : '') +
          `; ${graph.linkPrecision.excludedNested} whose anchor sets nest)`,
      );
    }
    if (graph.extracted) {
      say(
        `                        EXTRACTED-only: recall ${pct(graph.extracted.recall)}, ` +
          `precision ${pct(graph.extracted.precision)} over ${graph.extracted.astPairs} pairs`,
      );
    }
    say('');
    say(
      `  6. COHESION           ${pct(graph.cohesion.overall)} overall ` +
        `(intra / all edge classifications; a partially shared edge is in both)`,
    );
    say('     PLAN-GRAPHIFY P0.3 words this as an internal/external density ratio;');
    say('     it is reported as an internal share so it stays bounded and comparable.');
    if (graph.cohesion.weakest.length === 0) {
      say('     no component has attributed edges');
    } else {
      say(
        `     weakest ${graph.cohesion.weakest.length} of ${graph.cohesion.scored} scored ` +
          `(per-component edge INCIDENCES: a cross edge counts for both sides):`,
      );
      const w = Math.max(...graph.cohesion.weakest.map((c) => c.component.length));
      for (const c of graph.cohesion.weakest) {
        say(
          `       ${pad(c.component, w)}  ${pct(c.cohesion).padStart(6)}  ` +
            `(${c.intra} intra / ${c.cross} cross)`,
        );
      }
    }
  }
  say('');
  say('graphify-check — read-only; nothing was written.');
}

// ---------------------------------------------------------------------------
// Entry point. No process.exit() anywhere: stdout to a PIPE is asynchronous in
// Node, so exiting explicitly truncates a large --json report at one pipe buffer
// (64 KB) while still reporting success. Setting process.exitCode and returning
// lets the runtime drain stdout first.
// ---------------------------------------------------------------------------

try {
  const options = parseArgv(process.argv.slice(2));
  asJson = options.json;
  if (options.help) printHelp();
  else await run(options);
} catch (err) {
  if (err instanceof CheckError) {
    console.error(`graphify-check — error: ${err.message}`);
    // A hint is its own line: hand-aligning it under the prefix rots the moment
    // the prefix changes.
    if (err.hint) console.error(err.hint);
    process.exitCode = 1;
  } else {
    throw err;
  }
}
