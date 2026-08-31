/**
 * `scale quest generate` — the post-session quest pipeline (PLAN §6.2).
 *
 * Runs DETACHED off the SessionEnd hook, so it may call the Claude API (cheap
 * INTERVENTION-tier model) but must NEVER throw fatally: everything is wrapped so
 * a bad paper, missing key, or API error degrades to a deterministic fallback
 * that still produces a valid quests.json.
 *
 * Model policy (fixed): quest generation is an INTERVENTION, so it runs on the
 * configured intervention model (Sonnet 5 or Haiku 4.5) — NEVER a build-tier
 * (Opus/Fable) model. The concrete id comes from core's `resolveModelId`.
 *
 * Selection (§6.2): top-K (default 3) components by
 *   (touched this session) × (low coverage OR stale) × importance.
 * Falls back to the K lowest-coverage components when session info is thin.
 *
 * Only post-session conditions generate quests; in in-flow conditions this is a
 * no-op (stale territory surfaces through the map + re-encounter gates instead).
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

import {
  type ScaleConfig,
  type Language,
  type LoadedScale,
  type LoadedPaper,
  type UserCoverage,
  type ComponentCoverage,
  type MapJson,
  type Quest,
  type QuestItem,
  type QuestModality,
  type DimName,
  QuestSchema,
  ScaleConfigSchema,
  loadScaleDir,
  paperById,
  emptyComponentCoverage,
  meanDims,
  resolveInterventionModel,
  type LlmProvider,
} from '@scale/core';

import {
  stateDir,
  paths,
  ensureStateDir,
  appendEvidence,
  readConfigSafe,
  readQuestsSafe,
  readSessionSafe,
} from './state.js';
import { recomputeCoverageFromDisk } from './coverage.js';
import { chatText, MissingKeyError } from './llm.js';

/** Default number of quests generated per post-session run (PLAN §6.2). */
export const DEFAULT_TOP_K = 3;

