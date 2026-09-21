/**
 * `scale serve` — a repo-agnostic local web server (pure Node, no express, no
 * LLM). Reads the coverage memory from `<cwd>/.scale/` and per-user state from
 * `~/.scale/<repo-id>/`. Serves the built web SPA plus a small JSON API the map
 * app consumes.
 *
 * Web dist is resolved relative to THIS file so it works whether run via `tsx`
 * from `src/` or `node` from `dist/`: <this>/../../web/dist → packages/web/dist.
 */
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  explainConfig,
  unsetPath,
  loadScaleDir,
  docById,
  resolveInterventionModel,
  LlmProviderSchema,
  LanguageSchema,
  migrateLegacyConfig,
  resolveConfig,
  deepMerge,
  isLead,
  policyLeads,
  PolicyFileSchema,
  POLICY_SECTIONS,
  QuizConfigSchema,
  type LoadedScale,
  type ResolvedConfig,
  UserCoverageSchema,
  emptyComponentCoverage,
  type ScaleConfig,
  type Language,
  type UserCoverage,
  type MapJson,
  type DimName,
  type LlmProvider,
  type LoadedDoc,
  type DocIndexEntry,
  docGrounding,
  neighbourIndex,
  componentSourcesIndex,
  type DriftContext,
} from '@scale/core';

import {
  stateDir,
  resolveRepoId,
  paths,
  readCoverageSafe,
  readQuestsSafe,
  readConfigSafe,
  readUserConfigRaw,
  readPolicyRaw,
  loadEffectiveConfig,
  noteCheckOutcome,
  readLocksSafe,
  ensureStateDir,
  appendEvidence,
} from './state.js';
import { recordConfigDelta } from './telemetry.js';
import { recomputeCoverageFromDisk, currentIdentityEmails } from './coverage.js';
import { driftContext } from './drift-context.js';
import {
  completeQuizQuest,
  deterministicQuizItems,
  generateVoluntaryQuest,
  questForClient,
  gradeQuizPicks,
} from './quest.js';
import { chatText, MissingKeyError } from './llm.js';
import { translateDoc } from './translate.js';
import { keyStatus, resolveKey, setKey } from './keys.js';
import {
  readServeState,
  removeServeState,
  writeServeState,
  viewerOrigin,
  type HealthInfo,
} from './serve-state.js';

/**
 * Plugin release this binary was bundled from — see the same declaration in
 * index.ts. Reported by `/api/health` so `serve ensure` can tell a viewer from
 * an older bundle apart from this one.
 */
declare const __SCALE_VERSION__: string | undefined;
const SERVE_VERSION =
  typeof __SCALE_VERSION__ === 'string' ? __SCALE_VERSION__ : '0.0.0-dev';

/** ≤3-exchange socratic dialogue cap (PLAN §6, web quest runner). */
const SOCRATIC_MAX_EXCHANGES = 3;

interface DialogueTurn {
  role: 'user' | 'assistant';
  content: string;
}
/** In-memory socratic dialogue state, keyed by quest id (server-side, §7.3). */
/**
 * In-flight Socratic dialogues, keyed by quest id.
 *
 * Deliberately in memory: a dialogue is one sitting, and the graded result is
 * what gets persisted. But it is only ever deleted on a SUCCESSFUL final
 * exchange, so an abandoned dialogue — the learner closed the tab, or the model
 * errored on the last turn — used to sit here for the life of the process. TTL
 * and cap mirror `pending-edits.json`, which bounds the same kind of state.
 */
interface DialogueState {
  history: DialogueTurn[];
  userTurns: number;
  touchedAt: number;
  /**
   * The grounding, built once per dialogue instead of once per turn.
   *
   * It was three git calls and up to ~9k characters on EVERY exchange, for a
   * mid-dialogue prompt whose whole instruction is "ask one probing follow-up".
   * Caching it also pins the fence id for the life of the dialogue, so the
   * marker cannot change under the model between turns.
   */
  grounding?: string;
}
const socraticDialogues = new Map<string, DialogueState>();

/** A dialogue untouched for this long is abandoned. */
const DIALOGUE_TTL_MS = 60 * 60 * 1000;
/** Hard cap so a long-lived server cannot accumulate without bound. */
const DIALOGUE_MAX = 32;

/** Drop expired dialogues, then the oldest ones over the cap. */
function pruneDialogues(now: number): void {
  for (const [id, state] of socraticDialogues) {
    if (now - state.touchedAt > DIALOGUE_TTL_MS) socraticDialogues.delete(id);
  }
  if (socraticDialogues.size <= DIALOGUE_MAX) return;
  const oldestFirst = [...socraticDialogues.entries()].sort(
    (a, b) => a[1].touchedAt - b[1].touchedAt,
  );
  for (const [id] of oldestFirst.slice(0, socraticDialogues.size - DIALOGUE_MAX)) {
    socraticDialogues.delete(id);
  }
}

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

/** The EFFECTIVE config: schema defaults < committed team policy < user file. */
function readConfigOrDefault(cwd: string, dir: string): ScaleConfig {
  return loadEffectiveConfig(cwd, dir).config;
}

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the built web SPA (`web-dist`) so `scale serve` works whether it runs
 * from the self-contained plugin bundle (bin/scale.mjs, with web-dist copied
 * next to bin/) or from the monorepo (packages/cli/{src,dist} → packages/web/dist).
 * First existing directory wins; if none exist we return the monorepo path so
 * `serveStatic` shows the graceful "run build" page.
 *
 * Order:
 *   1. $SCALE_WEB_DIST                       — explicit override
 *   2. <bundle>/../web-dist, <bundle>/web-dist — bundle-relative (import.meta.url)
 *   3. <argv1>/../web-dist,  <argv1>/web-dist  — wrapper/argv fallback
 *   4. <this>/../../web/dist                 — monorepo layout
 */
function resolveWebDist(): string {
  const candidates: string[] = [];
  if (process.env.SCALE_WEB_DIST) candidates.push(path.resolve(process.env.SCALE_WEB_DIST));
  candidates.push(path.resolve(here, '..', 'web-dist'));
  candidates.push(path.resolve(here, 'web-dist'));
  const argv1 = process.argv[1];
  if (argv1) {
    const argvDir = path.dirname(path.resolve(argv1));
    candidates.push(path.resolve(argvDir, '..', 'web-dist'));
    candidates.push(path.resolve(argvDir, 'web-dist'));
  }
  const monorepo = path.resolve(here, '..', '..', 'web', 'dist');
  candidates.push(monorepo);
  for (const c of candidates) {
    try {
      if (fs.existsSync(path.join(c, 'index.html'))) return c;
    } catch {
      /* skip unreadable candidate */
    }
  }
  return monorepo;
}

const WEB_DIST = resolveWebDist();

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Is this request's `Origin` one we serve?
 *
 * The API had `access-control-allow-origin: *` on an unauthenticated server
 * whose POST endpoints write config and API keys — and `~/.scale/keys.json` is
 * USER-GLOBAL, so one page overwrote the key for every repo, not just this one.
 * The wildcard was never needed either: `vite dev` proxies `/api` server-side
 * (vite.config.ts) and the production build is served by this process at the
 * same origin, so no browser ever makes a cross-origin request here.
 *
 * Absent `Origin` means a non-browser client (curl, a test, the CLI); browsers
 * always send it cross-origin, including on the "simple" POSTs that skip
 * preflight — which is why blocking the RESPONSE is not enough on its own and
 * this is enforced before the handler runs.
 */
function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return false; // including the literal "null" origin of a sandboxed frame
  }
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

/**
 * Echo an allowed origin back, once per request, so every later `writeHead`
 * inherits it (Node merges previously-set headers). The origin is echoed rather
 * than wildcarded so the set stays closed, and `Vary` keeps a cache from serving
 * one origin's response to another.
 *
 * This only matters for a loopback page that reaches the API directly — `vite
 * preview` on its own port. The usual dev path proxies `/api` server-side and
 * the production build is same-origin, so neither sends an `Origin` at all.
 */
