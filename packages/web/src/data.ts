import type {
  MapJson,
  UserCoverage,
  DocFrontmatter,
  Quest,
  ComponentCoverage,
  DimName,
  Language,
  LlmProvider,
  ScaleConfig,
} from '@scale/core/browser';

/**
 * Data layer (PLAN §7.3). The viewer normally reads LIVE data from the
 * `scale serve` HTTP API — the user's OWN repo map — via same-origin relative
 * URLs (`/api/...`). In production the app is served BY `scale serve`, so the
 * relative fetch just works; in `vite dev` a proxy (vite.config.ts) forwards
 * `/api/*` to the serve port.
 *
 * On a fetch failure each loader can fall back to bundled hand-seeded sample
 * data so the UI still renders for standalone `vite dev`. That fallback is
 * restricted to DEV BUILDS and announced through {@link sampleDataActive}.
 *
 * It used to apply everywhere, silently: a repo with no `.scale/` — or a server
 * that had stopped — rendered a complete, interactive map of a DIFFERENT,
 * invented codebase, with coverage numbers and answerable quiz items, behind
 * nothing but a `console.warn`. No screenshot or participant report of the map
 * was trustworthy without opening the console first. A production build now
 * fails loudly instead, and a dev build says on screen that what you are
 * looking at is not your repo.
 */

/** Shape returned by GET /api/doc/:id (frontmatter + markdown body). */
export interface DocResponse {
  frontmatter: DocFrontmatter;
  body: string;
}

/**
 * Bearer token for the API, when `scale serve` was started off loopback.
 *
 * It arrives once, in the URL the server printed (`?token=…`), is moved into
 * sessionStorage on first load and stripped from the address bar, and then
 * rides on every API call as a header. sessionStorage, not localStorage: the
 * token is a per-run secret for a server that stores API keys, and it should
 * die with the tab rather than outlive the process that minted it.
 */
const TOKEN_KEY = 'scale.apiToken';

export function bootstrapToken(): void {
  try {
    const url = new URL(window.location.href);
    const fromUrl = url.searchParams.get('token');
    if (fromUrl) {
      sessionStorage.setItem(TOKEN_KEY, fromUrl);
      url.searchParams.delete('token');
      window.history.replaceState(null, '', url.toString());
    }
  } catch {
    /* no window, or storage blocked — tokenless loopback still works */
  }
}

function authHeaders(): Record<string, string> {
  try {
    const t = sessionStorage.getItem(TOKEN_KEY);
    return t ? { authorization: `Bearer ${t}` } : {};
  } catch {
    return {};
  }
}

/**
 * The server refused the API for want of the bearer token. Off loopback the
 * token dies with the `scale serve` process, so a phone that kept the tab open
 * across a restart sees exactly this — and it must NOT look like an empty
 * repository. The shell shows a banner naming the fix (open the fresh URL).
 */
export class ApiAuthError extends Error {
  constructor(path: string) {
    super(`GET ${path} -> 401 (token missing or expired)`);
    this.name = 'ApiAuthError';
  }
}

let authFailed = false;
/** True once any API call was refused with 401 this page-load. */
export function apiAuthFailed(): boolean {
  return authFailed;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: 'application/json', ...authHeaders() } });
  if (res.status === 401) {
    authFailed = true;
    throw new ApiAuthError(path);
  }
  if (!res.ok) {
    throw new Error(`GET ${path} -> ${res.status}`);
  }
  return (await res.json()) as T;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    authFailed = true;
    throw new ApiAuthError(path);
  }
  if (!res.ok) {
    // Settings/keys writes surface the server's message verbatim (e.g. a schema
    // validation detail) — a bare status code isn't actionable in a form.
    let detail = '';
    try {
      const j = (await res.json()) as { error?: string };
      if (j?.error) detail = `: ${j.error}`;
    } catch {
      /* non-JSON body */
    }
    throw new Error(`POST ${path} -> ${res.status}${detail}`);
  }
  return (await res.json()) as T;
}

