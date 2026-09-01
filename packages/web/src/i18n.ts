import { createContext, useContext } from 'react';
import type { CoverageState, DimName, Language, QuestOrigin } from '@scale/core/browser';
import {
  SKIN,
  QUEST_SKIN,
  UNIFICATION_LABEL_EN,
  UNIFICATION_LABEL_KO,
  DEV_STATS_LABEL_EN,
  DEV_STATS_LABEL_KO,
} from './skin.js';

/**
 * Interaction-language dictionary for the served map viewer (config.json
 * `language`, PLAN §2 skin + per-user preference). Every learner-facing literal
 * in the SPA flows through here; components never hardcode display prose.
 *
 * Rules (mirrors core's LanguageSchema contract):
 *  - 'ko' → everything SCALE says to the junior is Korean, EXCEPT code
 *    references: component ids, file paths, function names, env vars, model
 *    ids, and established dev terms (commit, hook, EMA, pre-commit…).
 *  - 'en' → pure English UI.
 *  - .scale/ papers are repo-shared state and stay English either way — paper
 *    CONTENT is never translated here (Markdown.tsx is untouched).
 *
 * Game-skin vocabulary: skin.ts owns the term DEFINITIONS (미탐사/정찰됨/정복/
 * 반란, 공성전, 천하통일 진행도…) and entries reference its labelKo/labelEn
 * pairs where a term stands alone; longer ko sentences here may EMBED those
 * terms (e.g. state blurbs, '대기 중인 공성전') — new skin nouns still belong in
 * skin.ts first.
 */
export interface Strings {
  /* ---- header (App) ---- */
  brandSub: string;
  unificationProgress: string;
  settingsButtonTitle: string;
  openSettings: string; // aria-label
  loadingMap: string;

  /* ---- coverage-state skin: legend, panel chip, outcome ---- */
  state: Record<CoverageState, { label: string; blurb: string }>;

  /* ---- map (MapView) ---- */
  zoomIn: string;
  zoomOut: string;
  resetView: string;
  mapHint: string;
  /** aria-label prefix for a pending-quest badge; caller appends `(node-id)`. */
  questOffer: string;

  /* ---- shared quest / dimension vocabulary ---- */
  devStats: string;
  dim: Record<DimName, string>;
  quest: {
    /** pending-quest noun (Siege / 공성전) */
    label: string;
    /** begin-quest CTA (출정) */
    start: string;
    quiz: string;
    socratic: string;
    /** completion banner (Territory taken / 정복 완료) */
    won: string;
  };
  /** quest origin tags shown next to quest entries (session/rebellion/voluntary) */
  origin: Record<QuestOrigin, string>;

  /* ---- paper renderer chrome (Markdown) — viewer text, NOT paper content ---- */
  mermaidBadge: string;
  mermaidTodo: string;

  /* ---- panel ---- */
  closePanel: string; // aria-label
  loyalty: string;
  lastValidated: string;
  pendingQuestsHeading: string;
  challenge: string;
  challengePreparing: string;
  challengeError: string;
  loadingPaper: string;
  conceptsHeading: string;
  paperHeading: string;
  noPaper: string;

  /* ---- quest runner ---- */
  closeQuest: string; // aria-label
  /** suffix on the outcome stats head when per-dim grades are shown */
  grades: string;
  answerLabel: string;
  submitAnswers: string;
  recording: string;
  /** fallback opening probe when a socratic quest has no seed item */
  socraticSeed: string;
  /** chat participant names ('문답관'/'나' in ko, 'Tutor'/'You' in en) */
  tutorName: string;
  youName: string;
  socraticUnavailable: string; // prefix; server error detail is appended
  addApiKey: (provider: string) => string;
  tryAgain: string;
  readPaperInstead: string;
  dialogueComplete: string;
  inputPlaceholder: string;
  send: string;