function applyCors(res: http.ServerResponse, origin: string | undefined): void {
  if (!origin) return;
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('vary', 'Origin');
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
  });
  res.end(json);
}

/** Read a request body (≤1 MB) as a UTF-8 string. */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    let bytes = 0;
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1_000_000) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      data += chunk.toString('utf8');
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/** Parse a JSON body, returning {} on any failure. */
function parseBody(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || '{}');
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function readMapJson(cwd: string): MapJson | null {
  try {
    const raw = fs.readFileSync(path.join(cwd, '.scale', 'map.json'), 'utf8');
    return JSON.parse(raw) as MapJson;
  } catch {
    return null;
  }
}

/** Build an all-'fog' coverage from the map's nodes so the UI renders early. */
function synthesizeCoverage(map: MapJson | null, dir: string): UserCoverage {
  const user = readConfigSafe(dir)?.user ?? process.env.USER ?? 'user';
  const components: UserCoverage['components'] = {};
  for (const n of map?.nodes ?? []) components[n.id] = emptyComponentCoverage();
  return UserCoverageSchema.parse({
    user,
    updatedAt: new Date().toISOString(),
    components,
  });
}

function serveStatic(res: http.ServerResponse, urlPath: string): void {
  if (!fs.existsSync(WEB_DIST)) {
    const html =
      '<!doctype html><meta charset="utf-8"><title>scale serve</title>' +
      '<body style="font-family:system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem">' +
      '<h1>SCALE map</h1><p>The web app has not been built yet. Run:</p>' +
      '<pre>npm run build -w @scale/web</pre>' +
      '<p>then restart <code>scale serve</code>. The JSON API is already live at ' +
      '<code>/api/map</code>, <code>/api/coverage</code>, <code>/api/docs</code>, ' +
      '<code>/api/doc/:id</code>, ' +
      '<code>POST /api/doc/:id/translation</code> (🧠 LLM), ' +
      '<code>/api/quests</code>.</p></body>';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // Resolve within WEB_DIST (guard against path traversal).
  const rel = decodeURIComponent(urlPath.split('?')[0] ?? '/').replace(/^\/+/, '');
  let filePath = path.resolve(WEB_DIST, rel);
  if (filePath !== WEB_DIST && !filePath.startsWith(WEB_DIST + path.sep)) {
    filePath = path.join(WEB_DIST, 'index.html'); // traversal → SPA fallback
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    // SPA fallback: unknown non-/api path → index.html.
    filePath = path.join(WEB_DIST, 'index.html');
  }
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const body = fs.readFileSync(filePath);
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'content-length': body.length,
  });
  res.end(body);
}

/**
 * Did this request present the configured bearer token? Accepted as
 * `Authorization: Bearer <t>` (what the SPA sends on every API call) or as a
 * `?token=<t>` query parameter (what the printed URL carries, so the very first
 * page load on a phone can bootstrap it). Constant-time compare — the token is
 * the only thing standing between a LAN and a server that stores API keys.
 */