/**
 * Whether the bundled demo fixtures may stand in for live data.
 *
 * Vite replaces `import.meta.env.DEV` at build time, so a production bundle —
 * the one `scale serve` ships and the only one a study participant sees — has
 * this permanently false and the fixtures tree-shake away.
 */
const SAMPLE_FALLBACK_ALLOWED = import.meta.env.DEV;

let sampleActive = false;

/**
 * True once any loader has served demo fixtures. The shell renders a banner on
 * this: fabricated data must never be mistakable for the user's own repo.
 */
export function sampleDataActive(): boolean {
  return sampleActive;
}

/**
 * Announce a failed load. In a production build the error is rethrown by the
 * caller — showing invented data is worse than showing an error.
 */
function note(what: string, err: unknown): void {
  // eslint-disable-next-line no-console
  console.warn(`[SCALE] live ${what} unavailable.`, err);
}

/**
 * Guard every fixture fallback: allowed only in dev, and never silent.
 *
 * The fixtures arrive through a DYNAMIC import so they are not part of the main
 * bundle and are never fetched in a production build. Passing the data as an
 * argument instead would evaluate it eagerly and defeat that — the demo map
 * would ship to every participant, one edit away from being rendered.
 */
async function useSample<T>(what: string, err: unknown, load: () => Promise<T>): Promise<T> {
  note(what, err);
  if (!SAMPLE_FALLBACK_ALLOWED) throw err;
  sampleActive = true;
  return load();
}

/** GET /api/map -> MapJson. Falls back to the bundled sample map. */
export async function loadMap(): Promise<MapJson> {
  try {
    return await getJson<MapJson>('/api/map');
  } catch (err) {
    return useSample('map', err, async () => (await import('./sample/map.js')).sampleMap);
  }
}

/** GET /api/coverage -> UserCoverage. Falls back to the bundled sample coverage. */
export async function loadCoverage(): Promise<UserCoverage> {
  try {
    return await getJson<UserCoverage>('/api/coverage');
  } catch (err) {
    return useSample(
      'coverage',
      err,
      async () => (await import('./sample/coverage.js')).sampleCoverage,
    );
  }
}

/** The lock picture drawn over coverage — see GET /api/locks in serve.ts. */
export interface LocksResponse {
  unlocked: string[];
  drifted: Record<
    string,
    { at: string; sinceSha: string; foreignAuthors: string[]; cause: 'foreign' | 'self' }
  >;
  pendingUnlocks: Record<string, { at: string; sessionId: string }>;
}

/**
 * GET /api/locks. No sample fallback and no throw: a missing server means an
 * empty lock picture, which draws the map exactly as it did before locks existed.
 */
export async function loadLocks(): Promise<LocksResponse> {
  try {
    return await getJson<LocksResponse>('/api/locks');
  } catch {
    return { unlocked: [], drifted: {}, pendingUnlocks: {} };
  }
}

/**
 * GET /api/doc/:id -> { frontmatter, body }. Falls back to the bundled sample
 * doc for that id (or null if none is seeded).
 */
export async function loadDoc(id: string): Promise<DocResponse | null> {
  try {
    return await getJson<DocResponse>(`/api/doc/${encodeURIComponent(id)}`);
  } catch (err) {
    return useSample(`doc ${id}`, err, async () => {
      const s = (await import('./sample/docs.js')).sampleDocs[id];
      return s ? { frontmatter: s.frontmatter, body: s.body } : null;
    });
  }
}

/**
 * GET /api/quests -> Quest[]. Falls back to a couple bundled sample quests so
 * badges + the quest runner are demoable in standalone `vite dev` (§7.3).
 */
export async function loadQuests(): Promise<Quest[]> {
  try {
    return await getJson<Quest[]>('/api/quests');
  } catch (err) {
    return useSample('quests', err, async () => (await import('./sample/quests.js')).sampleQuests);
  }
}

