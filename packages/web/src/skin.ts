import type { CoverageState } from '@scale/core/browser';

/**
 * The terminology skin (PLAN §2). This module is the ONLY place in the whole
 * codebase where neutral coverage states are translated into the Koei-style
 * game terms. Core schemas and the CLI never speak "conquered" or "반란";
 * the boundary lives here, in the web viewer, on purpose.
 *
 *   fog       -> 미탐사   (unexplored / fog)
 *   explored  -> 정찰됨   (scouted)
 *   validated -> 정복     (conquered)
 *   stale     -> 반란     (rebellion)
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
  treatment: 'fog' | 'outlined' | 'filled' | 'rebellion';
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
  stale: {
    state: 'stale',
    labelKo: '반란',
    labelEn: 'Rebellion',
    color: '#e0803a',
    treatment: 'rebellion',
    blurb: 'Source code drifted since last validation. Re-validation needed.',
  },
};

export function skinFor(state: CoverageState): Skin {
  return SKIN[state];
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
