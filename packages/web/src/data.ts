import type {
  MapJson,
  UserCoverage,
  PaperFrontmatter,
  Quest,
  ComponentCoverage,
  DimName,
} from '@scale/core/browser';
import { sampleMap } from './sample/map.js';
import { sampleCoverage } from './sample/coverage.js';
import { samplePapers } from './sample/papers.js';
import { sampleQuests } from './sample/quests.js';

/**
 * Data layer (PLAN §7.3). The viewer normally reads LIVE data from the
 * `scale serve` HTTP API — the user's OWN repo map — via same-origin relative
 * URLs (`/api/...`). In production the app is served BY `scale serve`, so the
 * relative fetch just works; in `vite dev` a proxy (vite.config.ts) forwards
 * `/api/*` to the serve port.
 *
 * On ANY fetch failure (e.g. running `vite dev` with no server up) each loader
 * FALLS BACK to the bundled hand-seeded sample data, so the UI still renders
 * for standalone dev. A console note is logged when that happens.
 */

/** Shape returned by GET /api/paper/:id (frontmatter + markdown body). */
export interface PaperResponse {
  frontmatter: PaperFrontmatter;
  body: string;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`GET ${path} -> ${res.status}`);
  }
  return (await res.json()) as T;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`POST ${path} -> ${res.status}`);
  }
  return (await res.json()) as T;
}

function note(what: string, err: unknown): void {
  // eslint-disable-next-line no-console
  console.warn(
    `[SCALE] live ${what} unavailable, falling back to bundled sample data.`,
    err,
  );
}

/** GET /api/map -> MapJson. Falls back to the bundled sample map. */
export async function loadMap(): Promise<MapJson> {
  try {
    return await getJson<MapJson>('/api/map');
  } catch (err) {
    note('map', err);
    return sampleMap;
  }
}

/** GET /api/coverage -> UserCoverage. Falls back to the bundled sample coverage. */
export async function loadCoverage(): Promise<UserCoverage> {
  try {
    return await getJson<UserCoverage>('/api/coverage');
  } catch (err) {
    note('coverage', err);
    return sampleCoverage;
  }
}

/**
 * GET /api/paper/:id -> { frontmatter, body }. Falls back to the bundled sample
 * paper for that id (or null if none is seeded).
 */
export async function loadPaper(id: string): Promise<PaperResponse | null> {
  try {
    return await getJson<PaperResponse>(`/api/paper/${encodeURIComponent(id)}`);
  } catch (err) {
    note(`paper ${id}`, err);
    const s = samplePapers[id];
    return s ? { frontmatter: s.frontmatter, body: s.body } : null;
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
    note('quests', err);
    return sampleQuests;
  }
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

/** Response of POST /api/quests/:id/complete (quiz). */
export interface CompleteResponse {
  componentId: string;
  recorded: number;
  quest: { id: string; status: string };
  component: ComponentCoverage;
}

/** Response of POST /api/socratic/:id/message. */
export interface SocraticResponse {
  reply: string | null;
  done: boolean;
  error?: string;
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
  };
}

/**
 * POST /api/quests/:id/complete — record per-dim quiz results, mark the quest
 * completed, return the updated component coverage. Offline: synthesize it.
 */
export async function completeQuiz(
  questId: string,
  results: DimResult[],
): Promise<CompleteResponse> {
  try {
    return await postJson<CompleteResponse>(
      `/api/quests/${encodeURIComponent(questId)}/complete`,
      { results },
    );
  } catch (err) {
    note(`quest ${questId} complete`, err);
    return {
      componentId: '',
      recorded: results.length,
      quest: { id: questId, status: 'completed' },
      component: synthComponent(results),
    };
  }
}

/**
 * POST /api/socratic/:id/message — one learner turn of the server-proxied
 * dialogue. `userTurn` (1-based) drives ONLY the offline synthesis; live mode
 * ignores it and follows the server's `done` flag / 3-exchange cap.
 */
export async function sendSocraticMessage(
  questId: string,
  message: string,
  userTurn: number,
): Promise<SocraticResponse> {
  try {
    return await postJson<SocraticResponse>(
      `/api/socratic/${encodeURIComponent(questId)}/message`,
      { message },
    );
  } catch (err) {
    note(`socratic ${questId}`, err);
    // Offline demo: 2 probing turns, then a graded close on the 3rd.
    if (userTurn < 3) {
      const probes = [
        'Interesting — and what would go wrong if that check were skipped on a later request?',
        'Good. Now trace it one more step: who is responsible for enforcing that, and when?',
      ];
      return { reply: probes[userTurn - 1] ?? probes[0]!, done: false };
    }
    const grades: Record<DimName, number> = { structure: 0.5, concepts: 0.7, rationale: 0.6 };
    return {
      reply:
        'That gives me a solid sense of your understanding — you connected the access check to revocation. Well reasoned.',
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