// ---------------------------------------------------------------------------
// Settings (config.json + API keys)
// ---------------------------------------------------------------------------

/** Display-safe key status. The key itself NEVER crosses the API (cli/keys.ts). */
export interface ProviderKeyStatus {
  configured: boolean;
  /** 'env' → an environment variable is winning over any stored key. */
  source: 'env' | 'file' | null;
  /** Masked tail only, e.g. `sk-…9f2A`. */
  masked: string | null;
}
export type KeyStatusMap = Record<LlmProvider, ProviderKeyStatus>;

/** GET /api/settings payload. */
/** Which layer an effective config leaf came from (PLAN-GATE S4). */
export type ConfigSource = 'default' | 'policy' | 'user';
export interface LeafSource {
  value: unknown;
  source: ConfigSource;
  policyValue?: unknown;
  defaultValue: unknown;
}
export type SettingsSources = Record<string, LeafSource>;

export interface SettingsResponse {
  config: ScaleConfig;
  /** Whether a committed team policy (.scale/policy.json) is defaulting things. */
  policy?: { present: boolean; applied: boolean; error: string | null };
  /** Per-leaf provenance, keyed by dotted path (`gate.enforcement`). */
  sources?: SettingsSources;
  keys: KeyStatusMap;
  repoId: string;
  stateDir: string;
}

/**
 * Partial config accepted by POST /api/settings. The server deep-merges each
 * patched section into the user's SPARSE overrides file and validates the
 * effective result — so every edit here becomes a personal override on top of
 * any committed team policy (PLAN-GATE §2).
 */
export interface SettingsPatch {
  user?: string;
  language?: 'en' | 'ko';
  gate?: Partial<ScaleConfig['gate']>;
  unlock?: Partial<ScaleConfig['unlock']>;
  exempt?: Partial<ScaleConfig['exempt']>;
  drift?: Partial<ScaleConfig['drift']>;
  budgets?: Partial<ScaleConfig['budgets']>;
  thresholds?: Partial<ScaleConfig['thresholds']>;
  models?: Partial<ScaleConfig['models']>;
}

/**
 * GET /api/settings. Unlike the map/coverage loaders this does NOT fall back to
 * sample data: settings are only meaningful against a live server, and silently
 * showing editable-looking defaults that can't be saved would be a lie.
 */
export async function loadSettings(): Promise<SettingsResponse> {
  return getJson<SettingsResponse>('/api/settings');
}

export interface SaveResponse {
  config: ScaleConfig;
  keys: KeyStatusMap;
  sources?: SettingsSources;
}

/** POST /api/settings — merge a partial config, validate, persist. */
export async function saveSettings(patch: SettingsPatch): Promise<SaveResponse> {
  return postJson<SaveResponse>('/api/settings', patch);
}

/**
 * POST /api/settings/unset — drop one personal override so the team default
 * (or the schema default) applies again.
 */
export async function unsetSetting(path: string): Promise<SaveResponse> {
  return postJson<SaveResponse>('/api/settings/unset', { path });
}

/**
 * POST /api/keys — store one provider's key (empty string clears it). The reply
 * carries only the masked status; nothing here ever holds the key after the
 * request, and the form field is cleared by the caller.
 */
export async function saveKey(provider: LlmProvider, key: string): Promise<KeyStatusMap> {
  const r = await postJson<{ keys: KeyStatusMap }>('/api/keys', { provider, key });
  return r.keys;
}

// ---------------------------------------------------------------------------
// Quest runner mutations (POST). Live via `scale serve`; each helper degrades
// to a plausible local synthesis on fetch failure so the runner still animates
// in standalone dev with no backend.
// ---------------------------------------------------------------------------

/** One per-dim grade sent to POST /api/quests/:id/complete. */
export interface DimResult {
  dim: DimName;
  score: number;
}