function presentsToken(req: http.IncomingMessage, url: string, token: string): boolean {
  const header = req.headers.authorization ?? '';
  const fromHeader = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  let fromQuery = '';
  try {
    fromQuery = new URL(url, 'http://x').searchParams.get('token') ?? '';
  } catch {
    /* malformed url → no token */
  }
  const eq = (a: string): boolean => {
    if (a.length !== token.length) return false;
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(token));
  };
  return (fromHeader !== '' && eq(fromHeader)) || (fromQuery !== '' && eq(fromQuery));
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cwd: string,
  token: string | null,
  health: HealthInfo,
): Promise<void> {
  const dir = stateDir(cwd);
  const url = req.url ?? '/';
  const pathname = url.split('?')[0] ?? '/';
  const isApi = pathname === '/api' || pathname.startsWith('/api/');

  // Liveness, answered before the token and origin gates and before any file
  // read. It is how `scale serve ensure` tells "our viewer for THIS repo" from
  // "someone else on 4318", so it has to answer a bare `fetch` from a CLI that
  // has no token and no origin — and it must keep answering when the rest of
  // the server would 401. Nothing here is a secret: a repo-id, a pid, the
  // bundle version, and a start time, all of which the caller already has
  // standing to know because it can reach the port at all.
  if (pathname === '/api/health') {
    sendJson(res, 200, health);
    return;
  }

  // Token first. The static SPA bundle is public code and is served to anyone
  // who can reach the port; the API — which reads coverage, writes config, and
  // stores API keys — is what the token guards. A request that presents the
  // token has authenticated itself, so the same-origin rule below (a defence
  // for the TOKENLESS loopback case against other local pages) does not apply.
  const authed = token !== null && presentsToken(req, url, token);
  if (isApi && token !== null && !authed && req.method !== 'OPTIONS') {
    res.writeHead(401, {
      'content-type': 'application/json; charset=utf-8',
      'www-authenticate': 'Bearer realm="scale"',
    });
    res.end(JSON.stringify({ error: 'token required', hint: 'open the URL scale serve printed' }));
    return;
  }

  const origin = req.headers.origin;
  const originAllowed = authed || isAllowedOrigin(origin);
  // Refuse a cross-origin request outright rather than merely withholding the
  // response headers: a simple POST is delivered and its side effect happens
  // before the browser ever inspects them.
  if (!originAllowed) {
    res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'cross-origin request refused' }));
    return;
  }
  applyCors(res, origin);

  // CORS preflight — only ever reached for an origin we serve; a refused one
  // returned 403 above.
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // --- POST API (quest runner writes) ---
  if (req.method === 'POST') {
    const completeMatch = /^\/api\/quests\/([^/]+)\/complete\/?$/.exec(pathname);
    if (completeMatch) {
      await handleQuestComplete(req, res, cwd, decodeURIComponent(completeMatch[1]!));
      return;
    }
    const socraticMatch = /^\/api\/socratic\/([^/]+)\/message\/?$/.exec(pathname);
    if (socraticMatch) {
      await handleSocraticMessage(req, res, cwd, dir, decodeURIComponent(socraticMatch[1]!));
      return;
    }
    if (pathname === '/api/quests' || pathname === '/api/quests/') {
      await handleQuestCreate(req, res, cwd);
      return;
    }
    if (pathname === '/api/settings/unset') {
      await handleSettingsUnset(req, res, cwd, dir);
      return;
    }
    if (pathname === '/api/settings' || pathname === '/api/settings/') {
      await handleSettingsPatch(req, res, cwd, dir);
      return;
    }
    if (pathname === '/api/policy/unset') {
      await handlePolicyUnset(req, res, cwd, dir);
      return;
    }
    if (pathname === '/api/policy' || pathname === '/api/policy/') {
      await handlePolicyPatch(req, res, cwd, dir);
      return;
    }
    if (pathname === '/api/keys' || pathname === '/api/keys/') {
      await handleKeySet(req, res);
      return;
    }
    // 🧠 LLM. See handleDocTranslation for why this one is a POST.
    const translationMatch = /^\/api\/doc\/([^/]+)\/translation\/?$/.exec(pathname);
    if (translationMatch) {
      await handleDocTranslation(req, res, cwd, dir, decodeURIComponent(translationMatch[1]!));
      return;
    }
    sendJson(res, 404, { error: 'unknown endpoint', path: pathname });
    return;
  }

  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }

  // --- API ---
  // The lock picture the map draws on top of coverage: what this user may edit,
  // what drifted out from under them, and — for an async user — which denied
  // territories still owe a check. Read-only.
  if (pathname === '/api/locks') {
    const locks = readLocksSafe(dir);
    sendJson(res, 200, {
      unlocked: Object.keys(locks.components).sort(),
      drifted: locks.drifted,
      pendingUnlocks: locks.pendingUnlocks,
    });
    return;
  }

  if (pathname === '/api/map') {
    const map = readMapJson(cwd);
    if (!map) {
      sendJson(res, 404, {
        error: 'no map.json',
        hint: 'run `scale map layout` in a repo that has a .scale/ directory',
      });
      return;
    }
    sendJson(res, 200, map);
    return;
  }

  if (pathname === '/api/coverage') {
    // coverage.json is a materialized view of evidence.jsonl. Re-materialize on
    // request when it is missing or older than the evidence that feeds it;
    // otherwise serve the persisted file. When there is no evidence at all, fall
    // back to the all-'fog' synthesis so the UI still renders.
    const evPath = paths.evidence(dir);
    const covPath = paths.coverage(dir);
    const hasEvidence = fs.existsSync(evPath) && fs.statSync(evPath).size > 0;

    if (hasEvidence) {
      const evMtime = fs.statSync(evPath).mtimeMs;
      const covMtime = fs.existsSync(covPath) ? fs.statSync(covPath).mtimeMs : -1;
      if (covMtime < evMtime) {
        try {
          sendJson(res, 200, recomputeCoverageFromDisk(cwd).coverage);
          return;
        } catch {
          // fall through to whatever is on disk / synthesis
        }
      }
      const existing = readCoverageSafe(dir);
      if (existing) {
        sendJson(res, 200, existing);
        return;
      }
    } else {
      const existing = readCoverageSafe(dir);
      if (existing) {
        sendJson(res, 200, existing);
        return;
      }
    }
    sendJson(res, 200, synthesizeCoverage(readMapJson(cwd), dir));
    return;
  }

  if (pathname === '/api/quests') {
    // Answer key stripped — grading happens server-side (see questForClient).
    sendJson(res, 200, readQuestsSafe(dir).map(questForClient));
    return;
  }

  // Settings modal payload: the EFFECTIVE config plus DISPLAY-SAFE key status
  // (configured / source / masked tail). Never the keys themselves — see keys.ts.
  // `policy` tells the UI whether team defaults are in play, so it can say that
  // edits become personal overrides.
  if (pathname === '/api/settings' || pathname === '/api/settings/') {
    const eff = loadEffectiveConfig(cwd, dir);
    // `identity`/`isLead` ride along so the modal can render the Team tab's
    // read-only-vs-editable state on the load it already does, instead of a
    // second round-trip before it can draw anything.
    const identity = identityOf(cwd, dir);
    sendJson(res, 200, {
      config: eff.config,
      policy: {
        present: eff.policyPresent,
        applied: eff.policyApplied,
        error: eff.policyError,
      },
      sources: settingsSources(cwd, dir),
      keys: keyStatus(),
      repoId: resolveRepoId(cwd),
      stateDir: dir,
      identity,
      isLead: isLead(readPolicyRaw(cwd).raw, identity),
    });
    return;
  }

  if (pathname === '/api/policy' || pathname === '/api/policy/') {
    sendJson(res, 200, policyPayload(cwd, dir));
    return;
  }

  if (pathname === '/api/preview/quiz' || pathname === '/api/preview/quiz/') {
    handleQuizPreview(res, new URL(url, 'http://x').searchParams, cwd, dir);
    return;
  }

  // The doc INDEX — every component doc's id, title, province and folder.
  //
  // Small enough to load once and keep (one line per component), and the only
  // thing that lets the viewer act as a doc reader: a "Related components" link
  // is a relative FOLDER path, so turning one into a route needs folder → id,
  // and the Docs browser needs titles for components the reader has not
  // selected yet. /api/map deliberately carries neither — it is a layout, and
  // was never going to grow a title field for this.
  if (pathname === '/api/docs' || pathname === '/api/docs/') {
    const index: DocIndexEntry[] = loadScaleDir(cwd).docs.map((d) => ({
      id: d.id,
      title: d.frontmatter.title,
      province: d.province,
      dir: d.dir,
    }));
    index.sort((a, b) => a.province.localeCompare(b.province) || a.title.localeCompare(b.title));
    sendJson(res, 200, index);
    return;
  }

  const docMatch = /^\/api\/doc\/([^/]+)\/?$/.exec(pathname);
  if (docMatch) {
    const id = decodeURIComponent(docMatch[1]!);
    const loaded = loadScaleDir(cwd);
    const doc = docById(loaded, id);
    if (!doc) {
      sendJson(res, 404, { error: 'unknown component', id });
      return;
    }
    // `dir` rides along so the panel can resolve this doc's own relative links
    // from a single request, without first finding itself in /api/docs.
    sendJson(res, 200, { frontmatter: doc.frontmatter, body: doc.body, dir: doc.dir });
    return;
  }

  if (pathname.startsWith('/api/')) {
    sendJson(res, 404, { error: 'unknown endpoint', path: pathname });
    return;
  }

  // --- static web app (+ SPA fallback) ---
  serveStatic(res, pathname);
}

// ---------------------------------------------------------------------------
// POST /api/doc/:id/translation   {"lang":"ko","refresh":true}   (🧠 LLM)
// ---------------------------------------------------------------------------

/**
 * Render one component doc in the reader's language.
 *
 * The response is `{ id, lang, ...TranslationResult }` — and the failure branch
 * of that result carries the ENGLISH doc, so the panel always has something to
 * draw. A 200 saying `translated: false` with an `error` is the normal, useful
 * answer when there is no API key; 404 and 400 are reserved for a request that
 * names something that does not exist.
 *
 * `lang` defaults to the reader's effective `config.language`, which makes a
 * bodiless POST mean "render this for me" and matches `scale doc show`.
 *
 * WHY THIS IS A POST, AND WHY IT INSISTS ON A JSON CONTENT-TYPE.
 *
 * This is the only route on this server that spends API money. Every other
 * expensive path is already a POST; this one was a GET because it reads a doc,
 * and that reading made it reachable as a SUB-RESOURCE — an `<img>`, a
 * `<script>`, a `<link>` on any page the reader happens to have open — and a
 * sub-resource request carries no `Origin` header at all. The Origin allowlist
 * above treats an absent `Origin` as a non-browser client (curl, the CLI, a
 * test), so a tokenless loopback server would have billed the reader for every
 * such hit.
 *
 * `POST` + a required `content-type: application/json` is what closes that: no
 * HTML element and no `form` can issue a cross-origin request with that
 * content-type without a CORS preflight, and the preflight is answered against
 * the same allowlist. That is what makes the existing Origin check a sufficient
 * CSRF gate on loopback — the method and the content-type are load-bearing, not
 * decoration, so a request without them is refused (415) before any work.
 */
async function handleDocTranslation(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cwd: string,
  dir: string,
  id: string,
): Promise<void> {
  const contentType = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (contentType !== 'application/json') {
    sendJson(res, 415, {
      error: 'content-type must be application/json',
      contentType: req.headers['content-type'] ?? null,
    });
    return;
  }

  const raw = (await readBody(req)).trim();
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw === '' ? '{}' : raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SyntaxError('x');
    body = parsed as Record<string, unknown>;
  } catch {
    // Unlike the other POSTs, which tolerate a junk body and fall back to their
    // own defaults, a body this route cannot read is refused outright: the
    // default it would fall back to is "spend money".
    sendJson(res, 400, { error: 'body must be a JSON object' });
    return;
  }

  const config = loadEffectiveConfig(cwd, dir).config;
  const wanted = body.lang;
  const parsedLang =
    wanted === undefined || wanted === null
      ? { success: true as const, data: config.language }
      : LanguageSchema.safeParse(wanted);
  if (!parsedLang.success) {
    sendJson(res, 400, {
      error: 'unsupported lang',
      lang: typeof wanted === 'string' ? wanted : null,
      supported: LanguageSchema.options,
    });
    return;
  }
  const lang = parsedLang.data;

  const doc = docById(loadScaleDir(cwd), id);
  if (!doc) {
    sendJson(res, 404, { error: 'unknown component', id });
    return;
  }

  const refresh = body.refresh === true;
  // translateDoc never throws — every failure is already a `translated: false`
  // carrying the English source and a named reason.
  const result = await translateDoc({ doc, lang, config, dir, refresh });
  sendJson(res, 200, { id, lang, ...result });
}

