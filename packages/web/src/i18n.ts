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

  /* ---- docs browser (header button + modal) ---- */
  /** Header button that opens the list of every component doc. */
  docsIndex: string;
  /** Title of that list. */
  docsIndexTitle: string;
  /** One line under the title saying what the list is for. */
  docsIndexBlurb: string;
  /** Filter box placeholder. */
  docsIndexFilter: string;
  /** Shown when the index is empty or could not be loaded. */
  docsIndexEmpty: string;
  /** Shown when a filter matches nothing. */
  docsIndexNoMatch: string;
  closeDocsIndex: string; // aria-label

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
    /** Settings modal tab strip; keys match Settings.tsx's TAB_IDS. */
    tab: { general: string; gate: string; checks: string; team: string };

    /* ---- comprehension-check SHAPE (quiz.items / focus / grounding) ---- */
    checkHeading: string;
    checkItems: string;
    checkItemsHint: string;
    checkFocus: string;
    focusAuto: string;
    focusAutoHint: string;
    focusStructure: string;
    focusStructureHint: string;
    focusConcepts: string;
    focusConceptsHint: string;
    focusRationale: string;
    focusRationaleHint: string;
    checkGrounding: string;
    groundBalanced: string;
    groundBalancedHint: string;
    groundDiff: string;
    groundDiffHint: string;
    groundDoc: string;
    groundDocHint: string;
    checkNote: string;
    budgetHeading: string;
    budgetNote: string;
    perSession: string;
    cooldownMin: string;

    /* ---- Team tab: .scale/policy.json and who may edit it ---- */
    teamHeading: string;
    /** Your resolved git address(es); the value follows as <code>. */
    yourIdentity: string;
    noIdentity: string;
    roleLead: string;
    roleMember: string;
    /** Shown to a member: how to become a lead. `leads` stays a code term. */
    memberNote: string;
    /** Shown to anyone while `leads` is empty. */
    bootstrapNote: string;
    /** Always shown: the list gates this UI, not the file. */
    notSecurityNote: string;
    leadsHeading: string;
    leadsEmpty: string;
    addLeadPlaceholder: string;
    addLead: string;
    addMe: string;
    removeLead: (email: string) => string; // aria-label
    lastLeadWarning: string;
    defaultsHeading: string;
    /** Chip on a row the policy does not set. */
    notSetChip: string;
    /** Clears one policy leaf. */
    removeLeaf: string;
    /** Read-only banner for a member. */
    readOnlyNote: string;
    policyPathLabel: string;
    policyMissing: string;
    dirtyBadge: string;
    committedBadge: string;
    notALead: string;

    /* ---- per-setting tips ("?" disclosures) and live previews ---- */
    /** aria-label / title on the "?" toggle, in each state. */
    tipShow: string;
    tipHide: string;
    /** Tip bodies. Newlines render as line breaks; 1-3 sentences each. */
    tipLanguage: string;
    tipKeys: string;
    tipModel: string;
    tipGateEnabled: string;
    tipAssessment: string;
    tipModality: string;
    tipEnforcement: string;
    tipItems: string;
    tipFocus: string;
    tipGrounding: string;
    tipBudgets: string;
    tipTeam: string;
    /** Deny-message preview (Edit gate tab). */
    denyPreviewCaption: string;
    denyPreviewNoGate: string;
    /** One sentence over budgets.maxPerSession / cooldownMinutes. */
    freqSentence: (perSession: number, cooldown: number) => string;
    /** Sample-check preview (Checks tab). */
    quizPreviewCaption: string;
    quizPreviewComponent: string;
    quizPreviewLoading: string;
    quizPreviewUnavailable: string;
    quizPreviewGrounding: string;
    /** Team tab: what a new member ends up with under these defaults. */
    teamOutcome: (parts: {
      assessment: string;
      modality: string;
      enforcement: string;
      items: number;
      perSession: number;
    }) => string;
    teamOutcomeGateOff: string;
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

    docsIndex: 'Docs',
    docsIndexTitle: 'Component docs',
    docsIndexBlurb: 'Every component doc in this repo. Open one without finding it on the map.',
    docsIndexFilter: 'Filter by title or id…',
    docsIndexEmpty: 'No component docs — run the SCALE memory build first.',
    docsIndexNoMatch: 'Nothing matches that.',
    closeDocsIndex: 'Close the doc list',

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
      tab: { general: 'General', gate: 'Edit gate', checks: 'Checks', team: 'Team' },

      checkHeading: 'Comprehension checks',
      checkItems: 'Items per check',
      checkItemsHint: '1-5 multiple-choice questions',
      checkFocus: 'Focus',
      focusAuto: 'Auto',
      focusAutoHint: 'your weakest dimension, varied',
      focusStructure: 'Structure',
      focusStructureHint: 'how it is built',
      focusConcepts: 'Concepts',
      focusConceptsHint: 'the ideas it names',
      focusRationale: 'Rationale',
      focusRationaleHint: 'why it was designed that way',
      checkGrounding: 'Questions about',
      groundBalanced: 'Both',
      groundBalancedHint: 'the doc, sharpened by your change',
      groundDiff: 'My change',
      groundDiffHint: 'every question about what you just changed',
      groundDoc: 'The design',
      groundDocHint: 'the documented design only; your diff is never sent',
      checkNote:
        'These shape the check itself - how long it is and what it asks about. Only quiz modality reads them; a Socratic dialogue is capped at 3 exchanges.',
      budgetHeading: 'Check frequency',
      budgetNote:
        'How often the gate may interrupt: at most this many denials per session, and never twice inside the cooldown. Gate "Off" above disables checks entirely.',
      perSession: 'per session',
      cooldownMin: 'cooldown (min)',

      teamHeading: 'Team policy',
      yourIdentity: 'You are',
      noIdentity: 'no git identity resolved on this machine',
      roleLead: 'team lead',
      roleMember: 'member',
      memberNote:
        'Leads are listed in .scale/policy.json under `leads`. Ask one of them to add your git address if you should be able to set team defaults.',
      bootstrapNote: 'Nobody is a lead yet, so anyone can edit this. Add yourself to close it.',
      notSecurityNote:
        'This list gates this screen, not the file. Anyone who can write the repo can edit .scale/policy.json in an editor - review and CODEOWNERS on that path are the real control.',
      leadsHeading: 'Leads',
      leadsEmpty: 'Nobody listed.',
      addLeadPlaceholder: 'git email address',
      addLead: 'Add',
      addMe: 'Add me',
      removeLead: (email: string) => `Remove ${email} from leads`,
      lastLeadWarning: 'No leads are listed any more - anyone can now edit the team policy.',
      defaultsHeading: 'Team defaults',
      notSetChip: 'not set (schema default)',
      removeLeaf: '\u21ba remove',
      readOnlyNote:
        'Read-only: these are the defaults your team has set. Your own settings on the other tabs override them.',
      policyPathLabel: 'Policy file',
      policyMissing: 'not committed yet - saving here creates it',
      dirtyBadge: 'uncommitted - commit .scale/policy.json to distribute',
      committedBadge: 'committed',
      notALead: 'Only a team lead can change the team policy.',

      tipShow: 'What does this do?',
      tipHide: 'Hide explanation',
      tipLanguage:
        'Switches everything SCALE says to you: this screen, quiz items, and the tutor\u2019s messages in chat.\nCode identifiers, file paths and established dev terms stay English either way.\nComponent docs under .scale/ stay English on disk - a Korean reading is translated on the way to your screen, never written back.',
      tipKeys:
        'Used for two things: the Socratic tutor\u2019s replies, and quiz items written by the model.\nQuizzes still work with no key - SCALE falls back to items generated offline from your component docs, and you can see one on the Checks tab.\nThe model that BUILDS the coverage memory is not set here: /scale-map runs inside your Claude Code session and uses whatever model that session is on.',
      tipModel:
        'One tier token drives both providers, so switching provider keeps the class of model you picked instead of silently changing it.\nThis affects interventions only - quiz writing and the Socratic tutor. The Opus tier costs more per check and writes noticeably sharper distractors.',
      tipGateEnabled:
        'Off means SCALE never blocks an edit. It still records what you touch and the map still fills in - you just never get interrupted.\nA team lead who wants to exempt themselves turns this off in their own settings; it changes nothing for anyone else.',
      tipAssessment:
        'What happens right after the gate blocks an edit.\nImmediate: the tutor runs the check in chat there and then. Passing unlocks that territory for good and your edit goes through.\nDeferred: the agent only explains the component, and the edit stays blocked. You unlock it later - in this map viewer, or with /scale-study in a coming session.',
      tipModality:
        'Quiz: multiple-choice items, graded per dimension. Fast, and works with no API key.\nSocratic: up to 3 back-and-forth exchanges that push you to reason out loud. Needs an API key, and takes longer.',
      tipEnforcement:
        'Advisory: nothing is ever blocked, the moment is only recorded. A gentle first week.\nSoft: the edit is blocked, and you can tell the agent to skip - that unlocks the territory for this session.\nHard: blocked, with no skip offered.\nNone of these is absolute: you can always change your own enforcement right here, and doing so is data, not a violation.',
      tipItems:
        'How many multiple-choice items one check asks. Each is graded separately and can feed a different coverage dimension, so 1 is quick and 4-5 reads more of the picture.\nThe gate interrupts real work: a check that outlasts the thought you were holding costs more than it teaches.',
      tipFocus:
        'Which coverage dimension the items probe.\nAuto: your weakest dimension, varied across items.\nStructure - \u201cif the file index has no exact match, which path does the gate take?\u201d\nConcepts - \u201cwhich of these is what \u2018drift\u2019 names in this component?\u201d\nRationale - \u201cwhy is the self-churn bar set higher than the foreign one?\u201d',
      tipGrounding:
        'What the questions are about.\nMy change - \u201cyou just made the deny spend a budget slot before the retry: what happens on the second edit?\u201d\nThe design - \u201cwhy does an exhausted budget allow the edit instead of queueing it?\u201d\nBoth mixes them. \u201cThe design\u201d is also the private option: your diff is never sent to the model.',
      tipBudgets:
        'Together these bound how often the gate may interrupt you.\nPer session counts blocks since the last Claude Code window for this repo closed - a second terminal shares the budget instead of refilling it. Cooldown is the quiet stretch after one block.\nSet per session to 0 to stop the gate interrupting while leaving everything else on.',
      tipTeam:
        'A team policy sets DEFAULTS, not rules: anything you change on the other tabs overrides it for you, and that is intended.\nWho may edit it is the policy\u2019s own `leads` list. While nobody is listed, anyone can - the first person to add themselves closes it.\nIt gates this screen only. The file is plain JSON in the repo, so git review and CODEOWNERS on .scale/policy.json are the real control.',
      denyPreviewCaption:
        'What the agent sees when an edit into locked territory is denied - built by the same function the gate uses.',
      denyPreviewNoGate:
        'The gate is off, so no edit is ever denied. Turn it on to see the message.',
      freqSentence: (perSession: number, cooldown: number) =>
        perSession === 0
          ? 'The gate never interrupts you: it blocks nothing this session, however much locked territory you touch.'
          : cooldown === 0
            ? `At most ${perSession} interruption${perSession === 1 ? '' : 's'} per session, with no quiet period in between.`
            : `At most ${perSession} interruption${perSession === 1 ? '' : 's'} per session; after one, the gate stays quiet for ${cooldown} minute${cooldown === 1 ? '' : 's'}.`,
      quizPreviewCaption:
        'A sample check, generated offline from this repo\u2019s own docs. The real one is written by the intervention model and grounded in your diff - this shows the shape, not the wording.',
      quizPreviewComponent: 'Preview on',
      quizPreviewLoading: 'Building a sample check\u2026',
      quizPreviewUnavailable: 'No sample available - this repo has no coverage memory yet.',
      quizPreviewGrounding:
        'The offline generator has no session diff, so \u201cQuestions about\u201d changes nothing in this preview. It does change the real check.',
      teamOutcome: (p) =>
        `With these defaults a new member gets: ${p.assessment} / ${p.modality}, ${p.enforcement} enforcement, ${p.items} item${p.items === 1 ? '' : 's'} per check, at most ${p.perSession} interruption${p.perSession === 1 ? '' : 's'} per session.`,
      teamOutcomeGateOff:
        'With these defaults the gate is OFF for a new member: nothing is ever blocked.',
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

    docsIndex: '문서',
    docsIndexTitle: '컴포넌트 문서',
    docsIndexBlurb: '이 저장소의 모든 컴포넌트 문서입니다. 지도에서 찾지 않고 바로 열 수 있습니다.',
    docsIndexFilter: '제목이나 id로 거르기…',
    docsIndexEmpty: '컴포넌트 문서가 없습니다 — SCALE 메모리 빌드를 먼저 실행하세요.',
    docsIndexNoMatch: '일치하는 문서가 없습니다.',
    closeDocsIndex: '문서 목록 닫기',

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
      tab: { general: '일반', gate: '편집 게이트', checks: '이해도 확인', team: '팀' },

      checkHeading: '이해도 확인',
      checkItems: '확인당 문항 수',
      checkItemsHint: '객관식 1~5문항',
      checkFocus: '초점',
      focusAuto: '자동',
      focusAutoHint: '가장 약한 차원을 중심으로, 문항마다 다르게',
      focusStructure: 'Structure',
      focusStructureHint: '어떻게 구성되어 있는지',
      focusConcepts: 'Concepts',
      focusConceptsHint: '어떤 개념을 다루는지',
      focusRationale: 'Rationale',
      focusRationaleHint: '왜 그렇게 설계했는지',
      checkGrounding: '무엇에 대해 묻나',
      groundBalanced: '둘 다',
      groundBalancedHint: '문서를 바탕으로, 내가 바꾼 부분을 곁들여서',
      groundDiff: '내 변경',
      groundDiffHint: '모든 문항을 방금 바꾼 코드에 대해',
      groundDoc: '설계 문서',
      groundDocHint: '문서에 적힌 설계만 — 내 diff는 전송되지 않습니다',
      checkNote:
        '확인 자체의 모양을 정합니다 — 얼마나 길고 무엇을 묻는지. 퀴즈 방식에만 적용되며, Socratic 대화는 3회 문답으로 제한됩니다.',
      budgetHeading: '확인 빈도',
      budgetNote:
        '게이트가 얼마나 자주 끼어들 수 있는지 정합니다: 세션당 차단 횟수 상한, 그리고 쿨다운 안에는 다시 차단하지 않습니다. 위의 게이트를 "끔"으로 두면 확인 자체가 일어나지 않습니다.',
      perSession: '세션당',
      cooldownMin: '쿨다운 (분)',

      teamHeading: '팀 정책',
      yourIdentity: '내 계정',
      noIdentity: '이 컴퓨터에서 git 신원을 확인할 수 없습니다',
      roleLead: '팀 리드',
      roleMember: '팀원',
      memberNote:
        '리드는 .scale/policy.json의 `leads`에 적혀 있습니다. 팀 기본값을 정해야 한다면 리드에게 내 git 주소를 추가해 달라고 요청하세요.',
      bootstrapNote: '아직 리드가 아무도 없어서 누구나 수정할 수 있습니다. 나를 추가하면 잠깁니다.',
      notSecurityNote:
        '이 목록은 파일이 아니라 이 화면을 제한할 뿐입니다. 저장소에 쓸 수 있는 사람은 누구나 에디터로 .scale/policy.json을 고칠 수 있습니다 — 실제 통제는 해당 경로의 코드 리뷰와 CODEOWNERS입니다.',
      leadsHeading: '리드',
      leadsEmpty: '등록된 사람이 없습니다.',
      addLeadPlaceholder: 'git 이메일 주소',
      addLead: '추가',
      addMe: '나 추가',
      removeLead: (email: string) => `리드에서 ${email} 제거`,
      lastLeadWarning: '이제 리드가 아무도 없습니다 — 누구나 팀 정책을 수정할 수 있습니다.',
      defaultsHeading: '팀 기본값',
      notSetChip: '미설정 (스키마 기본값)',
      removeLeaf: '↺ 해제',
      readOnlyNote:
        '읽기 전용입니다: 팀이 정한 기본값입니다. 다른 탭의 내 설정이 이 값을 덮어씁니다.',
      policyPathLabel: '정책 파일',
      policyMissing: '아직 커밋되지 않았습니다 — 여기서 저장하면 새로 만들어집니다',
      dirtyBadge: '커밋 안 됨 — .scale/policy.json을 커밋해야 팀에 배포됩니다',
      committedBadge: '커밋됨',
      notALead: '팀 정책은 팀 리드만 변경할 수 있습니다.',

      tipShow: '어떤 설정인가요?',
      tipHide: '설명 접기',
      tipLanguage:
        'SCALE이 나에게 말하는 모든 것의 언어를 바꿉니다: 이 화면, 퀴즈 문항, 채팅에서 튜터가 보내는 메시지까지.\ncode identifier, 파일 경로, 굳어진 기술 용어는 어느 쪽이든 영어로 남습니다.\n.scale/ 아래 컴포넌트 문서는 디스크에서 계속 영어입니다 — 한국어로 보는 것은 화면으로 오는 길에 번역된 결과일 뿐, 파일에 쓰이지 않습니다.',
      tipKeys:
        '두 곳에 쓰입니다: Socratic 튜터의 답변, 그리고 모델이 작성하는 퀴즈 문항.\n키가 없어도 퀴즈는 동작합니다 — 컴포넌트 문서에서 오프라인으로 만든 문항으로 대체되며, "이해도 확인" 탭에서 샘플을 볼 수 있습니다.\n커버리지 메모리를 "빌드하는" 모델은 여기서 정하지 않습니다: /scale-map은 Claude Code 세션 안에서 실행되어 그 세션의 모델을 그대로 씁니다.',
      tipModel:
        '등급 토큰 하나가 두 제공자를 모두 구동하므로, 제공자를 바꿔도 고른 모델 등급은 그대로 유지됩니다.\n개입(퀴즈 작성과 Socratic 튜터)에만 적용됩니다. Opus 등급은 확인 1회당 비용이 더 들고, 오답 보기가 눈에 띄게 날카롭습니다.',
      tipGateEnabled:
        '"끔"으로 두면 SCALE은 편집을 전혀 막지 않습니다. 어디를 건드렸는지는 계속 기록되고 지도도 채워집니다 — 방해만 받지 않을 뿐입니다.\n자신을 예외로 두고 싶은 팀 리드는 자기 설정에서 이걸 끕니다. 다른 사람에겐 아무 영향이 없습니다.',
      tipAssessment:
        '게이트가 편집을 막은 바로 다음에 일어나는 일입니다.\n즉시: 튜터가 그 자리에서 채팅으로 확인을 진행합니다. 통과하면 그 영토가 영구히 해제되고 편집도 진행됩니다.\n나중에: 에이전트는 설명만 하고 편집은 막힌 채로 남습니다. 이 지도 뷰어나 다음 세션의 /scale-study로 나중에 해제합니다.',
      tipModality:
        '퀴즈: 객관식 문항, 차원별로 채점됩니다. 빠르고 API 키 없이도 동작합니다.\nSocratic: 최대 3회의 문답으로 직접 설명하게 만듭니다. API 키가 필요하고 시간이 더 걸립니다.',
      tipEnforcement:
        '알림만: 아무것도 막지 않고 기록만 남깁니다. 첫 주에 적당합니다.\n소프트: 편집을 막되, 에이전트에게 건너뛰라고 말할 수 있습니다 — 그러면 이번 세션 동안만 해제됩니다.\n하드: 막히고, 건너뛰기 선택지가 제시되지 않습니다.\n어느 것도 절대적이지 않습니다: 내 강제 수준은 언제든 여기서 바꿀 수 있고, 바꾸는 행위 자체가 위반이 아니라 데이터입니다.',
      tipItems:
        '한 번의 확인이 묻는 객관식 문항 수입니다. 문항마다 따로 채점되고 서로 다른 커버리지 차원을 채울 수 있어서, 1문항은 빠르고 4~5문항은 더 넓게 확인합니다.\n게이트는 진짜 작업을 끊습니다: 붙잡고 있던 생각보다 긴 확인은 가르치는 것보다 잃는 게 많습니다.',
      tipFocus:
        '문항이 어떤 커버리지 차원을 확인할지 정합니다.\n자동: 가장 약한 차원을 중심으로, 문항마다 다르게.\nStructure — "파일 인덱스에 정확히 맞는 항목이 없으면 게이트는 어떤 경로를 타나요?"\nConcepts — "이 컴포넌트에서 \u2018drift\u2019가 가리키는 것은 다음 중 무엇인가요?"\nRationale — "자기 churn 기준이 타인 churn 기준보다 높은 이유는 무엇인가요?"',
      tipGrounding:
        '문항이 무엇을 다룰지 정합니다.\n내 변경 — "방금 deny가 재시도 전에 예산을 쓰도록 바꿨는데, 두 번째 편집에서는 어떻게 되나요?"\n설계 문서 — "예산을 다 쓴 경우 대기열에 넣지 않고 편집을 허용하는 이유는?"\n"둘 다"는 이 둘을 섞습니다. "설계 문서"는 프라이버시 선택지이기도 합니다: 내 diff는 모델로 전송되지 않습니다.',
      tipBudgets:
        '이 둘이 함께 게이트가 얼마나 자주 끼어들 수 있는지를 정합니다.\n세션당은 이 저장소에 붙은 마지막 Claude Code 창이 닫힌 뒤부터의 차단 횟수입니다 — 터미널을 하나 더 열어도 예산은 나눠 쓰지 리셋되지 않습니다. 쿨다운은 한 번 막힌 뒤의 조용한 구간입니다.\n세션당을 0으로 두면 나머지는 켜둔 채 방해만 없앨 수 있습니다.',
      tipTeam:
        '팀 정책은 규칙이 아니라 "기본값"입니다: 다른 탭에서 바꿔 놓은 값이 내게는 우선 적용되며, 그게 의도된 동작입니다.\n누가 수정할 수 있는지는 정책 파일의 `leads` 목록이 정합니다. 아무도 없는 동안은 누구나 수정할 수 있고, 먼저 자기를 추가한 사람이 그걸 닫습니다.\n이 목록은 이 화면만 제한합니다. 파일 자체는 저장소 안의 JSON이라, .scale/policy.json에 대한 코드 리뷰와 CODEOWNERS가 실제 통제입니다.',
      denyPreviewCaption:
        '잠긴 영토로의 편집이 막혔을 때 에이전트가 보게 되는 문구입니다 — 게이트가 실제로 쓰는 함수가 그대로 생성합니다.',
      denyPreviewNoGate: '게이트가 꺼져 있어 편집이 막힐 일이 없습니다. 켜면 메시지를 볼 수 있습니다.',
      freqSentence: (perSession: number, cooldown: number) =>
        perSession === 0
          ? '게이트가 전혀 끼어들지 않습니다: 잠긴 영토를 아무리 건드려도 이번 세션에는 차단하지 않습니다.'
          : cooldown === 0
            ? `세션당 최대 ${perSession}번 끼어들며, 그 사이에 쉬는 시간은 없습니다.`
            : `세션당 최대 ${perSession}번 끼어들고, 한 번 끼어든 뒤에는 ${cooldown}분 동안 조용해집니다.`,
      quizPreviewCaption:
        '이 저장소의 문서로 오프라인에서 만든 샘플 확인입니다. 실제 확인은 개입 모델이 내 diff를 바탕으로 작성합니다 — 여기선 문장이 아니라 형태를 보여줍니다.',
      quizPreviewComponent: '미리보기 대상',
      quizPreviewLoading: '샘플 확인을 만드는 중…',
      quizPreviewUnavailable: '샘플을 만들 수 없습니다 — 이 저장소에는 아직 커버리지 메모리가 없습니다.',
      quizPreviewGrounding:
        '오프라인 생성기에는 세션 diff가 없어서 "무엇에 대해 묻나"는 이 미리보기에 반영되지 않습니다. 실제 확인에는 반영됩니다.',
      teamOutcome: (p) =>
        `이 기본값이면 새 팀원은: ${p.assessment} / ${p.modality}, 강제 수준 ${p.enforcement}, 확인당 ${p.items}문항, 세션당 최대 ${p.perSession}번 방해를 받게 됩니다.`,
      teamOutcomeGateOff:
        '이 기본값이면 새 팀원에게는 게이트가 꺼져 있습니다: 아무것도 차단되지 않습니다.',
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
