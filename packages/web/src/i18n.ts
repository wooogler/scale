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
 *  - .scale/ component docs are repo-shared state: the doc SOURCE on disk stays
 *    English either way. The DISPLAY is a different question — when the reader's
 *    language is 'ko' the panel asks the server for a per-user translation of
 *    the doc it is showing (POST /api/doc/:id/translation) and renders that. The
 *    strings below are the viewer's own chrome around it (status, badge,
 *    toggle), never doc content.
 *
 * Game-skin vocabulary: skin.ts owns the term DEFINITIONS (미탐사/정찰됨/정복/
 * 함락, 공성전, 천하통일 진행도…) and entries reference its labelKo/labelEn
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
  /** header chip + node badge: territories a denied edit still owes a check on */
  owedUnlock: string;
  /** panel note under the state chip for such a territory */
  owedUnlockNote: string;
  /** Banner when the API refuses the bearer token (server restarted). */
  authExpired: string;

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
  /** quest origin tags shown next to quest entries (session/drift/voluntary) */
  origin: Record<QuestOrigin, string>;

  /* ---- doc renderer chrome (Markdown) — viewer text, NOT doc content ---- */
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
  loadingDoc: string;
  conceptsHeading: string;
  /** Heading over the doc's rationale entries (a graded coverage dimension). */
  designDecisionsHeading: string;
  /** Label before a rationale entry's rejected alternatives. */
  alternativesLabel: string;
  docHeading: string;
  noDoc: string;
  /** Inline status while the per-user translation is still in flight. */
  translating: string;
  /** Badge on a doc rendered from the translation rather than the source. */
  translatedBadge: string;
  /** Subtle note beside the badge when the translation came from the cache. */
  cachedBadge: string;
  /** Toggle: currently showing the translation → go back to the English source. */
  showOriginal: string;
  /** Toggle: currently showing the English source → go back to the translation. */
  showTranslation: string;
  /** One-line note when the server could not translate; the detail is appended. */
  translationUnavailable: string;

  /* ---- quest runner ---- */
  closeQuest: string; // aria-label
  /** suffix on the outcome stats head when per-dim grades are shown */
  grades: string;
  answerLabel: string;
  submitAnswers: string;
  recording: string;
  /** shown when the server could not be reached to grade + record */
  completeFailed: string;
  /** fallback opening probe when a socratic quest has no seed item */
  socraticSeed: string;
  /** chat participant names ('문답관'/'나' in ko, 'Tutor'/'You' in en) */
  tutorName: string;
  youName: string;
  socraticUnavailable: string; // prefix; server error detail is appended
  addApiKey: (provider: string) => string;
  tryAgain: string;
  readDocInstead: string;
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
    /** Provenance chips beside a setting (S4). */
    srcDefault: string;
    srcPolicy: string;
    srcUser: string;
    /** Reset button; policy variant when the team names a value. */
    resetToPolicy: string;
    resetToDefault: string;
    provenanceNote: string;
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
    owedUnlock: 'awaiting your check',
    owedUnlockNote:
      'An edit here was held back. Pass this check to unlock the territory — or use /scale-study in Claude Code.',
    authExpired:
      'This tab\'s key no longer matches the server — scale serve was restarted. Open the fresh URL it printed (it carries a new ?token=).',

    devStats: DEV_STATS_LABEL_EN,
    dim: { structure: 'Structure', concepts: 'Concepts', rationale: 'Rationale' },
    quest: {
      label: QUEST_SKIN.labelEn,
      start: QUEST_SKIN.startEn,
      quiz: QUEST_SKIN.quizEn,
      socratic: QUEST_SKIN.socraticEn,
      won: QUEST_SKIN.wonEn,
    },
    origin: { session: 'session', drift: 'retake', voluntary: 'voluntary' },

    mermaidBadge: 'mermaid diagram',
    mermaidTodo: 'Rendered diagram is a TODO for a later phase.',

    closePanel: 'Close panel',
    loyalty: 'Loyalty',
    lastValidated: 'Last validated',
    pendingQuestsHeading: 'Pending sieges',
    challenge: 'Challenge',
    challengePreparing: 'Preparing…',
    challengeError: 'Could not prepare a challenge for this territory.',
    loadingDoc: 'Loading doc…',
    conceptsHeading: 'Concepts',
    designDecisionsHeading: 'Design decisions',
    alternativesLabel: 'Alternatives',
    docHeading: 'Doc',
    noDoc: 'No doc found for this component.',
    translating: 'Translating…',
    translatedBadge: 'Translated',
    cachedBadge: 'cached',
    showOriginal: 'Show original',
    showTranslation: 'Show translation',
    translationUnavailable: 'Translation unavailable — showing the English source.',

    closeQuest: 'Close quest',
    grades: 'grades',
    answerLabel: 'Answer:',
    submitAnswers: 'Submit answers',
    recording: 'Recording…',
    completeFailed:
      'Could not reach the server to grade this. Nothing was recorded — try again.',
    socraticSeed: 'Tell me what you understand about this component.',
    tutorName: 'Tutor',
    youName: 'You',
    socraticUnavailable: 'Socratic dialogue is unavailable:',
    addApiKey: (provider) => `⚙ Add ${provider} API key`,
    tryAgain: 'Try again',
    readDocInstead: 'Just read the doc instead →',
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
        'Applies to everything SCALE says to you. Component docs stay English in the repo (shared state); when your language is not English the panel shows a per-user translation of the doc it renders.',
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
      srcDefault: 'default',
      srcPolicy: 'team default',
      srcUser: 'yours',
      resetToPolicy: '↺ team default',
      resetToDefault: '↺ default',
      provenanceNote:
        'Each setting shows where its value comes from. "yours" is pinned in your own config and will not follow a later team change — ↺ lets it go.',
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
    owedUnlock: '확인 대기',
    owedUnlockNote:
      '이 영토에서 편집이 보류됐습니다. 체크를 통과하면 열립니다 — Claude Code의 /scale-study로도 가능합니다.',
    authExpired:
      '이 탭의 키가 더 이상 서버와 맞지 않습니다 — scale serve가 다시 시작됐습니다. 터미널에 새로 찍힌 URL(새 ?token= 포함)을 여세요.',

    devStats: DEV_STATS_LABEL_KO,
    dim: { structure: '구조', concepts: '개념', rationale: '설계 근거' },
    quest: {
      label: QUEST_SKIN.labelKo,
      start: QUEST_SKIN.startKo,
      quiz: QUEST_SKIN.quizKo,
      socratic: QUEST_SKIN.socraticKo,
      won: QUEST_SKIN.wonKo,
    },
    origin: { session: '세션', drift: '탈환', voluntary: '자율' },

    mermaidBadge: 'mermaid 다이어그램',
    mermaidTodo: '다이어그램 렌더링은 이후 단계에서 지원됩니다.',

    closePanel: '패널 닫기',
    loyalty: '민심',
    lastValidated: '최근 검증',
    pendingQuestsHeading: '대기 중인 공성전',
    challenge: '도전',
    challengePreparing: '퀘스트 준비 중…',
    challengeError: '이 영지의 퀘스트를 준비하지 못했습니다.',
    loadingDoc: '문서를 불러오는 중…',
    conceptsHeading: '개념',
    designDecisionsHeading: '설계 결정',
    alternativesLabel: '대안',
    docHeading: '문서',
    noDoc: '이 컴포넌트의 문서를 찾을 수 없습니다.',
    translating: '번역 중…',
    translatedBadge: '번역됨',
    cachedBadge: '캐시',
    showOriginal: '원문 보기',
    showTranslation: '번역 보기',
    translationUnavailable: '번역을 불러올 수 없어 영어 원문을 표시합니다.',

    closeQuest: '퀘스트 닫기',
    grades: '평가',
    answerLabel: '정답:',
    submitAnswers: '답안 제출',
    recording: '기록 중…',
    completeFailed: '채점 서버에 연결하지 못했습니다. 기록된 것이 없습니다 — 다시 시도하세요.',
    socraticSeed: '이 컴포넌트에 대해 이해한 바를 말해 보세요.',
    tutorName: '문답관',
    youName: '나',
    socraticUnavailable: '문답 대련을 진행할 수 없습니다:',
    addApiKey: (provider) => `⚙ ${provider} API 키 추가`,
    tryAgain: '다시 시도',
    readDocInstead: '대신 문서를 읽어보기 →',
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
        'SCALE이 당신에게 말하는 모든 문구에 적용됩니다. 컴포넌트 문서는 저장소에서 영어 원문으로 유지되며(공유 상태), 언어가 영어가 아닐 때 패널에서 사용자별 번역을 보여 줍니다.',
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
      srcDefault: '기본값',
      srcPolicy: '팀 기본값',
      srcUser: '내 설정',
      resetToPolicy: '↺ 팀 기본값으로',
      resetToDefault: '↺ 기본값으로',
      provenanceNote:
        '각 설정 옆에 값의 출처가 표시됩니다. "내 설정"은 내 config에 고정된 값이라 팀 기본값이 바뀌어도 따라가지 않습니다 — ↺로 해제할 수 있습니다.',
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