// ---------------------------------------------------------------------------
// POST /api/quests/:id/complete  (quiz)
// ---------------------------------------------------------------------------

/**
 * Record a completed quiz quest via the shared `completeQuizQuest` (the exact
 * same code path the CLI's `scale quest complete` uses — no divergence): append
 * one quiz_result (origin 'session') per graded dimension, mark the quest
 * completed, re-materialize coverage, and return the updated component coverage.
 * Body: `{ results: [{ dim, score }] }`.
 */
async function handleQuestComplete(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cwd: string,
  questId: string,
): Promise<void> {
  const body = parseBody(await readBody(req));
  const quest = readQuestsSafe(stateDir(cwd)).find((q) => q.id === questId);
  if (!quest) {
    sendJson(res, 404, { error: 'unknown quest', id: questId });
    return;
  }
  // Body is `{ picks: number[] }` — WHICH OPTION, not what it scored. The
  // client no longer has the key to grade with and its score is no longer
  // taken on trust; a check now opens a lock, so the grading has to happen on
  // the side that owns the lock.
  const { results, reveal } = gradeQuizPicks(quest, body.picks);
  // The web quest runner is the junior clicking through the items themselves.
  const result = await completeQuizQuest(cwd, questId, results, 'user');
  if (!result) {
    sendJson(res, 404, { error: 'unknown quest', id: questId });
    return;
  }
  sendJson(res, 200, {
    componentId: result.componentId,
    recorded: result.recorded,
    quest: { id: questId, status: 'completed' },
    component: result.component,
    // Now — and only now — the runner learns what the answers were.
    reveal,
  });
}

// ---------------------------------------------------------------------------
// POST /api/quests  (create a VOLUNTARY quest on demand — the Challenge button)
// ---------------------------------------------------------------------------

/**
 * Create a voluntary quest for one component (PLAN §6.3). Body: `{ componentId }`.
 * Available in EVERY condition and spends no interruption budget — this is the
 * junior's own initiative. Uses the configured intervention model when an API
 * key is present, otherwise deterministic doc-grounded items, so the map's
 * Challenge button always produces a runnable quest. Responds with the new quest
 * so the runner can open immediately.
 */
async function handleQuestCreate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cwd: string,
): Promise<void> {
  const body = parseBody(await readBody(req));
  const componentId = typeof body.componentId === 'string' ? body.componentId.trim() : '';
  if (!componentId) {
    sendJson(res, 400, { error: 'componentId is required' });
    return;
  }
  try {
    const made = await generateVoluntaryQuest(cwd, componentId);
    if (!made) {
      sendJson(res, 404, { error: 'unknown component', componentId });
      return;
    }
    sendJson(res, 200, { quest: made.quest, via: made.via, model: made.model });
  } catch (err) {
    sendJson(res, 500, { error: 'quest generation failed', detail: String(err) });
  }
}

// ---------------------------------------------------------------------------
// GET/POST /api/settings, POST /api/keys  (settings modal)
// ---------------------------------------------------------------------------

/** Shallow-merge one nested config section; a non-object patch is ignored. */
function mergeSection(base: unknown, patch: unknown): unknown {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base;
  const b = base && typeof base === 'object' && !Array.isArray(base) ? base : {};
  return { ...(b as object), ...(patch as object) };
}

/**
 * Patch the user config from the settings modal. Body is a PARTIAL config; each
 * patched section deep-merges into the user's SPARSE overrides file — never the
 * materialized effective config, which would freeze every team-policy default
 * as an explicit personal override (PLAN-GATE §2). The merged EFFECTIVE result
 * is validated before anything lands on disk, so a bad field is a 400.
 */
async function handleSettingsPatch(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cwd: string,
  dir: string,
): Promise<void> {
  const patch = parseBody(await readBody(req));
  const before = loadEffectiveConfig(cwd, dir).config;
  const currentRaw = readUserConfigRaw(dir) ?? { user: process.env.USER ?? 'user' };
  const next: Record<string, unknown> = { ...currentRaw };
  if (typeof patch.user === 'string' && patch.user.trim()) next.user = patch.user.trim();
  if (typeof patch.language === 'string') next.language = patch.language;
  for (const section of [
    'gate',
    'quiz',
    'unlock',
    'exempt',
    'drift',
    'budgets',
    'thresholds',
    'models',
  ] as const) {
    if (patch[section] !== undefined) {
      next[section] = mergeSection(next[section], patch[section]);
    }
  }
  const migrated = migrateLegacyConfig(next) as Record<string, unknown>;
  const policy = readPolicyRaw(cwd);
  let resolved: ResolvedConfig;
  try {
    resolved = resolveConfig(migrated, policy.parseError ? undefined : policy.raw);
  } catch (err) {
    sendJson(res, 400, { error: 'invalid settings', detail: (err as Error).message });
    return;
  }
  ensureStateDir(dir);
  fs.writeFileSync(paths.config(dir), JSON.stringify(migrated, null, 2) + '\n');
  // Logged AFTER the write, so a rejected patch leaves no row (PLAN-GATE §15).
  recordConfigDelta(dir, cwd, before, resolved.config, 'web', false);
  sendJson(res, 200, {
    config: resolved.config,
    keys: keyStatus(),
    sources: settingsSources(cwd, dir),
  });
}

/**
 * Per-leaf provenance for the Settings modal: `default` / `policy` / `user`,
 * with the policy value where the team names one. Computed from the raw files,
 * never from the effective object, because equality with the team default does
 * not mean the user did not pin it.
 */
function settingsSources(cwd: string, dir: string): ReturnType<typeof explainConfig> {
  const policy = readPolicyRaw(cwd);
  try {
    return explainConfig(readUserConfigRaw(dir) ?? { user: 'user' }, policy.parseError ? undefined : policy.raw);
  } catch {
    return {};
  }
}

/**
 * POST /api/settings/unset `{ path }` — drop ONE personal override so the team
 * default (or schema default) shows through again. This is the S4 "back to
 * team default" affordance. The user field cannot be unset. The change is
 * logged as a config_change with `reset: true`.
 */
async function handleSettingsUnset(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cwd: string,
  dir: string,
): Promise<void> {
  const body = parseBody(await readBody(req));
  const dotted = typeof body.path === 'string' ? body.path.trim() : '';
  if (!/^[a-zA-Z][\w.]*$/.test(dotted) || dotted === 'user') {
    sendJson(res, 400, { error: 'path must be a dotted config key other than "user"' });
    return;
  }
  const before = loadEffectiveConfig(cwd, dir).config;
  const currentRaw = readUserConfigRaw(dir) ?? { user: process.env.USER ?? 'user' };
  const next = unsetPath(migrateLegacyConfig(currentRaw) as Record<string, unknown>, dotted);
  const policy = readPolicyRaw(cwd);
  let resolved: ResolvedConfig;
  try {
    resolved = resolveConfig(next, policy.parseError ? undefined : policy.raw);
  } catch (err) {
    sendJson(res, 400, { error: 'invalid settings', detail: (err as Error).message });
    return;
  }
  ensureStateDir(dir);
  fs.writeFileSync(paths.config(dir), JSON.stringify(next, null, 2) + '\n');
  recordConfigDelta(dir, cwd, before, resolved.config, 'web', true);
  sendJson(res, 200, {
    config: resolved.config,
    keys: keyStatus(),
    sources: settingsSources(cwd, dir),
  });
}