/** One item's answer key, returned only in the completion response. */
export interface ItemReveal {
  correctIndex: number;
  answer: string;
  explanation?: string;
  correct: boolean;
}

/** Response of POST /api/quests/:id/complete (quiz). */
export interface CompleteResponse {
  componentId: string;
  recorded: number;
  quest: { id: string; status: string };
  component: ComponentCoverage;
  /** The key, revealed by the server now that the picks are in. */
  reveal: ItemReveal[];
}

/** Response of POST /api/socratic/:id/message. */
export interface SocraticResponse {
  reply: string | null;
  done: boolean;
  error?: string;
  /** Set when the failure was a missing API key → offer Settings directly. */
  needsKey?: LlmProvider;
  grades?: Record<DimName, number>;
  componentId?: string;
  component?: ComponentCoverage;
}

const OFFLINE_START = 0.15;

/** EMA the coverage model applies (§5.1: dim ← 0.7·dim + 0.3·score). */
function ema(prev: number, score: number): number {
  return Math.round((0.7 * prev + 0.3 * score) * 1000) / 1000;
}

/** Local stand-in ComponentCoverage from per-dim results (offline demo only). */
function synthComponent(results: DimResult[]): ComponentCoverage {
  const dims = { structure: OFFLINE_START, concepts: OFFLINE_START, rationale: OFFLINE_START };
  for (const r of results) dims[r.dim] = ema(dims[r.dim], r.score);
  const mean = (dims.structure + dims.concepts + dims.rationale) / 3;
  return {
    state: mean >= 0.6 ? 'validated' : 'explored',
    dims,
    lastValidatedSha: mean >= 0.6 ? 'localdemo' : null,
    loyalty: 1,
    driftCause: null,
    driftAuthors: [],
  };
}

// Localized copy for the OFFLINE synthesizers below. Live-server paths never
// read these — the server writes its own text in the configured language. Kept
// here (not i18n.ts) because they are canned CONTENT, not UI chrome; concept
// names stay English either way (code references, per the language contract).
const OFFLINE_MCQ: Record<
  Language,
  { prompt: (name: string) => string; distractors: [string, string, string] }
> = {
  en: {
    prompt: (name) => `Which best describes “${name}” in this component?`,
    distractors: [
      'An unrelated caching layer',
      'A build-time code generator',
      'A logging side effect',
    ],
  },
  ko: {
    prompt: (name) => `이 컴포넌트에서 “${name}”을(를) 가장 잘 설명한 것은?`,
    distractors: ['무관한 캐싱 레이어', '빌드 타임 코드 생성기', '로깅 부수 효과'],
  },
};

/**
 * POST /api/quests — create a VOLUNTARY quest for a component on demand: the
 * map's Challenge button (§6.3). Works in every condition; the server falls back
 * to deterministic doc-grounded items when there's no API key. Offline (vite
 * dev with no backend) we synthesize a small quest from the sample doc — in
 * the caller's interaction `language` — so the runner still opens. Returns null
 * only when nothing could be prepared.
 */
export async function createVoluntaryQuest(
  componentId: string,
  language: Language,
): Promise<Quest | null> {
  try {
    const r = await postJson<{ quest: Quest }>('/api/quests', { componentId });
    return r.quest ?? null;
  } catch (err) {
    // Same rule as every other fixture path: a production build must fail rather
    // than hand the learner an invented quiz whose score it cannot record.
    note(`voluntary quest for ${componentId}`, err);
    if (!SAMPLE_FALLBACK_ALLOWED) throw err;
    sampleActive = true;
    const doc = (await import('./sample/docs.js')).sampleDocs[componentId];
    const concepts = doc?.frontmatter.concepts ?? [];
    const t = OFFLINE_MCQ[language];
    const items = concepts.slice(0, 2).map((c, i) => {
      const opts = [c.name, ...t.distractors];
      // Rotate so the answer isn't always 'A', and emit BOTH `answer` (text) and
      // `correctIndex` — the runner grades on correctIndex (mirrors mcqItem).
      const shift = (c.name.length + i) % 4;
      const rotated = opts.map((_, k) => opts[(k + shift) % 4]!);
      const correctIndex = (4 - shift) % 4;
      return {
        prompt: t.prompt(c.name),
        dim: (i === 0 ? 'concepts' : 'rationale') as DimName,
        options: rotated,
        answer: rotated[correctIndex],
        correctIndex,
      };
    });
    if (items.length === 0) return null;
    return {
      id: `local-${componentId}-${items.length}`,
      componentId,
      modality: 'quiz',
      items,
      origin: 'voluntary',
      status: 'pending',
    } as Quest;
  }
}

