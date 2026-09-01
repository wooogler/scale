import type { CoverageState } from '@scale/core/browser';

/**
 * The terminology skin (PLAN §2). This module DEFINES the Koei-style game terms
 * for the neutral coverage states; i18n.ts may embed them inside longer display
 * sentences, but a new game noun starts here. Core schemas and the CLI never
 * speak "conquered" or "함락"; the skin boundary is the web viewer, on purpose.
 *
 *   fog       -> 미탐사   (unexplored / fog)
 *   explored  -> 정찰됨   (scouted)
 *   validated -> 정복     (conquered)
 *   stale     -> 함락     (fallen — a teammate's change took it)
 *              or 재건   (rebuilt — you rewrote it yourself)
 *
 * `stale` is the only state whose label depends on WHY. A teammate outrunning
 * your understanding and you outrunning it yourself are different events in the
 * multiplayer framing this skin borrows: one is territory lost to another
 * player, the other is your own land rebuilt past your last survey. Calling both
 * '반란' said the territory was revolting against you, which is neither.
 */
export interface Skin {
  /** canonical coverage state (unchanged) */
  state: CoverageState;
  /** Korean map-UI label */
  labelKo: string;
  /** English map-UI label */
  labelEn: string;
  /** primary color for this state */
  color: string;
  /** how the node should read visually */
  treatment: 'fog' | 'outlined' | 'filled' | 'drifted';
  /** one-line description for the panel */
  blurb: string;
}

export const SKIN: Record<CoverageState, Skin> = {
  fog: {
    state: 'fog',
    labelKo: '미탐사',
    labelEn: 'Unexplored (fog)',
    color: '#5b6270',
    treatment: 'fog',
    blurb: 'Not yet surveyed. No coverage recorded.',
  },
  explored: {
    state: 'explored',
    labelKo: '정찰됨',
    labelEn: 'Scouted',
    color: '#4a90d9',
    treatment: 'outlined',
    blurb: 'Passively encountered. Explored, but not yet validated.',
  },
  validated: {
    state: 'validated',
    labelKo: '정복',
    labelEn: 'Conquered',
    color: '#3fb984',
    treatment: 'filled',
    blurb: 'Validated by active comprehension checks. Held territory.',
  },
  // Default (cause unknown — an older coverage.json, or drift we could not
  // attribute). `skinFor` swaps in the cause-specific label when there is one.
  stale: {
    state: 'stale',
    labelKo: '함락',
    labelEn: 'Fallen',
    color: '#e0803a',
    treatment: 'drifted',
    blurb: 'The code moved since you validated this. Retake it with a check.',
  },
};

/** The two ways a territory can go `stale`, skinned apart. */
export const DRIFT_SKIN = {
  foreign: {
    labelKo: '함락',
    labelEn: 'Fallen',
    icon: '⚔',
    blurbKo: '다른 사람이 이 영토를 바꿨습니다. 체크를 통과해 탈환하세요.',
    blurbEn: 'Someone else changed this territory. Pass a check to retake it.',
  },
  self: {
    labelKo: '재건',
    labelEn: 'Rebuilt',
    icon: '🔨',
    blurbKo: '직접 다시 지었습니다. 예전 측량이 더 이상 맞지 않습니다.',
    blurbEn: 'You rebuilt this yourself. Your earlier survey no longer fits.',
  },
} as const;
export type DriftCauseSkin = keyof typeof DRIFT_SKIN;

/**
 * The skin for a state, specialized by drift cause when the state is `stale`.
 * Anything else ignores `cause` — only `stale` has two faces.
 */
export function skinFor(state: CoverageState, cause?: DriftCauseSkin | null): Skin {
  const base = SKIN[state];
  if (state !== 'stale' || !cause) return base;
  const d = DRIFT_SKIN[cause];
  return { ...base, labelKo: d.labelKo, labelEn: d.labelEn, blurb: d.blurbEn };
}

/** Weighted-total coverage label (§2: unification progress / 천하통일 진행도). */
export const UNIFICATION_LABEL_KO = '천하통일 진행도';
export const UNIFICATION_LABEL_EN = 'Unification progress';

/** Dev-stats label (§2: development stats / 내정 3스탯). */
export const DEV_STATS_LABEL_KO = '내정 3스탯';
export const DEV_STATS_LABEL_EN = 'Development stats';

/** Province label (§2: 주). */
export const PROVINCE_LABEL_KO = '주';

/**
 * Quest / intervention skin (§2: quests read as 전투/공성전 flavor). Kept HERE,
 * with every other game term — the runner, panel, and map badges pull their
 * player-facing copy from this object and never hardcode Korean or war terms.
 * A pending quest is a siege to wage; completing it conquers the territory.
 */
export const QUEST_SKIN = {
  /** a pending quest waiting on the map */
  labelKo: '공성전',
  labelEn: 'Siege',
  /** short badge glyph shown on a node with a pending quest */
  badge: '⚔',
  /** call-to-action to begin a quest */
  startKo: '출정',
  startEn: 'Begin siege',
  /** modality display names */
  quizKo: '문답 시험',
  quizEn: 'Quiz',
  socraticKo: '문답 대련',
  socraticEn: 'Socratic dialogue',
  /** offer copy when a node badge is clicked */
  offerKo: '이 영지를 공략하시겠습니까?',
  offerEn: 'Lay siege to this territory?',
  /** verb used when a quest completes and the node is conquered */
  wonKo: '정복 완료',
  wonEn: 'Territory taken',
} as const;