// ---------------------------------------------------------------------------
// GET /api/preview/quiz  (settings modal — Checks tab)
//
// A REAL check built from this repo's own docs, so the junior can see what
// `quiz.items` / `quiz.focus` actually produce before they live with it.
//
// It runs the DETERMINISTIC generator (quest.ts), never the model: a preview
// that spends API credit every time a slider moves is a preview nobody leaves
// on, and it would need a key the settings screen exists partly to configure.
// The trade is honest and stated in the UI — the real check is model-written
// and diff-grounded; this shows the shape, the dimension mix and the grounding
// material, which is what the settings decide.
//
// Read-only by construction: no write, no LLM, no evidence row.
// ---------------------------------------------------------------------------

/**
 * Pick the component to preview: the richest doc, by `concepts + rationale`
 * entries, since a thin doc shows the padding path rather than what a normal
 * check looks like. Ties break on id so the preview is stable across reloads.
 */
function richestDoc(loaded: LoadedScale): LoadedDoc | null {
  let best: LoadedDoc | null = null;
  let bestScore = -1;
  for (const doc of loaded.docs) {
    const score = doc.frontmatter.concepts.length + doc.frontmatter.rationale.length;
    if (score > bestScore || (score === bestScore && best && doc.id < best.id)) {
      best = doc;
      bestScore = score;
    }
  }
  return best;
}

function handleQuizPreview(
  res: http.ServerResponse,
  params: URLSearchParams,
  cwd: string,
  dir: string,
): void {
  // The shape comes from the QUERY, not from disk: the point is to preview a
  // setting the user has not committed to yet. It is validated by the same
  // schema the config uses, so an out-of-range value fails here exactly as it
  // would on save.
  const requested: Record<string, unknown> = {};
  const items = params.get('items');
  if (items !== null) requested.items = Number(items);
  const focus = params.get('focus');
  if (focus !== null) requested.focus = focus;
  const grounding = params.get('grounding');
  if (grounding !== null) requested.grounding = grounding;

  const quiz = QuizConfigSchema.safeParse(requested);
  if (!quiz.success) {
    const issue = quiz.error.issues[0];
    sendJson(res, 400, {
      error: 'invalid quiz shape',
      detail: issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'invalid',
    });
    return;
  }

  const loaded = loadScaleDir(cwd);
  if (loaded.docs.length === 0) {
    sendJson(res, 404, { error: 'no coverage memory', hint: 'run /scale-map in this repo' });
    return;
  }
  const wanted = params.get('component');
  const doc = wanted ? docById(loaded, wanted) : richestDoc(loaded);
  if (!doc) {
    sendJson(res, 404, { error: 'unknown component', id: wanted });
    return;
  }

  const config = readConfigOrDefault(cwd, dir);
  const map = readMapJson(cwd);
  const neighbours = map ? neighbourIndex(map).get(doc.id) : undefined;
  const generated = deterministicQuizItems(doc, loaded, config.language, neighbours, quiz.data);

  sendJson(res, 200, {
    componentId: doc.id,
    title: doc.frontmatter.title,
    // `correctIndex` and `answer` are deliberately stripped. This is the same
    // rule the quest runner follows (questForClient): the answer key never
    // reaches the browser, and a preview is not a reason to make an exception —
    // these are real items the junior may be asked later.
    items: generated.map((i) => ({ stem: i.prompt, options: i.options ?? [], dim: i.dim })),
    /** Every component the picker may offer, cheapest possible payload. */
    components: loaded.docs
      .map((d) => ({ id: d.id, title: d.frontmatter.title }))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
    /**
     * The deterministic generator builds from the doc's frontmatter and has no
     * access to a session diff, so `grounding` changes nothing here. Said out
     * loud rather than silently showing identical items for three settings.
     */
    groundingPreviewable: false,
  });
}

// ---------------------------------------------------------------------------
// GET/POST /api/policy  (settings modal — Team tab)
//
// The TEAM file, `.scale/policy.json`, as opposed to every other settings
// endpoint above, which writes the caller's personal `~/.scale/<repo-id>/
// config.json`. Two things follow from that and shape all three handlers:
//
//  1. It is committed source. Writing it dirties the working tree and changes
//     nothing for anyone else until someone commits and pushes, so the response
//     reports `dirty` and the UI says so rather than implying the team is
//     already living under the new defaults.
//  2. The `leads` check is a UX gate, not a security boundary. The 403 stops a
//     member from retuning the team's defaults from a settings screen while
//     thinking they are changing their own; it stops nothing at all from an
//     editor. Real control over this path is git review / CODEOWNERS.
// ---------------------------------------------------------------------------

/** Absolute path of the committed team policy for the repo at `cwd`. */
function policyPath(cwd: string): string {
  return path.join(cwd, '.scale', 'policy.json');
}

/**
 * Is the policy file modified or untracked in git? Best-effort: anything that
 * is not a clean answer (no git, no repo, git missing) reads FALSE, because an
 * "uncommitted" badge that is wrong is worse than a missing one.
 */