export interface QuestGenResult {
  /** 'llm' when the configured model produced every quest; 'fallback' when all
   *  were synthesized deterministically; 'mixed' when some of each — reporting
   *  'llm' for a partly-synthesized batch hid that a transient API failure had
   *  silently downgraded the rest; 'skip' when the condition is in-flow. */
  via: 'llm' | 'fallback' | 'mixed' | 'skip';
  /** The resolved intervention model id used (or attempted). */
  model: string;
  /** Number of quests written. */
  count: number;
  /** Path to the quests.json written (or the path that would be written). */
  path: string;
  /** Component ids the quests target. */
  components: string[];
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

/**
 * Component ids touched (touch/prompt evidence) at or after `sinceIso`. Reads
 * evidence.jsonl directly and skips malformed lines. Empty `sinceIso` → [].
 */
function touchedComponentsSince(dir: string, sinceIso: string): Set<string> {
  const out = new Set<string>();
  if (!sinceIso) return out;
  const cutoff = Date.parse(sinceIso);
  if (!Number.isFinite(cutoff)) return out;
  let text: string;
  try {
    text = fs.readFileSync(paths.evidence(dir), 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (e.type !== 'touch' && e.type !== 'prompt') continue;
    const ts = typeof e.ts === 'string' ? Date.parse(e.ts) : NaN;
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    const ids = Array.isArray(e.componentIds) ? e.componentIds : [];
    for (const id of ids) if (typeof id === 'string') out.add(id);
  }
  return out;
}

interface Scored {
  id: string;
  importance: number;
  mean: number;
  state: string;
  touched: boolean;
  lowCoverage: boolean;
}

/**
 * Pick the top-K components to quiz (PLAN §6.2). Primary: touched-this-session ∩
 * (low-coverage OR stale), ranked by importance × comprehension-gap. Fallback
 * (thin session / no candidates): the K lowest-coverage components overall.
 */
export function pickComponents(
  coverage: UserCoverage,
  map: MapJson,
  touched: Set<string>,
  config: ScaleConfig,
  k: number,
): string[] {
  const validateDim = config.thresholds.validateDim;
  const scored: Scored[] = map.nodes.map((n) => {
    const comp = coverage.components[n.id] ?? emptyComponentCoverage();
    const mean = meanDims(comp.dims);
    const lowCoverage =
      comp.state === 'fog' ||
      comp.state === 'explored' ||
      comp.state === 'stale' ||
      mean < validateDim;
    return {
      id: n.id,
      importance: n.importance,
      mean,
      state: comp.state,
      touched: touched.has(n.id),
      lowCoverage,
    };
  });

  const gap = (s: Scored): number => Math.max(0, 1 - s.mean) + (s.state === 'stale' ? 0.25 : 0);

  const primary = scored
    .filter((s) => s.touched && s.lowCoverage)
    .sort((a, b) => b.importance * gap(b) - a.importance * gap(a));

  if (primary.length > 0) return primary.slice(0, k).map((s) => s.id);

  // Fallback: K lowest-coverage components overall (importance breaks ties).
  return [...scored]
    .sort((a, b) => a.mean - b.mean || b.importance - a.importance)
    .slice(0, k)
    .map((s) => s.id);
}

// ---------------------------------------------------------------------------
// Grounding — paper → prompt context
// ---------------------------------------------------------------------------

function groundingText(paper: LoadedPaper): string {
  const fm = paper.frontmatter;
  const concepts = fm.concepts.map((c) => `- ${c.name} (id: ${c.id})`).join('\n') || '- (none)';
  const rationale =
    fm.rationale
      .map((r) => {
        const bits = [`decision: ${r.decision}`];
        if (r.why) bits.push(`why: ${r.why}`);
        if (r.alternatives) bits.push(`alternatives: ${r.alternatives}`);
        return `- ${bits.join(' | ')}`;
      })
      .join('\n') || '- (none)';
  return `Component: ${fm.title} (id: ${fm.id})\n\nConcepts:\n${concepts}\n\nRationale:\n${rationale}`;
}

// ---------------------------------------------------------------------------
// LLM item generation (INTERVENTION model — Sonnet/Haiku only)
// ---------------------------------------------------------------------------

/** Strip ```json fences and parse. Throws on failure (caller falls back). */
function parseJsonLoose(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = (fenced?.[1] ?? text).trim();
  return JSON.parse(body);
}

const DIMS: DimName[] = ['structure', 'concepts', 'rationale'];
function asDim(v: unknown, fallback: DimName): DimName {
  return typeof v === 'string' && (DIMS as string[]).includes(v) ? (v as DimName) : fallback;
}

/**
 * Appended to the LLM system prompts when the junior's interaction language is
 * 'ko': learner-facing strings come back Korean, code identifiers and the JSON
 * shape stay untouched (contract in LanguageSchema, schema/config.ts).
 */
const KO_ITEM_INSTRUCTION =
  ' Write every learner-facing string (question prompts, options, seed questions, ' +
  'feedback) in Korean. Keep code identifiers, file paths, function/variable names, ' +
  'and established technical terms in English. The JSON structure and its keys stay ' +
  'exactly as specified.';

async function llmQuizItems(
  provider: LlmProvider,
  model: string,
  paper: LoadedPaper,
  language: Language = 'en',
): Promise<QuestItem[]> {
  const text = await chatText({
    provider,
    model,
    maxTokens: 1024,
    system:
      'You write multiple-choice comprehension items for a code-onboarding tutor. ' +
      'Ground every item strictly in the provided component paper (its concepts and ' +
      'rationale). Each item tags the comprehension dimension it probes: "structure" ' +
      '(how the component is built), "concepts" (its named ideas), or "rationale" ' +
      '(why it was designed that way). Return ONLY JSON, no prose.' +
      (language === 'ko' ? KO_ITEM_INSTRUCTION : ''),
    messages: [
      {
        role: 'user',
        content:
          `${groundingText(paper)}\n\n` +
          'Write exactly 2 multiple-choice items. Return JSON of the form:\n' +
          '{"items":[{"stem":"...","options":["A","B","C","D"],"correctIndex":0,"dim":"concepts"}]}\n' +
          'Rules: exactly 4 options each; correctIndex is 0-3; the correct option must be ' +
          'faithful to the paper; distractors plausible but wrong; prefer one "concepts" ' +
          'item and one "rationale" item.',
      },
    ],
  });
  const parsed = parseJsonLoose(text) as { items?: unknown };
  const rawItems = Array.isArray(parsed) ? parsed : Array.isArray(parsed.items) ? parsed.items : [];
  const items: QuestItem[] = [];
  for (const raw of rawItems as Record<string, unknown>[]) {
    const stem = typeof raw.stem === 'string' ? raw.stem : null;
    const options = Array.isArray(raw.options)
      ? raw.options.filter((o): o is string => typeof o === 'string')
      : [];
    if (!stem || options.length !== 4) continue;
    // A malformed index must DROP the item, never default to 0. Defaulting
    // silently makes option A the key: `"2"` (string) and `4` (1-indexed) both
    // used to land there, so the junior was graded against an answer the model
    // never chose, and `2.5` passed the range check and indexed to `undefined`.
    // Dropping is the same policy the `options.length !== 4` guard above uses,
    // and an item short of two is caught by the throw below.
    const correctIndex = raw.correctIndex;
    if (
      typeof correctIndex !== 'number' ||
      !Number.isInteger(correctIndex) ||
      correctIndex < 0 ||
      correctIndex > 3
    ) {
      continue;
    }
    items.push({
      prompt: stem,
      options,
      answer: options[correctIndex]!,
      correctIndex,
      dim: asDim(raw.dim, 'concepts'),
    });
  }
  if (items.length === 0) throw new Error('llm quiz produced no valid items');
  return items.slice(0, 2);
}

async function llmSocraticItems(
  provider: LlmProvider,
  model: string,
  paper: LoadedPaper,
  language: Language = 'en',
): Promise<QuestItem[]> {
  const text = await chatText({
    provider,
    model,
    maxTokens: 512,
    system:
      'You open a Socratic comprehension dialogue for a code-onboarding tutor. ' +
      'Ground the opening question strictly in the provided component paper. Do not ' +
      'reveal answers. Return ONLY JSON, no prose.' +
      (language === 'ko' ? KO_ITEM_INSTRUCTION : ''),
    messages: [
      {
        role: 'user',
        content:
          `${groundingText(paper)}\n\n` +
          'Return JSON of the form:\n' +
          '{"seedQuestion":"...","focus":"one sentence naming the concept/rationale to probe"}\n' +
          'The seedQuestion should invite the learner to explain how this component works ' +
          'and why, in their own words.',
      },
    ],
  });
  const parsed = parseJsonLoose(text) as Record<string, unknown>;
  const seed = typeof parsed.seedQuestion === 'string' ? parsed.seedQuestion : null;
  if (!seed) throw new Error('llm socratic produced no seed question');
  const focus = typeof parsed.focus === 'string' ? parsed.focus : '';
  return [{ prompt: seed, dim: 'concepts', focus }];
}

// ---------------------------------------------------------------------------
// Deterministic fallback — synthesize valid items from the paper (offline-safe)
// ---------------------------------------------------------------------------

/**
 * Generic filler distractors per interaction language. Established technical
 * terms (e.g. "deprecated") stay English inside the Korean strings.
 */
const GENERIC_DISTRACTORS: Record<Language, string[]> = {
  en: [
    'None of the above',
    'It is unrelated to this component',
    'It is handled by an external service',
    'It is deprecated and no longer used',
  ],
  ko: [
    '위의 어느 것도 아니다',
    '이 컴포넌트와 관련이 없다',
    '외부 서비스가 처리한다',
    '더 이상 사용되지 않는(deprecated) 기능이다',
  ],
};

/** FNV-1a over a string — a small deterministic hash for stable pool rotation. */
function hashKey(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Choose up to `n` distractors from `pool`, deterministically but DIFFERENTLY
 * per component.
 *
 * The pool is every other component's concepts (or rationale) in paper-load
 * order, and taking `slice(0, 3)` from it handed 36 of the 37 components a
 * byte-identical set of options — two distinct distractor sets across the whole
 * repo. That does not just make items easy; it makes the correct answer findable
 * as the odd one out without reading anything, while the score is still recorded
 * as an active validation. Rotating by a hash of the component id keeps the
 * output reproducible (same paper set → same items) while making the options
 * actually vary.
 *
 * `correct` is excluded so an item can never offer the answer twice — one of
 * them keyed right and one keyed wrong.
 */
function pickDistractors(
  pool: string[],
  correct: string,
  n: number,
  seedKey: string,
): string[] {
  const seen = new Set<string>([correct]);
  const unique: string[] = [];
  for (const candidate of pool) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    unique.push(candidate);
  }
  if (unique.length === 0) return [];

  const start = hashKey(seedKey) % unique.length;
  const out: string[] = [];
  for (let i = 0; i < unique.length && out.length < n; i++) {
    out.push(unique[(start + i) % unique.length]!);
  }
  return out;
}

/**
 * Pad `pool` to `n` with generic fillers, never repeating `correct`. Generic
 * fillers are a last resort — they are recognizably not-an-answer, so an item
 * that needs them is already weak.
 */
function padDistractors(
  pool: string[],
  n: number,
  language: Language = 'en',
  correct?: string,
): string[] {
  const generic = GENERIC_DISTRACTORS[language];
  const out = [...pool];
  for (const g of generic) {
    if (out.length >= n) break;
    if (!out.includes(g) && g !== correct) out.push(g);
  }
  return out.slice(0, n);
}

/** Build one MCQ item with `correct` as option A shuffled deterministically. */
function mcqItem(
  stem: string,
  correct: string,
  distractors: string[],
  dim: DimName,
  language: Language = 'en',
): QuestItem {
  const opts = [correct, ...padDistractors(distractors, 3, language, correct)].slice(0, 4);
  // Deterministic rotation so the answer isn't always 'A' (seed off the stem).
  // ko and en stems differ in length, so the rotation may differ per language —
  // fine: `answer`/`correctIndex` are derived together and stay consistent.
  const shift = stem.length % 4;
  const rotated = opts.map((_, i) => opts[(i + shift) % 4]!);
  const correctIndex = (4 - shift) % 4;
  return {
    prompt: stem,
    options: rotated,
    answer: rotated[correctIndex],
    correctIndex,
    dim,
  };
}

export function deterministicQuizItems(
  paper: LoadedPaper,
  loaded: LoadedScale,
  language: Language = 'en',
): QuestItem[] {
  const fm = paper.frontmatter;
  const ko = language === 'ko';
  const items: QuestItem[] = [];

  // Distractor pools drawn from OTHER components (grounded but wrong-for-this).
  const otherConcepts: string[] = [];
  const otherWhys: string[] = [];
  for (const p of loaded.papers) {
    if (p.id === fm.id) continue;
    for (const c of p.frontmatter.concepts) otherConcepts.push(c.name);
    for (const r of p.frontmatter.rationale) if (r.why) otherWhys.push(r.why);
  }

  // Item 1 (concepts): "which concept belongs to this component".
  // Stems are per-language templates; embedded titles/concept names come from
  // the (always-English) papers and stay English in the Korean stems.
  if (fm.concepts.length > 0) {
    const c = fm.concepts[0]!;
    items.push(
      mcqItem(
        ko
          ? `다음 중 "${fm.title}"의 핵심 개념은 무엇인가요?`
          : `Which of these is a core concept of "${fm.title}"?`,
        c.name,
        pickDistractors(otherConcepts, c.name, 3, `${fm.id}:concepts`),
        'concepts',
        language,
      ),
    );
  }

  // Item 2 (rationale): "why was this decision made".
  const r = fm.rationale.find((e) => e.why);
  if (r && r.why) {
    items.push(
      mcqItem(
        ko
          ? `"${fm.title}"에서 "${r.decision}"라는 결정은 왜 내려졌을까요?`
          : `In "${fm.title}", why was this decision made — "${r.decision}"?`,
        r.why,
        pickDistractors(otherWhys, r.why, 3, `${fm.id}:rationale`),
        'rationale',
        language,
      ),
    );
  }

  // Guarantee 2 items even for a thin paper: fall back to a structure item over
  // the component's sources / a second concept.
  while (items.length < 2) {
    if (fm.concepts.length > items.length) {
      const c = fm.concepts[items.length]!;
      items.push(
        mcqItem(
          ko ? `"${fm.title}"가 다루는 개념은 무엇인가요?` : `Which idea does "${fm.title}" cover?`,
          c.name,
          pickDistractors(otherConcepts, c.name, 3, `${fm.id}:concepts2`),
          'concepts',
          language,
        ),
      );
    } else {
      const src = fm.sources[0] ?? fm.title;
      items.push(
        mcqItem(
          ko
            ? `"${fm.title}"가 담당하는 코드베이스 영역은 어디인가요?`
            : `Which area of the codebase does "${fm.title}" own?`,
          src,
          ko
            ? ['관련 없는 모듈', '빌드 시스템', '서드파티 의존성']
            : ['An unrelated module', 'The build system', 'Third-party dependencies'],
          'structure',
          language,
        ),
      );
    }
  }

  return items.slice(0, 2);
}

export function deterministicSocraticItems(
  paper: LoadedPaper,
  language: Language = 'en',
): QuestItem[] {
  const fm = paper.frontmatter;
  const firstConcept = fm.concepts[0]?.name ?? fm.title;
  const firstRationale = fm.rationale.find((r) => r.why);
  // `focus` is tutor-facing grounding metadata, not shown to the junior — English.
  const focusBits = [`concept: ${firstConcept}`];
  if (firstRationale) focusBits.push(`rationale: ${firstRationale.decision}`);
  const seed =
    language === 'ko'
      ? `"${fm.title}"가 어떻게 동작하는지, 왜 그렇게 설계되었는지 설명해 주세요. ` +
        `${firstConcept}부터 시작해 보세요.`
      : `Walk me through how "${fm.title}" works and why it is designed that way. ` +
        `Start with ${firstConcept}.`;
  return [{ prompt: seed, dim: 'concepts', focus: focusBits.join(' | ') }];
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function makeQuest(
  componentId: string,
  modality: QuestModality,
  items: QuestItem[],
  origin: Quest['origin'] = 'session',
): Quest {
  return QuestSchema.parse({
    id: crypto.randomUUID(),
    componentId,
    modality,
    items,
    origin,
    status: 'pending',
  });
}

/**
 * Generate post-session quests for the repo at `cwd`. Detached-safe: catches its
 * own errors and always resolves. Writes ~/.scale/<repo-id>/quests.json.
 */
export async function generateQuests(
  cwd: string,
  opts: { topK?: number } = {},
): Promise<QuestGenResult> {
  const dir = stateDir(cwd);
  const config: ScaleConfig =
    readConfigSafe(dir) ?? ScaleConfigSchema.parse({ user: process.env.USER ?? 'user' });
  const provider = config.models.provider;
  const model = resolveInterventionModel(config.models);
  const questsPath = paths.quests(dir);

  // In-flow conditions never generate quests (PLAN §6.2).
  if (config.condition.timing !== 'postsession') {
    return { via: 'skip', model, count: 0, path: questsPath, components: [] };
  }

  const loaded = loadScaleDir(cwd);
  if (loaded.papers.length === 0) {
    return { via: 'skip', model, count: 0, path: questsPath, components: [] };
  }

  const { coverage, map } = recomputeCoverageFromDisk(cwd);
  const session = readSessionSafe(dir);
  const touched = touchedComponentsSince(dir, session?.startedAt ?? '');
  const k = opts.topK ?? DEFAULT_TOP_K;
  const picked = pickComponents(coverage, map, touched, config, k);
  const modality = config.condition.modality;

  // Try the LLM path once; on any failure (no key, API error) latch to the
  // deterministic fallback for every remaining component.
  let llmDisabled = false;
  let usedLlm = false;
  let usedFallback = false;

  const quests: Quest[] = [];
  for (const componentId of picked) {
    const paper = paperById(loaded, componentId);
    if (!paper) continue;

    let items: QuestItem[] | null = null;
    if (!llmDisabled) {
      try {
        items =
          modality === 'quiz'
            ? await llmQuizItems(provider, model, paper, config.language)
            : await llmSocraticItems(provider, model, paper, config.language);
        usedLlm = true;
      } catch (err) {
        // Only a MISSING KEY is permanent — retrying it K times is pure latency
        // for a guaranteed failure, so latch and synthesize the rest. Everything
        // else (a 429, a socket reset, one unparseable reply) is per-request:
        // latching on those let a single transient error downgrade the whole
        // batch to the deterministic fallback, which is the weakest path here.
        if (err instanceof MissingKeyError) llmDisabled = true;
        usedFallback = true;
        items = null;
      }
    }
    if (!items) {
      usedFallback = true;
      items =
        modality === 'quiz'
          ? deterministicQuizItems(paper, loaded, config.language)
          : deterministicSocraticItems(paper, config.language);
    }
    quests.push(makeQuest(componentId, modality, items));
  }

  // Merge: keep completed/other-origin quests; replace pending session quests.
  const existing = readQuestsSafe(dir).filter(
    (q) => !(q.origin === 'session' && q.status === 'pending'),
  );
  const merged = [...existing, ...quests];

  ensureStateDir(dir);
  fs.writeFileSync(questsPath, JSON.stringify(merged, null, 2) + '\n');

  return {
    via: usedLlm ? (usedFallback ? 'mixed' : 'llm') : 'fallback',
    model,
    count: quests.length,
    path: questsPath,
    components: quests.map((q) => q.componentId),
  };
}

/**
 * Generate a VOLUNTARY quest on demand for ONE component — the map's Challenge
 * button (PLAN §6.3).
 *
 * Unlike `generateQuests` this is deliberately NOT gated on the post-session
 * condition: voluntary learning is available in EVERY condition and spends no
 * interruption budget — it is the junior's own initiative. Tries the configured
 * INTERVENTION model, falls back to deterministic paper-grounded items when
 * there is no API key (so the button always works offline).
 *
 * Returns null when the component has no paper in `.scale/`.
 */
export async function generateVoluntaryQuest(
  cwd: string,
  componentId: string,
): Promise<{ quest: Quest; via: 'llm' | 'fallback'; model: string } | null> {
  const dir = stateDir(cwd);
  const config: ScaleConfig =
    readConfigSafe(dir) ?? ScaleConfigSchema.parse({ user: process.env.USER ?? 'user' });
  const provider = config.models.provider;
  const model = resolveInterventionModel(config.models);

  const loaded = loadScaleDir(cwd);
  const paper = paperById(loaded, componentId);
  if (!paper) return null;

  const modality = config.condition.modality;
  let items: QuestItem[] | null = null;
  let via: 'llm' | 'fallback' = 'fallback';
  try {
    items =
      modality === 'quiz'
        ? await llmQuizItems(provider, model, paper, config.language)
        : await llmSocraticItems(provider, model, paper, config.language);
    via = 'llm';
  } catch {
    items = null; // no key / API error → deterministic fallback below
  }
  if (!items || items.length === 0) {
    items =
      modality === 'quiz'
        ? deterministicQuizItems(paper, loaded, config.language)
        : deterministicSocraticItems(paper, config.language);
    via = 'fallback';
  }

  const quest = makeQuest(componentId, modality, items, 'voluntary');
  // Replace a prior PENDING voluntary quest for this same component so repeated
  // Challenge clicks don't pile up; keep everything else (session/completed).
  const existing = readQuestsSafe(dir).filter(
    (q) => !(q.origin === 'voluntary' && q.status === 'pending' && q.componentId === componentId),
  );
  ensureStateDir(dir);
  fs.writeFileSync(paths.quests(dir), JSON.stringify([...existing, quest], null, 2) + '\n');

  return { quest, via, model };
}

// ---------------------------------------------------------------------------
// Quest completion — the shared record → mark → recompute path (PLAN §5.1/§7.3)
//
// This is the SINGLE source of truth for completing a quest. BOTH the web
// endpoint (`POST /api/quests/:id/complete`) and the CLI (`scale quest
// complete`) call these functions, so a quest completes identically whether it
// is graded in the browser or on the command line (no divergence).
// ---------------------------------------------------------------------------

const DIM_NAMES: DimName[] = ['structure', 'concepts', 'rationale'];

export interface QuestCompletion {
  /** The component the completed quest belongs to. */
  componentId: string;
  /** How many graded results were actually recorded (invalid ones skipped). */
  recorded: number;
  /** The component's coverage AFTER re-materialization (state + dims). */
  component: ComponentCoverage;
}

/** Best-effort user label for the state dir at `cwd`. */
function completionUser(dir: string): string {
  return readConfigSafe(dir)?.user ?? process.env.USER ?? 'user';
}

/**
 * Mark `questId` completed and return its updated component coverage. Appends a
 * `quiz_result` (origin 'session') per valid graded dimension, flips the quest
 * to `completed` in quests.json, re-materializes coverage, and returns the
 * component. Returns `null` when the quest id is unknown (callers map that to a
 * 404 / error). `results` is the raw `[{dim, score}]` array; malformed entries
 * are skipped (a score must be a number in [0,1] on a real dim name).
 */
export async function completeQuizQuest(
  cwd: string,
  questId: string,
  results: unknown,
): Promise<QuestCompletion | null> {
  const dir = stateDir(cwd);
  const quests = readQuestsSafe(dir);
  const quest = quests.find((q) => q.id === questId);
  if (!quest) return null;

  const user = completionUser(dir);
  const sha = shortHeadSha(cwd);
  const now = new Date().toISOString();
  const arr = Array.isArray(results) ? (results as Record<string, unknown>[]) : [];

  let recorded = 0;
  for (const r of arr) {
    const dim = r?.dim;
    const score = r?.score;
    if (typeof dim !== 'string' || !(DIM_NAMES as string[]).includes(dim)) continue;
    if (typeof score !== 'number' || Number.isNaN(score) || score < 0 || score > 1) continue;
    try {
      await appendEvidence(dir, {
        type: 'quiz_result',
        ts: now,
        user,
        componentId: quest.componentId,
        dim: dim as DimName,
        score,
        sha,
        origin: 'session',
      });
      recorded++;
    } catch {
      /* skip a single invalid result; keep going */
    }
  }

  return finishCompletion(cwd, dir, quests, questId, quest.componentId, recorded);
}

/**
 * Socratic counterpart to {@link completeQuizQuest}: record ONE
 * `socratic_result` (origin 'session') carrying the per-dim rubric scores, mark
 * the quest completed, recompute, and return the component. For a socratic quest
 * that was run OUTSIDE the web chat (e.g. in-chat tutor) and now needs to be
 * closed out from the CLI. `dims` is a raw `{dim: score}` object; only real dim
 * names with a number in [0,1] are kept. Returns `null` for an unknown quest.
 */
export async function completeSocraticQuest(
  cwd: string,
  questId: string,
  dims: unknown,
): Promise<QuestCompletion | null> {
  const dir = stateDir(cwd);
  const quests = readQuestsSafe(dir);
  const quest = quests.find((q) => q.id === questId);
  if (!quest) return null;

  const graded: Partial<Record<DimName, number>> = {};
  if (dims && typeof dims === 'object') {
    for (const d of DIM_NAMES) {
      const v = (dims as Record<string, unknown>)[d];
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1) graded[d] = v;
    }
  }

  let recorded = 0;
  if (Object.keys(graded).length > 0) {
    try {
      await appendEvidence(dir, {
        type: 'socratic_result',
        ts: new Date().toISOString(),
        user: completionUser(dir),
        componentId: quest.componentId,
        dims: graded,
        sha: shortHeadSha(cwd),
        origin: 'session',
      });
      recorded = Object.keys(graded).length;
    } catch {
      /* recording is best-effort — still conclude the quest */
    }
  }

  return finishCompletion(cwd, dir, quests, questId, quest.componentId, recorded);
}

/** Shared tail: persist the completed status + recompute → component. */
function finishCompletion(
  cwd: string,
  dir: string,
  quests: Quest[],
  questId: string,
  componentId: string,
  recorded: number,
): QuestCompletion {
  const updated = quests.map((q) =>
    q.id === questId ? { ...q, status: 'completed' as const } : q,
  );
  ensureStateDir(dir);
  fs.writeFileSync(paths.quests(dir), JSON.stringify(updated, null, 2) + '\n');

  let component = emptyComponentCoverage();
  try {
    const { coverage } = recomputeCoverageFromDisk(cwd);
    component = coverage.components[componentId] ?? component;
  } catch {
    /* fall back to the empty record */
  }
  return { componentId, recorded, component };
}