  /* ---- settings modal ---- */
  set: {
    title: string;
    closeSettings: string; // aria-label
    saving: string;
    savesImmediately: string;
    couldNotSave: string; // prefix; server error detail is appended
    /** around a literal <code>scale serve</code>; error detail follows Post */
    needsBackendPre: string;
    needsBackendPost: string;
    loadingSettings: string;
    /** Language row. Option labels are each language's own name — not localized. */
    language: string;
    languageNote: string;
    apiKeysHeading: string;
    /** around a literal <code>~/.scale/keys.json</code> */
    keysNotePre: string;
    keysNotePost: string;
    notSet: string;
    /** tooltip on a configured key's masked status; 'env'/'file' stay as dev terms */
    keySource: (source: string) => string;
    save: string;
    savingBtn: string;
    clear: string;
    envShadowed: (envVar: string) => string;
    modelHeading: string;
    provider: string;
    tier: string;
    /** around <code>{model id}</code>, <code>/scale-map</code>, <code>/model</code> */
    modelNoteRuns: string;
    modelNoteBuildPre: string;
    modelNoteBuildMid: string;
    modelNoteBuildPost: string;
    gateHeading: string;
    gateEnabled: string;
    gateOn: string;
    gateOnHint: string;
    gateOff: string;
    gateOffHint: string;
    assessment: string;
    assessSync: string;
    assessSyncHint: string;
    assessAsync: string;
    assessAsyncHint: string;
    modality: string;
    quizHint: string;
    socraticHint: string;
    enforcement: string;
    enfAdvisory: string;
    enfAdvisoryHint: string;
    enfSoft: string;
    enfSoftHint: string;
    enfHard: string;
    enfHardHint: string;
    policyNote: string;
    budgetHeading: string;
    perSession: string;
    cooldownMin: string;
  };
}