function policyIsDirty(cwd: string): boolean {
  try {
    const out = execFileSync('git', ['status', '--porcelain', '--', '.scale/policy.json'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/** Who the caller is in git's eyes, via the one resolver drift attribution uses. */
function identityOf(cwd: string, dir: string): string[] {
  try {
    return currentIdentityEmails(cwd, loadEffectiveConfig(cwd, dir).config);
  } catch {
    return [];
  }
}

/** The GET /api/policy body, reused as the reply to both writes. */
function policyPayload(cwd: string, dir: string, extra: Record<string, unknown> = {}): object {
  const policy = readPolicyRaw(cwd);
  const identity = identityOf(cwd, dir);
  const eff = loadEffectiveConfig(cwd, dir);
  return {
    path: policyPath(cwd),
    exists: policy.present,
    parseError: policy.parseError,
    // The RAW file, not a parsed one: a parse would materialize every schema
    // default into the sections and the UI could no longer tell "the team set
    // soft" from "nobody set anything".
    raw: policy.parseError ? null : (policy.raw ?? null),
    leads: policyLeads(policy.raw),
    identity,
    isLead: isLead(policy.raw, identity),
    dirty: policyIsDirty(cwd),
    error: eff.policyError,
    ...extra,
  };
}

/**
 * Validate a candidate policy object two ways before it may be written: as a
 * policy FILE (leads + section values), and by checking that the caller's own
 * effective config still resolves under it. The second is what catches a
 * default that is individually legal but cannot combine with a real user file.
 *
 * Returns null when good, or the message to send as a 400.
 */
function validatePolicy(next: unknown, dir: string): string | null {
  const parsed = PolicyFileSchema.safeParse(next);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'invalid policy';
  }
  try {
    const user = readUserConfigRaw(dir) ?? { user: process.env.USER ?? 'user' };
    const resolved = resolveConfig(migrateLegacyConfig(user), next);
    // resolveConfig FAILS OPEN — an unusable policy is reported, not thrown, so
    // the write path has to read the flag or it would happily persist a file
    // that silently does nothing.
    if (resolved.policyError) return resolved.policyError;
  } catch (err) {
    return (err as Error).message;
  }
  return null;
}

/** Write the policy file, creating `.scale/` if the repo has none yet. */
function writePolicyFile(cwd: string, next: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(policyPath(cwd)), { recursive: true });
  fs.writeFileSync(policyPath(cwd), JSON.stringify(next, null, 2) + '\n');
}

/** The current policy as a mutable sparse object; `{}` when absent or broken. */
function currentPolicyObject(cwd: string): Record<string, unknown> {
  const policy = readPolicyRaw(cwd);
  if (policy.parseError || !policy.raw || typeof policy.raw !== 'object' || Array.isArray(policy.raw)) {
    return {};
  }
  return structuredClone(policy.raw) as Record<string, unknown>;
}

/**
 * POST /api/policy — deep-merge a sparse patch into the team policy.
 *
 * `leads` REPLACES rather than merges (it is a list, and a member being removed
 * has to be expressible); the config sections deep-merge leaf by leaf, exactly
 * as a personal settings patch does, so setting `gate.enforcement` leaves the
 * team's `gate.assessment` alone.
 */
async function handlePolicyPatch(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cwd: string,
  dir: string,
): Promise<void> {
  const before = readPolicyRaw(cwd);
  const identity = identityOf(cwd, dir);
  if (!isLead(before.raw, identity)) {
    sendJson(res, 403, { error: 'not a lead', leads: policyLeads(before.raw), identity });
    return;
  }

  const patch = parseBody(await readBody(req));
  const next = currentPolicyObject(cwd);

  if (patch.leads !== undefined) {
    if (!Array.isArray(patch.leads)) {
      sendJson(res, 400, { error: 'leads must be an array of email addresses' });
      return;
    }
    const cleaned: string[] = [];
    for (const raw of patch.leads) {
      const email = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
      if (email && !cleaned.includes(email)) cleaned.push(email);
    }
    next.leads = cleaned;
  }

  for (const section of POLICY_SECTIONS) {
    if (patch[section] === undefined) continue;
    next[section] = deepMerge(next[section], patch[section]) as Record<string, unknown>;
  }

  const invalid = validatePolicy(next, dir);
  if (invalid) {
    sendJson(res, 400, { error: 'invalid policy', detail: invalid });
    return;
  }
  writePolicyFile(cwd, next);

  // Emptying `leads` hands the policy back to everyone (the bootstrap rule).
  // It is allowed — a departing lead must not be able to strand the team — but
  // it is never what someone means by accident, so the UI is told to say so.
  const warning =
    Array.isArray(next.leads) && next.leads.length === 0 && policyLeads(before.raw).length > 0
      ? 'no leads are listed any more — anyone can now edit the team policy'
      : undefined;
  sendJson(res, 200, policyPayload(cwd, dir, warning ? { warning } : {}));
}

/**
 * POST /api/policy/unset `{ path }` — drop ONE dotted leaf from the team policy
 * so the SCHEMA default shows through again for everyone. Same `unsetPath` the
 * personal settings use, so an emptied section prunes itself and the file stays
 * sparse.
 */
async function handlePolicyUnset(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cwd: string,
  dir: string,
): Promise<void> {
  const before = readPolicyRaw(cwd);
  const identity = identityOf(cwd, dir);
  if (!isLead(before.raw, identity)) {
    sendJson(res, 403, { error: 'not a lead', leads: policyLeads(before.raw), identity });
    return;
  }

  const body = parseBody(await readBody(req));
  const dotted = typeof body.path === 'string' ? body.path.trim() : '';
  if (!/^[a-zA-Z][\w.]*$/.test(dotted)) {
    sendJson(res, 400, { error: 'path must be a dotted policy key' });
    return;
  }
  const section = dotted.split('.')[0]!;
  if (section !== 'leads' && !(POLICY_SECTIONS as readonly string[]).includes(section)) {
    sendJson(res, 400, { error: `"${section}" is not a policy section` });
    return;
  }

  const next = unsetPath(currentPolicyObject(cwd), dotted);
  const invalid = validatePolicy(next, dir);
  if (invalid) {
    sendJson(res, 400, { error: 'invalid policy', detail: invalid });
    return;
  }
  writePolicyFile(cwd, next);

  const warning =
    policyLeads(next).length === 0 && policyLeads(before.raw).length > 0
      ? 'no leads are listed any more — anyone can now edit the team policy'
      : undefined;
  sendJson(res, 200, policyPayload(cwd, dir, warning ? { warning } : {}));
}

/**
 * Store (or, with an empty string, clear) one provider's API key. Body:
 * `{ provider, key }`. The key goes to `~/.scale/keys.json` at mode 0600 and is
 * NEVER echoed back — the response carries only the masked status. When an env
 * var is set for that provider it keeps winning, and the response says so via
 * `source: 'env'` so the UI can warn that the stored key is being shadowed.
 */
async function handleKeySet(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = parseBody(await readBody(req));
  const provider = LlmProviderSchema.safeParse(body.provider);
  if (!provider.success) {
    sendJson(res, 400, { error: 'provider must be "anthropic" or "openai"' });
    return;
  }
  if (typeof body.key !== 'string') {
    sendJson(res, 400, { error: 'key must be a string ("" clears it)' });
    return;
  }
  try {
    setKey(provider.data, body.key);
  } catch (err) {
    sendJson(res, 500, { error: 'could not write key file', detail: (err as Error).message });
    return;
  }
  sendJson(res, 200, { keys: keyStatus() });
}

// ---------------------------------------------------------------------------
// POST /api/socratic/:id/message  (socratic proxy — INTERVENTION model)
// ---------------------------------------------------------------------------

/** Component-doc grounding for the socratic system prompt. */
function docContext(doc: LoadedDoc | undefined, cwd?: string): string {
  if (!doc) return 'No component doc is available; keep the dialogue general but rigorous.';
  // Shared with quest generation. This path used to drop `alternatives` — the
  // exact material the rationale rubric's top band asks the junior to explain.
  // Measured dependencies come along too: a Socratic opener is exactly the place
  // for "what breaks if this changed", which needs to know what depends on it.
  const map = cwd ? readMapJson(cwd) : null;
  const neighbours = map ? neighbourIndex(map).get(doc.frontmatter.id) : undefined;
  // And, on a component that has drifted, what actually changed. This proxy is
  // the async user's recovery surface, so it is the one path that most needs to
  // ask about the change rather than re-ask the original questions.
  const drift = cwd ? driftForComponent(cwd, doc.frontmatter.id) : null;
  return docGrounding(doc, { neighbours, ...(drift ? { drift } : {}) });
}

/** Drift context for a `stale` component, or null. Best-effort; never throws. */
function driftForComponent(cwd: string, componentId: string): DriftContext | null {
  try {
    const comp = readCoverageSafe(stateDir(cwd))?.components[componentId];
    if (!comp || comp.state !== 'stale' || !comp.driftCause) return null;
    const sources =
      componentSourcesIndex(loadScaleDir(cwd)).find((s) => s.id === componentId)?.sources ?? [];
    const share = loadEffectiveConfig(cwd, stateDir(cwd)).config.drift.shareDiff;
    return driftContext(cwd, comp.lastValidatedSha, sources, comp.driftCause, share);
  } catch {
    return null;
  }
}

/** The dialogue's grounding, computed once and reused for every later turn. */
function groundingFor(
  state: DialogueState,
  doc: LoadedDoc | undefined,
  cwd?: string,
): string {
  state.grounding ??= docContext(doc, cwd);
  return state.grounding;
}

/** Strip ```json fences and parse; throws on failure. */
function stripJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  return JSON.parse((fenced?.[1] ?? text).trim());
}

function clamp01(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : fallback;
}

/**
 * Parse per-dim grades from a model reply, or `null` when the reply carried no
 * usable grade at all.
 *
 * This used to default every dimension to a neutral 0.5 on a parse failure. That
 * is not neutral: the caller writes the result as a `socratic_result`, which
 * EMA-updates all three dimensions and counts toward `minActiveValidations` — so
 * a model that answered in prose instead of JSON handed the learner a graded,
 * validation-counting result on no evidence, moving territory toward `validated`.
 * A missing grade is missing data, and the only honest thing to record is
 * nothing. A PARTIAL reply still grades: 0.5 fills the gaps only when at least
 * one dimension was genuinely returned.
 */
function parseGrades(text: string): Record<DimName, number> | null {
  let g: Record<string, unknown> = {};
  try {
    const parsed = stripJson(text) as Record<string, unknown>;
    const raw = (parsed.grades ?? parsed) as Record<string, unknown>;
    if (raw && typeof raw === 'object') g = raw;
  } catch {
    return null;
  }
  const graded = (['structure', 'concepts', 'rationale'] as const).filter(
    (d) => typeof g[d] === 'number' && Number.isFinite(g[d] as number),
  );
  if (graded.length === 0) return null;
  return {
    structure: clamp01(g.structure, 0.5),
    concepts: clamp01(g.concepts, 0.5),
    rationale: clamp01(g.rationale, 0.5),
  };
}

/**
 * Appended to the socratic system prompts when the junior's interaction language
 * is 'ko': the dialogue itself flips to Korean, while code identifiers stay
 * English (see LanguageSchema, @scale/core). Two variants, because the JSON
 * sentence must only appear where a JSON contract exists — mentioning a
 * "closing JSON" in the mid-dialogue prompt can induce the model to wrap its
 * follow-up question in JSON, which would go to the learner verbatim.
 */
const SOCRATIC_KO_DIALOGUE =
  ' Conduct the dialogue in Korean. Keep code identifiers, file paths, and ' +
  'established technical terms in English.';
const SOCRATIC_KO_FINAL =
  SOCRATIC_KO_DIALOGUE +
  ' In the closing JSON, keys and numeric grades stay exactly as specified; ' +
  "write the 'reply' text in Korean.";

async function socraticReply(
  provider: LlmProvider,
  model: string,
  doc: LoadedDoc | undefined,
  history: DialogueTurn[],
  language: Language = 'en',
  grounding = '',
): Promise<string> {
  const text = await chatText({
    provider,
    model,
    maxTokens: 400,
    system:
      'You are a Socratic tutor helping a junior engineer build genuine comprehension ' +
      'of a codebase component. Ask ONE probing follow-up question at a time, grounded ' +
      'in the component doc below. Do NOT reveal answers or lecture — draw the ' +
      'reasoning out of the learner. Keep each turn to 1-3 sentences; be brief and ' +
      'supportive.' +
      (language === 'ko' ? SOCRATIC_KO_DIALOGUE : '') +
      `\n\n${grounding}`,
    messages: history.map((t) => ({ role: t.role, content: t.content })),
  });
  return (
    text ||
    (language === 'ko'
      ? '그 부분이 어떻게 동작하는지, 왜 그런지 조금 더 설명해 주시겠어요?'
      : 'Can you say more about how that part works, and why?')
  );
}

async function socraticFinal(
  provider: LlmProvider,
  model: string,
  doc: LoadedDoc | undefined,
  history: DialogueTurn[],
  language: Language = 'en',
  grounding = '',
): Promise<{ reply: string; grades: Record<DimName, number> | null }> {
  const text = await chatText({
    provider,
    model,
    maxTokens: 500,
    system:
      'You are concluding a Socratic comprehension dialogue about a codebase component. ' +
      'Give brief supportive closing feedback (1-2 sentences), then grade the learner\'s ' +
      'demonstrated comprehension on each dimension in [0,1]: "structure" (how it is ' +
      'built), "concepts" (its named ideas), "rationale" (why it is designed that way). ' +
      'Return ONLY JSON: {"reply":"...","grades":{"structure":0.0,"concepts":0.0,' +
      '"rationale":0.0}}.' +
      (language === 'ko' ? SOCRATIC_KO_FINAL : '') +
      `\n\n${grounding}`,
    messages: history.map((t) => ({ role: t.role, content: t.content })),
  });
  const grades = parseGrades(text);
  let reply =
    language === 'ko'
      ? '감사합니다 — 이해도를 잘 파악할 수 있었어요.'
      : 'Thanks — that gives me a good sense of your understanding.';
  try {
    const parsed = stripJson(text) as Record<string, unknown>;
    if (typeof parsed.reply === 'string' && parsed.reply.trim()) reply = parsed.reply.trim();
  } catch {
    /* keep default closing */
  }
  return { reply, grades };
}

/**
 * Server-side socratic proxy (PLAN §7.3). Maintains a ≤3-exchange dialogue keyed
 * by quest id; grounds every turn in the quest component's doc via the
 * configured INTERVENTION model. On the final exchange, grades per-dim, records a
 * socratic_result (origin 'session'), marks the quest completed, and returns
 * `{ reply, done, grades, component }`. No API auth → a clear `{ error }`, never a
 * crash. Body: `{ message }`.
 */
async function handleSocraticMessage(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cwd: string,
  dir: string,
  questId: string,
): Promise<void> {
  const body = parseBody(await readBody(req));
  const message = typeof body.message === 'string' ? body.message : '';
  const quests = readQuestsSafe(dir);
  const quest = quests.find((q) => q.id === questId);
  if (!quest) {
    sendJson(res, 404, { error: 'unknown quest', id: questId });
    return;
  }
  if (!message.trim()) {
    sendJson(res, 400, { error: 'empty message' });
    return;
  }

  const config = readConfigOrDefault(cwd, dir);
  const provider = config.models.provider;
  const model = resolveInterventionModel(config.models);
  const doc = docById(loadScaleDir(cwd), quest.componentId);

  pruneDialogues(Date.now());
  const state: DialogueState = socraticDialogues.get(questId) ?? {
    history: [],
    userTurns: 0,
    touchedAt: Date.now(),
  };
  state.touchedAt = Date.now();
  state.history.push({ role: 'user', content: message });
  state.userTurns++;
  const isFinal = state.userTurns >= SOCRATIC_MAX_EXCHANGES;

  // No key for the selected provider → roll back the speculative turn so a retry
  // after adding one in Settings works, and tell the UI precisely what's missing.
  // The error prose is learner-facing (the web UI renders it verbatim), so it
  // follows config.language; env-var names stay English.
  if (!resolveKey(provider)) {
    state.history.pop();
    state.userTurns--;
    const envVar = provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
    sendJson(res, 200, {
      reply: null,
      done: false,
      needsKey: provider,
      error:
        config.language === 'ko'
          ? `${provider} API 키가 없습니다. ${envVar}를 설정하거나 설정(⚙)에서 키를 추가하세요.`
          : new MissingKeyError(provider).message,
    });
    return;
  }

  try {
    if (!isFinal) {
      const reply = await socraticReply(
        provider,
        model,
        doc,
        state.history,
        config.language,
        groundingFor(state, doc, cwd),
      );
      state.history.push({ role: 'assistant', content: reply });
      socraticDialogues.set(questId, state);
      sendJson(res, 200, { reply, done: false });
      return;
    }

    const { reply, grades } = await socraticFinal(
      provider,
      model,
      doc,
      state.history,
      config.language,
      groundingFor(state, doc, cwd),
    );
    const sha = shortHeadSha(cwd);
    const now = new Date().toISOString();
    // No parseable grade means no evidence. Conclude the dialogue and mark the
    // quest done — the learner did the work and must not be asked again — but
    // record NOTHING, rather than an invented score that would EMA three
    // dimensions and count as an active validation toward `validated`.
    if (grades) {
      try {
        await appendEvidence(dir, {
          type: 'socratic_result',
          ts: now,
          user: config.user,
          componentId: quest.componentId,
          dims: grades,
          sha,
          origin: 'session',
          // A human held this dialogue in the browser; the model only graded it.
          by: 'user',
        });
      } catch {
        /* recording is best-effort — still conclude the dialogue */
      }
      // …and register it against the unlock ledger. This path builds its own
      // evidence rather than going through `completeSocraticQuest`, so it was
      // the one check surface that moved coverage without ever unlocking the
      // territory — which is exactly the surface an ASYNC user recovers a
      // rebellion on, so passing there left them still locked out.
      const scores = Object.values(grades).filter((v): v is number => typeof v === 'number');
      if (scores.length > 0) {
        noteCheckOutcome(
          cwd,
          dir,
          quest.componentId,
          scores.reduce((a, b) => a + b, 0) / scores.length,
          'user',
          sha,
          now,
          'socratic',
        );
      }
    } else {
      console.warn(
        `scale serve: socratic grader returned no usable grades for quest ${questId} — ` +
          'concluding without recording a score.',
      );
    }
    const updated = quests.map((q) =>
      q.id === questId ? { ...q, status: 'completed' as const } : q,
    );
    fs.writeFileSync(paths.quests(dir), JSON.stringify(updated, null, 2) + '\n');
    socraticDialogues.delete(questId);

    let component = emptyComponentCoverage();
    try {
      const { coverage } = recomputeCoverageFromDisk(cwd);
      component = coverage.components[quest.componentId] ?? component;
    } catch {
      /* fall back to the empty record */
    }
    sendJson(res, 200, { reply, done: true, grades, componentId: quest.componentId, component });
  } catch (err) {
    // API error mid-dialogue — roll back the turn and report clearly (no crash).
    // Prefix follows config.language; the provider's raw detail stays as-is
    // (technical, often English regardless).
    state.history.pop();
    state.userTurns--;
    sendJson(res, 200, {
      reply: null,
      done: false,
      error:
        config.language === 'ko'
          ? `문답 서버 오류: ${(err as Error).message}`
          : `socratic proxy error: ${(err as Error).message}`,
    });
  }
}

export interface ServeOptions {
  port: number;
  cwd?: string;
  /** Bind address. Defaults to loopback — see the note in `startServer`. */
  host?: string;
  /**
   * Bearer token the API requires. Off loopback one is generated when none is
   * given, because this server writes config and accepts API keys with no other
   * authentication — see `startServer`.
   */
  token?: string;
  /**
   * Exit cleanly after this many minutes with no HTTP request. Undefined (the
   * foreground default) means "stay up until told otherwise" — someone who
   * typed `scale serve` and is watching its log must not have it vanish.
   * `serve ensure` passes a value, because the server it starts is one nobody
   * is watching and nobody would think to stop.
   */
  idleMinutes?: number;
  /**
   * Maintain `~/.scale/<repo-id>/serve.json` and exit cleanly on SIGTERM/SIGINT.
   * Opt-in: an embedded server (tests, a future library use) should not claim
   * to be THE viewer for the repo, nor install process-wide signal handlers.
   */
  trackState?: boolean;
}

export function startServer(opts: ServeOptions): http.Server {
  const cwd = opts.cwd ?? process.cwd();
  const repoId = resolveRepoId(cwd);
  const startedAt = new Date().toISOString();
  const health: HealthInfo = {
    ok: true,
    repoId,
    pid: process.pid,
    version: SERVE_VERSION,
    startedAt,
  };
  /**
   * Last sign of life. The idle timer reads it, and every request — static
   * asset, API call, even a health probe — counts: a browser polling the map is
   * a user, and so is a hook that just checked we are alive.
   */
  let lastRequestAt = Date.now();
  // Loopback by default: this server writes config, records evidence, and (via
  // POST /api/keys) accepts API keys, all with no authentication. It is a
  // single-user local tool, so it must not be reachable off-box. `--host` is an
  // explicit opt-in for e.g. viewing the map from a phone on a trusted LAN.
  const host = opts.host ?? '127.0.0.1';
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  // Off loopback the API MUST be token-guarded; a token given explicitly is
  // honoured anywhere. Generated tokens are printed once, in the URL.
  const token: string | null =
    opts.token?.trim() || (loopback ? null : crypto.randomBytes(18).toString('base64url'));
  const server = http.createServer((req, res) => {
    lastRequestAt = Date.now();
    handle(req, res, cwd, token, health).catch((err) => {
      sendJson(res, 500, { error: (err as Error).message });
    });
  });
  // Without this, EADDRINUSE — the single most common failure here — surfaces as
  // a seven-frame node:net stack trace and looks like a crash.
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `scale: port ${opts.port} is already in use on ${host}. ` +
          `Another \`scale serve\` is probably running — stop it, or pick another port ` +
          `with \`scale serve -p ${opts.port + 1}\`.`,
      );
    } else if (err.code === 'EACCES') {
      console.error(
        `scale: not allowed to bind ${host}:${opts.port} (ports below 1024 need root). ` +
          'Pick a higher port with `scale serve -p 4318`.',
      );
    } else {
      console.error(`scale: could not start the server — ${err.message}`);
    }
    process.exitCode = 1;
  });
  // --- clean exit: the state file must never outlive the process ---
  /**
   * Drop serve.json only while it still points at US. Two servers for one repo
   * is unusual but possible (someone starts a second one on another port), and
   * a dying older process must not take the live one's entry with it.
   */
  const clearOwnState = (): void => {
    if (!opts.trackState) return;
    const current = readServeState(cwd);
    if (!current || current.pid === process.pid) removeServeState(cwd);
  };
  let closing = false;
  const shutdown = (why: 'signal' | 'idle'): void => {
    if (closing) return;
    closing = true;
    clearOwnState();
    if (why === 'idle') {
      console.log(
        `scale: no requests for ${opts.idleMinutes} minute(s) — the map viewer is exiting.`,
      );
    }
    server.close(() => process.exit(0));
    // A browser holding a keep-alive socket would otherwise keep `close()`
    // waiting forever, which is exactly the case the idle timer exists for.
    const hard = setTimeout(() => process.exit(0), 1500);
    hard.unref();
  };

  if (opts.trackState) {
    process.once('SIGTERM', () => shutdown('signal'));
    process.once('SIGINT', () => shutdown('signal'));
    // A crash or an uncaught exit still clears the file, so `serve ensure`
    // never adopts a ghost.
    process.once('exit', clearOwnState);
  }

  const idleMinutes = opts.idleMinutes;
  if (idleMinutes !== undefined && idleMinutes > 0) {
    const idleMs = idleMinutes * 60_000;
    const tick = setInterval(
      () => {
        if (Date.now() - lastRequestAt >= idleMs) shutdown('idle');
      },
      Math.max(1_000, Math.min(idleMs, 30_000)),
    );
    // Unref'd: the timer measures the life of the server, it must not extend it.
    tick.unref();
  }

  server.listen(opts.port, host, () => {
    const scalePresent = fs.existsSync(path.join(cwd, '.scale'));
    if (opts.trackState) {
      // The bound port, not the requested one — port 0 is a real request.
      const bound = server.address();
      const actualPort = bound && typeof bound === 'object' ? bound.port : opts.port;
      writeServeState(
        {
          pid: process.pid,
          port: actualPort,
          host,
          url: viewerOrigin(host, actualPort) + (token ? `/?token=${token}` : ''),
          startedAt,
          idleMinutes: idleMinutes && idleMinutes > 0 ? idleMinutes : null,
          version: SERVE_VERSION,
        },
        cwd,
      );
    }
    const q = token ? `/?token=${token}` : '';
    if (loopback) {
      console.log(`scale: serving http://localhost:${opts.port}${q}`);
    } else {
      // Bound to every interface (or one): list the addresses a phone on the
      // same network can actually type, each carrying the token.
      const addrs =
        host === '0.0.0.0' || host === '::'
          ? Object.values(os.networkInterfaces())
              .flat()
              .filter((a): a is os.NetworkInterfaceInfo => !!a && !a.internal && a.family === 'IPv4')
              .map((a) => a.address)
          : [host];
      console.log(`scale: serving on ${host}:${opts.port} — open on your phone:`);
      for (const a of addrs) console.log(`    http://${a}:${opts.port}${q}`);
      console.log(
        '  The API requires this token; the page keeps it for the tab. Anyone with the',
        '\n  URL can read your coverage and write your settings — share it like a password.',
      );
    }
    console.log(`  repo-id:  ${repoId}`);
    console.log(`  memory:   ${path.join(cwd, '.scale')}${scalePresent ? '' : '  (missing!)'}`);
    console.log(`  state:    ${stateDir(cwd)}`);
    console.log(`  config:   ${paths.config(stateDir(cwd))}`);
    if (!fs.existsSync(WEB_DIST)) {
      console.log('  web:      dist not built — run `npm run build -w @scale/web`');
    }
  });
  return server;
}
