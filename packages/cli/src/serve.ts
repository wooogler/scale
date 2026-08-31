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
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  loadScaleDir,
  paperById,
  resolveInterventionModel,
  LlmProviderSchema,
  ScaleConfigSchema,
  UserCoverageSchema,
  emptyComponentCoverage,
  type ScaleConfig,
  type Language,
  type UserCoverage,
  type MapJson,
  type DimName,
  type LlmProvider,
  type LoadedPaper,
} from '@scale/core';

import {
  stateDir,
  resolveRepoId,
  paths,
  readCoverageSafe,
  readQuestsSafe,
  readConfigSafe,
  ensureStateDir,
  appendEvidence,
} from './state.js';
import { recomputeCoverageFromDisk } from './coverage.js';
import { completeQuizQuest, generateVoluntaryQuest } from './quest.js';
import { chatText, MissingKeyError } from './llm.js';
import { keyStatus, resolveKey, setKey } from './keys.js';

/** ≤3-exchange socratic dialogue cap (PLAN §6, web quest runner). */
const SOCRATIC_MAX_EXCHANGES = 3;

interface DialogueTurn {
  role: 'user' | 'assistant';
  content: string;
}
/** In-memory socratic dialogue state, keyed by quest id (server-side, §7.3). */
const socraticDialogues = new Map<string, { history: DialogueTurn[]; userTurns: number }>();

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

function readConfigOrDefault(dir: string): ScaleConfig {
  return readConfigSafe(dir) ?? ScaleConfigSchema.parse({ user: process.env.USER ?? 'user' });
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

/** Permissive CORS so the local vite dev origin can POST to the API. */
const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
    ...CORS_HEADERS,
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
      '<code>/api/map</code>, <code>/api/coverage</code>, <code>/api/paper/:id</code>, ' +
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

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cwd: string,
): Promise<void> {
  const dir = stateDir(cwd);
  const url = req.url ?? '/';
  const pathname = url.split('?')[0] ?? '/';

  // CORS preflight for the POST API (local vite dev origin).
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
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
    if (pathname === '/api/settings' || pathname === '/api/settings/') {
      await handleSettingsPatch(req, res, dir);
      return;
    }
    if (pathname === '/api/keys' || pathname === '/api/keys/') {
      await handleKeySet(req, res);
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
    sendJson(res, 200, readQuestsSafe(dir));
    return;
  }

  // Settings modal payload: the full config plus DISPLAY-SAFE key status
  // (configured / source / masked tail). Never the keys themselves — see keys.ts.
  if (pathname === '/api/settings' || pathname === '/api/settings/') {
    sendJson(res, 200, {
      config: readConfigOrDefault(dir),
      keys: keyStatus(),
      repoId: resolveRepoId(cwd),
      stateDir: dir,
    });
    return;
  }

  const paperMatch = /^\/api\/paper\/([^/]+)\/?$/.exec(pathname);
  if (paperMatch) {
    const id = decodeURIComponent(paperMatch[1]!);
    const loaded = loadScaleDir(cwd);
    const paper = paperById(loaded, id);
    if (!paper) {
      sendJson(res, 404, { error: 'unknown component', id });
      return;
    }
    sendJson(res, 200, { frontmatter: paper.frontmatter, body: paper.body });
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
  const results = Array.isArray(body.results) ? body.results : [];
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
  });
}

// ---------------------------------------------------------------------------
// POST /api/quests  (create a VOLUNTARY quest on demand — the Challenge button)
// ---------------------------------------------------------------------------

/**
 * Create a voluntary quest for one component (PLAN §6.3). Body: `{ componentId }`.
 * Available in EVERY condition and spends no interruption budget — this is the
 * junior's own initiative. Uses the configured intervention model when an API
 * key is present, otherwise deterministic paper-grounded items, so the map's
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
 * Patch `config.json` from the settings modal. Body is a PARTIAL config; each
 * known section is shallow-merged over the current value and the whole result is
 * re-validated by ScaleConfigSchema, so a bad field is a 400 and never lands on
 * disk. Unknown top-level keys are dropped rather than persisted.
 */