/**
 * POST /api/quests/:id/complete — record per-dim quiz results, mark the quest
 * completed, return the updated component coverage. Offline: synthesize it.
 */
export async function completeQuiz(
  questId: string,
  picks: (number | null)[],
): Promise<CompleteResponse | null> {
  try {
    // Send WHICH OPTION, never a score: the server owns the answer key and the
    // grading, because a passed check now unlocks territory.
    return await postJson<CompleteResponse>(
      `/api/quests/${encodeURIComponent(questId)}/complete`,
      { picks },
    );
  } catch (err) {
    // Deliberately NOT faked. This used to synthesize a component and render a
    // full "Territory taken" card while nothing had been written — the map then
    // silently contradicted the card. It is also now impossible: grading lives
    // on the server, so an unreachable server means there is no result to show.
    note(`quest ${questId} complete`, err);
    return null;
  }
}

/** Canned offline Socratic turns (same live-vs-offline split as OFFLINE_MCQ). */
const OFFLINE_SOCRATIC: Record<Language, { probes: [string, string]; close: string }> = {
  en: {
    probes: [
      'Interesting — and what would go wrong if that check were skipped on a later request?',
      'Good. Now trace it one more step: who is responsible for enforcing that, and when?',
    ],
    close:
      'That gives me a solid sense of your understanding — you connected the access check to revocation. Well reasoned.',
  },
  ko: {
    probes: [
      '흥미롭군요 — 이후 요청에서 그 검사를 건너뛰면 무엇이 잘못될까요?',
      '좋습니다. 한 단계만 더 따라가 보죠: 그것을 강제하는 책임은 누구에게, 언제 있나요?',
    ],
    close:
      '이해도를 충분히 파악했습니다 — 접근 검사와 권한 회수를 연결해 냈군요. 훌륭한 추론입니다.',
  },
};

/**
 * POST /api/socratic/:id/message — one learner turn of the server-proxied
 * dialogue. `userTurn` (1-based) and `language` drive ONLY the offline
 * synthesis; live mode ignores both and follows the server's `done` flag /
 * 3-exchange cap (the server speaks the configured language itself).
 */
export async function sendSocraticMessage(
  questId: string,
  message: string,
  userTurn: number,
  language: Language,
): Promise<SocraticResponse> {
  try {
    return await postJson<SocraticResponse>(
      `/api/socratic/${encodeURIComponent(questId)}/message`,
      { message },
    );
  } catch (err) {
    note(`socratic ${questId}`, err);
    const t = OFFLINE_SOCRATIC[language];
    // Offline demo: 2 probing turns, then a graded close on the 3rd.
    if (userTurn < 3) {
      return { reply: t.probes[userTurn - 1] ?? t.probes[0], done: false };
    }
    const grades: Record<DimName, number> = { structure: 0.5, concepts: 0.7, rationale: 0.6 };
    return {
      reply: t.close,
      done: true,
      grades,
      componentId: '',
      component: synthComponent([
        { dim: 'structure', score: grades.structure },
        { dim: 'concepts', score: grades.concepts },
        { dim: 'rationale', score: grades.rationale },
      ]),
    };
  }
}