export const STRINGS: Record<Language, Strings> = {
  en: {
    brandSub: 'territory map',
    unificationProgress: UNIFICATION_LABEL_EN,
    settingsButtonTitle: 'Settings',
    openSettings: 'Open settings',
    loadingMap: 'Loading territory map…',

    state: {
      fog: { label: SKIN.fog.labelEn, blurb: SKIN.fog.blurb },
      explored: { label: SKIN.explored.labelEn, blurb: SKIN.explored.blurb },
      validated: { label: SKIN.validated.labelEn, blurb: SKIN.validated.blurb },
      stale: { label: SKIN.stale.labelEn, blurb: SKIN.stale.blurb },
    },

    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    resetView: 'Reset view',
    mapHint: 'Scroll or pinch to zoom into a territory · drag to pan',
    questOffer: QUEST_SKIN.offerEn,

    devStats: DEV_STATS_LABEL_EN,
    dim: { structure: 'Structure', concepts: 'Concepts', rationale: 'Rationale' },
    quest: {
      label: QUEST_SKIN.labelEn,
      start: QUEST_SKIN.startEn,
      quiz: QUEST_SKIN.quizEn,
      socratic: QUEST_SKIN.socraticEn,
      won: QUEST_SKIN.wonEn,
    },
    origin: { session: 'session', rebellion: 'rebellion', voluntary: 'voluntary' },

    mermaidBadge: 'mermaid diagram',
    mermaidTodo: 'Rendered diagram is a TODO for a later phase.',

    closePanel: 'Close panel',
    loyalty: 'Loyalty',
    lastValidated: 'Last validated',
    pendingQuestsHeading: 'Pending sieges',
    challenge: 'Challenge',
    challengePreparing: 'Preparing…',
    challengeError: 'Could not prepare a challenge for this territory.',
    loadingPaper: 'Loading paper…',
    conceptsHeading: 'Concepts',
    paperHeading: 'Paper',
    noPaper: 'No paper found for this component.',

    closeQuest: 'Close quest',
    grades: 'grades',
    answerLabel: 'Answer:',
    submitAnswers: 'Submit answers',
    recording: 'Recording…',
    socraticSeed: 'Tell me what you understand about this component.',
    tutorName: 'Tutor',
    youName: 'You',
    socraticUnavailable: 'Socratic dialogue is unavailable:',
    addApiKey: (provider) => `⚙ Add ${provider} API key`,
    tryAgain: 'Try again',
    readPaperInstead: 'Just read the paper instead →',
    dialogueComplete: 'Dialogue complete',
    inputPlaceholder: 'Type your reasoning…',
    send: 'Send',

    set: {
      title: 'Settings',
      closeSettings: 'Close settings',
      saving: 'saving…',
      savesImmediately: 'changes save immediately',
      couldNotSave: 'Could not save:',
      needsBackendPre: 'Settings need a live',
      needsBackendPost: 'backend:',
      loadingSettings: 'Loading settings…',
      language: 'Language',
      languageNote:
        'Applies to everything SCALE says to you. Coverage papers stay English (repo-shared state).',
      apiKeysHeading: 'API keys',
      keysNotePre: 'Used for the Socratic tutor and LLM-written quests. Stored in',
      keysNotePost:
        '(mode 0600) on this machine; never sent anywhere but the provider you choose.',
      notSet: 'not set',
      keySource: (source) => `source: ${source}`,
      save: 'Save',
      savingBtn: 'Saving…',
      clear: 'Clear',
      envShadowed: (envVar) =>
        `${envVar} is set in the environment and takes precedence — anything saved here stays unused until you unset it.`,
      modelHeading: 'Intervention model',
      provider: 'Provider',
      tier: 'Tier',
      modelNoteRuns: 'Runs the Socratic tutor and LLM-written quests →',
      modelNoteBuildPre: 'The one-time coverage-memory build is not configured here: ',
      modelNoteBuildMid:
        ' runs inside a Claude Code session, so it uses whatever model that session is on — pick it with ',
      modelNoteBuildPost: ' before you build.',
      gateHeading: 'Edit gate',
      gateEnabled: 'Gate',
      gateOn: 'On',
      gateOnHint: 'locked territory gates edits',
      gateOff: 'Off',
      gateOffHint: 'never gate my edits',
      assessment: 'Check timing',
      assessSync: 'Immediate',
      assessSyncHint: 'check in chat, right away',
      assessAsync: 'Deferred',
      assessAsyncHint: 'teach now, check later here',
      modality: 'Modality',
      quizHint: 'multiple choice',
      socraticHint: 'dialogue (needs a key)',
      enforcement: 'Enforcement',
      enfAdvisory: 'Advisory',
      enfAdvisoryHint: 'note it, never block',
      enfSoft: 'Soft',
      enfSoftHint: 'block, skip allowed',
      enfHard: 'Hard',
      enfHardHint: 'block, no skip',
      policyNote:
        'Team policy sets the defaults here — anything you change becomes your personal override.',
      budgetHeading: 'Interruption budget',
      perSession: 'per session',
      cooldownMin: 'cooldown (min)',
    },
  },

  ko: {
    brandSub: '천하도',
    unificationProgress: UNIFICATION_LABEL_KO,
    settingsButtonTitle: '설정',
    openSettings: '설정 열기',
    loadingMap: '천하도를 불러오는 중…',

    state: {
      fog: { label: SKIN.fog.labelKo, blurb: '아직 답사하지 않은 영지입니다. 기록된 이해도가 없습니다.' },
      explored: {
        label: SKIN.explored.labelKo,
        blurb: '지나며 접해 본 영지입니다. 정찰은 되었지만 아직 검증되지 않았습니다.',
      },
      validated: {
        label: SKIN.validated.labelKo,
        blurb: '이해도 점검으로 검증을 마친, 확보된 영지입니다.',
      },
      stale: {
        label: SKIN.stale.labelKo,
        blurb: '마지막 검증 이후 소스 코드가 바뀌었습니다. 재검증이 필요합니다.',
      },
    },

    zoomIn: '확대',
    zoomOut: '축소',
    resetView: '전체 보기',
    mapHint: '스크롤/핀치로 영지를 확대 · 드래그로 이동',
    questOffer: QUEST_SKIN.offerKo,

    devStats: DEV_STATS_LABEL_KO,
    dim: { structure: '구조', concepts: '개념', rationale: '설계 근거' },
    quest: {
      label: QUEST_SKIN.labelKo,
      start: QUEST_SKIN.startKo,
      quiz: QUEST_SKIN.quizKo,
      socratic: QUEST_SKIN.socraticKo,
      won: QUEST_SKIN.wonKo,
    },
    origin: { session: '세션', rebellion: '반란', voluntary: '자율' },

    mermaidBadge: 'mermaid 다이어그램',
    mermaidTodo: '다이어그램 렌더링은 이후 단계에서 지원됩니다.',

    closePanel: '패널 닫기',
    loyalty: '민심',
    lastValidated: '최근 검증',
    pendingQuestsHeading: '대기 중인 공성전',
    challenge: '도전',
    challengePreparing: '퀘스트 준비 중…',
    challengeError: '이 영지의 퀘스트를 준비하지 못했습니다.',
    loadingPaper: '문서를 불러오는 중…',
    conceptsHeading: '개념',
    paperHeading: '문서',
    noPaper: '이 컴포넌트의 문서를 찾을 수 없습니다.',

    closeQuest: '퀘스트 닫기',
    grades: '평가',
    answerLabel: '정답:',
    submitAnswers: '답안 제출',
    recording: '기록 중…',
    socraticSeed: '이 컴포넌트에 대해 이해한 바를 말해 보세요.',
    tutorName: '문답관',
    youName: '나',
    socraticUnavailable: '문답 대련을 진행할 수 없습니다:',
    addApiKey: (provider) => `⚙ ${provider} API 키 추가`,
    tryAgain: '다시 시도',
    readPaperInstead: '대신 문서를 읽어보기 →',
    dialogueComplete: '대련 종료',
    inputPlaceholder: '생각을 적어 보세요…',
    send: '보내기',

    set: {
      title: '설정',
      closeSettings: '설정 닫기',
      saving: '저장 중…',
      savesImmediately: '변경 사항은 즉시 저장됩니다',
      couldNotSave: '저장하지 못했습니다:',
      needsBackendPre: '설정에는 실행 중인',
      needsBackendPost: '백엔드가 필요합니다:',
      loadingSettings: '설정을 불러오는 중…',
      language: '언어',
      languageNote:
        'SCALE이 당신에게 말하는 모든 문구에 적용됩니다. 커버리지 문서는 영어로 유지됩니다 (저장소 공유 상태).',
      apiKeysHeading: 'API 키',
      keysNotePre: 'Socratic 문답과 LLM 작성 퀴즈에 사용됩니다. 이 컴퓨터의',
      keysNotePost:
        '(모드 0600)에 저장되며, 선택한 제공자 외에는 어디에도 전송되지 않습니다.',
      notSet: '미설정',
      keySource: (source) => `출처: ${source}`,
      save: '저장',
      savingBtn: '저장 중…',
      clear: '지우기',
      envShadowed: (envVar) =>
        `${envVar} 환경 변수가 설정되어 있어 우선 적용됩니다 — 해제하기 전까지 여기 저장한 키는 사용되지 않습니다.`,
      modelHeading: '개입 모델',
      provider: '제공자',
      tier: '등급',
      modelNoteRuns: 'Socratic 문답과 LLM 작성 퀴즈를 이 모델이 실행합니다 →',
      modelNoteBuildPre: '일회성 커버리지 메모리 빌드는 여기서 설정하지 않습니다: ',
      modelNoteBuildMid:
        '은(는) Claude Code 세션 안에서 실행되어 그 세션의 모델을 그대로 사용합니다 — 빌드 전에 ',
      modelNoteBuildPost: '로 선택하세요.',
      gateHeading: '편집 게이트',
      gateEnabled: '게이트',
      gateOn: '켬',
      gateOnHint: '잠긴 영토 편집을 게이트',
      gateOff: '끔',
      gateOffHint: '내 편집은 게이트하지 않음',
      assessment: '확인 시점',
      assessSync: '즉시',
      assessSyncHint: '채팅에서 바로 확인',
      assessAsync: '나중에',
      assessAsyncHint: '지금은 설명만, 확인은 여기서',
      modality: '방식',
      quizHint: '객관식',
      socraticHint: '대화형 (API 키 필요)',
      enforcement: '강제 수준',
      enfAdvisory: '알림만',
      enfAdvisoryHint: '기록만 하고 막지 않음',
      enfSoft: '소프트',
      enfSoftHint: '차단하되 스킵 가능',
      enfHard: '하드',
      enfHardHint: '차단, 스킵 없음',
      policyNote:
        '기본값은 팀 정책이 정합니다 — 여기서 바꾸면 내 개인 override가 됩니다.',
      budgetHeading: '방해 예산',
      perSession: '세션당',
      cooldownMin: '쿨다운 (분)',
    },
  },
};

/**
 * Current interaction language, provided once at the root by App. The default
 * matters: 'en' keeps everything readable before /api/settings resolves (and
 * forever, in offline vite dev with no backend).
 */
export const LangContext = createContext<Language>('en');

/** The active interaction language. */
export function useLang(): Language {
  return useContext(LangContext);
}

/** The active language's string table — the only way components get UI copy. */
export function useStrings(): Strings {
  return STRINGS[useLang()];
}