async function handleSettingsPatch(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  dir: string,
): Promise<void> {
  const patch = parseBody(await readBody(req));
  const current = readConfigOrDefault(dir) as unknown as Record<string, unknown>;
  const next: Record<string, unknown> = {
    ...current,
    user: typeof patch.user === 'string' && patch.user.trim() ? patch.user.trim() : current.user,
    language: typeof patch.language === 'string' ? patch.language : current.language,
    condition: mergeSection(current.condition, patch.condition),
    inflow: mergeSection(current.inflow, patch.inflow),
    budgets: mergeSection(current.budgets, patch.budgets),
    thresholds: mergeSection(current.thresholds, patch.thresholds),
    models: mergeSection(current.models, patch.models),
  };
  const parsed = ScaleConfigSchema.safeParse(next);
  if (!parsed.success) {
    sendJson(res, 400, { error: 'invalid settings', detail: parsed.error.issues });
    return;
  }
  ensureStateDir(dir);
  fs.writeFileSync(paths.config(dir), JSON.stringify(parsed.data, null, 2) + '\n');
  sendJson(res, 200, { config: parsed.data, keys: keyStatus() });
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

/** Component-paper grounding for the socratic system prompt. */
function paperContext(paper: LoadedPaper | undefined): string {
  if (!paper) return 'No component paper is available; keep the dialogue general but rigorous.';
  const fm = paper.frontmatter;
  const concepts = fm.concepts.map((c) => `- ${c.name}`).join('\n') || '- (none)';
  const rationale =
    fm.rationale.map((r) => `- ${r.decision}${r.why ? ` — ${r.why}` : ''}`).join('\n') || '- (none)';
  return `Component: ${fm.title}\n\nConcepts:\n${concepts}\n\nRationale:\n${rationale}`;
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
  paper: LoadedPaper | undefined,
  history: DialogueTurn[],
  language: Language = 'en',
): Promise<string> {
  const text = await chatText({
    provider,
    model,
    maxTokens: 400,
    system:
      'You are a Socratic tutor helping a junior engineer build genuine comprehension ' +
      'of a codebase component. Ask ONE probing follow-up question at a time, grounded ' +
      'in the component paper below. Do NOT reveal answers or lecture — draw the ' +
      'reasoning out of the learner. Keep each turn to 1-3 sentences; be brief and ' +
      'supportive.' +
      (language === 'ko' ? SOCRATIC_KO_DIALOGUE : '') +
      `\n\n${paperContext(paper)}`,
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
  paper: LoadedPaper | undefined,
  history: DialogueTurn[],
  language: Language = 'en',
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
      `\n\n${paperContext(paper)}`,
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
 * by quest id; grounds every turn in the quest component's paper via the
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

  const config = readConfigOrDefault(dir);
  const provider = config.models.provider;
  const model = resolveInterventionModel(config.models);
  const paper = paperById(loadScaleDir(cwd), quest.componentId);

  const state = socraticDialogues.get(questId) ?? { history: [], userTurns: 0 };
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
      const reply = await socraticReply(provider, model, paper, state.history, config.language);
      state.history.push({ role: 'assistant', content: reply });
      socraticDialogues.set(questId, state);
      sendJson(res, 200, { reply, done: false });
      return;
    }

    const { reply, grades } = await socraticFinal(
      provider,
      model,
      paper,
      state.history,
      config.language,
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
        });
      } catch {
        /* recording is best-effort — still conclude the dialogue */
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
}

export function startServer(opts: ServeOptions): http.Server {
  const cwd = opts.cwd ?? process.cwd();
  const repoId = resolveRepoId(cwd);
  // Loopback by default: this server writes config, records evidence, and (via
  // POST /api/keys) accepts API keys, all with no authentication. It is a
  // single-user local tool, so it must not be reachable off-box. `--host` is an
  // explicit opt-in for e.g. viewing the map from a phone on a trusted LAN.
  const host = opts.host ?? '127.0.0.1';
  const server = http.createServer((req, res) => {
    handle(req, res, cwd).catch((err) => {
      sendJson(res, 500, { error: (err as Error).message });
    });
  });
  server.listen(opts.port, host, () => {
    const scalePresent = fs.existsSync(path.join(cwd, '.scale'));
    const shown = host === '127.0.0.1' ? 'localhost' : host;
    console.log(`scale: serving http://${shown}:${opts.port}`);
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
