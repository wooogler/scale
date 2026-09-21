import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  // Aliased: the modal also installs a window-level `keydown` listener whose
  // event is the DOM KeyboardEvent, and an unaliased import shadows it.
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
  gateDenyReason,
  resolveInterventionModel as resolveIntervention,
  ScaleConfigSchema,
  type Language,
  type LlmProvider,
  type ScaleConfig,
} from '@scale/core/browser';
import {
  loadMap,
  loadPolicy,
  loadSettings,
  previewQuiz,
  saveKey,
  savePolicy,
  saveSettings,
  unsetPolicy,
  unsetSetting,
  type ConfigSource,
  type KeyStatusMap,
  type SettingsPatch,
  type SettingsSources,
  type SaveResponse,
  type PolicyPatch,
  type PolicyResponse,
  // Aliased: the local component is `QuizPreview`, the payload type is this.
  type QuizPreview as QuizPreview_,
} from './data.js';
import { useStrings, type Strings } from './i18n.js';

/**
 * Settings modal for the served map viewer.
 *
 * Laid out as four TABS (see TAB_IDS): the settings outgrew one scroll, and a
 * single column made "how often does this interrupt me" and "what does it ask
 * me" look like one undifferentiated pile of knobs. The tabs name that
 * distinction. Everything outside the panel — the save-error banner, the
 * saving/saved status in the head, the state-dir footer — belongs to the MODAL,
 * not to a tab, and stays visible on all four.
 *
 * Two kinds of state, deliberately handled differently:
 *
 *  - **config.json** (condition, in-flow triggers, budgets, models) — read and
 *    written whole through `/api/settings`. Every change is applied optimistically
 *    to local state and POSTed immediately; the server re-validates against
 *    ScaleConfigSchema, so an invalid value comes back as an error instead of
 *    landing on disk.
 *  - **API keys** — write-only. The modal never receives a key, only
 *    `{configured, source, masked}`. A key typed here is POSTed once, the input
 *    is cleared, and what remains on screen is the masked tail. When `source` is
 *    'env' the stored key is shadowed by an environment variable and we say so
 *    rather than pretending the save took effect.
 *
 * Changing the condition here is the experimenter's control for the 2×2 (PLAN
 * §6): timing × modality. It is intentionally reachable without a terminal.
 */

interface Props {
  onClose: () => void;
  /** Provider tab to focus on open (set when a missing key blocked a dialogue). */
  focusProvider?: LlmProvider | null;
  /**
   * A language pick is applied to the WHOLE app immediately (App swaps the
   * LangContext value) — optimistically, before the settings round-trip lands.
   */
  onLanguageChange: (lang: Language) => void;
  /** Tab named by a `#/settings/<tab>` deep link; null/undefined = the remembered one. */
  initialTab?: SettingsTab | null;
  /** Fires with the live tab (including the one opened on) so App can mirror it into the hash. */
  onTabChange?: (tab: SettingsTab) => void;
}

const PROVIDER_LABEL: Record<LlmProvider, string> = {
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI',
};
const ENV_VAR: Record<LlmProvider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};
const PLACEHOLDER: Record<LlmProvider, string> = {
  anthropic: 'sk-ant-…',
  openai: 'sk-…',
};

/**
 * The modal's tabs, in strip order (PLAN-GATE S4 grew it past one scroll).
 *
 * The split is by WHO changes a thing and how often: `general` is the setup a
 * junior touches once (language, keys, model tier), `gate` is the interruption
 * contract (does it fire, how hard, how often), `checks` is the shape of the
 * check itself. The gate's frequency knobs live with the gate on purpose —
 * `budgets.*` is meaningless without `gate.enabled` above it.
 *
 * `team` is last and is a different FILE: the committed `.scale/policy.json`,
 * whose values every other tab merely overrides. It is read-only for anyone the
 * policy does not list under `leads` — a UX gate so a member does not retune
 * the team's defaults thinking they are changing their own, not a security
 * boundary (the file is plain JSON in the repo; git review is the real control).
 */
const TAB_IDS = ['general', 'gate', 'checks', 'team'] as const;
type SettingsTab = (typeof TAB_IDS)[number];

/**
 * Remembered across opens. Browser storage per the usual caveats — a private
 * window or blocked site data throws on read AND on write, and the modal must
 * open on General rather than not open at all.
 *
 * It stores only what the user PICKED. A tab the modal selects on its own (the
 * missing-key jump to General) is deliberately not written back, or one blocked
 * dialogue would silently reset a junior who lives on the Checks tab.
 */
const TAB_STORAGE_KEY = 'scale.settings.tab';

function readStoredTab(): SettingsTab {
  try {
    const stored = window.localStorage.getItem(TAB_STORAGE_KEY);
    if (stored && (TAB_IDS as readonly string[]).includes(stored)) return stored as SettingsTab;
  } catch {
    /* no storage — General is a fine place to land */
  }
  return 'general';
}

function storeTab(tab: SettingsTab): void {
  try {
    window.localStorage.setItem(TAB_STORAGE_KEY, tab);
  } catch {
    /* storing a tab is a convenience, never a precondition */
  }
}

/**
 * Where a setting's value comes from, and the way back (PLAN-GATE S4).
 *
 * `yours` means the user's own sparse config names this path — it is pinned,
 * and a later change to the team policy will not move it. The reset button
 * drops that pin; its label says what will show through (the team's value if
 * the policy names one, else the schema default) so the click is informed.
 */
function Provenance({
  source,
  hasPolicy,
  onReset,
  disabled,
}: {
  source: ConfigSource | undefined;
  hasPolicy: boolean;
  onReset: () => void;
  disabled?: boolean;
}): JSX.Element | null {
  const S = useStrings();
  if (!source) return null;
  const label = source === 'user' ? S.set.srcUser : source === 'policy' ? S.set.srcPolicy : S.set.srcDefault;
  return (
    <>
      <span className={`set-src set-src-${source}`}>{label}</span>
      {source === 'user' && (
        <button type="button" className="set-reset" disabled={disabled} onClick={onReset}>
          {hasPolicy ? S.set.resetToPolicy : S.set.resetToDefault}
        </button>
      )}
    </>
  );
}

/**
 * A collapsed "?" disclosure for one setting.
 *
 * Collapsed by DEFAULT and per-row rather than a wall of prose under each
 * heading: the person who already knows what `enforcement` means should not
 * have to scroll past three sentences explaining it every time they open the
 * modal. The button and its block live in the same component so the open state
 * has one owner, and the block is a flex/grid item that spans its row — the
 * row containers already wrap, so the tip lands on its own line without
 * absolute positioning or a fixed height.
 *
 * Tip bodies carry `\n`; `.set-tip` renders with `white-space: pre-line`.
 */
function useTipToggle(id: string): {
  button: JSX.Element;
  block: (text: string) => JSX.Element | null;
} {
  const S = useStrings();
  const [open, setOpen] = useState(false);
  return {
    button: (
      <button
        type="button"
        className={`set-tip-btn${open ? ' set-tip-btn-on' : ''}`}
        aria-expanded={open}
        aria-controls={`set-tip-${id}`}
        aria-label={open ? S.set.tipHide : S.set.tipShow}
        title={open ? S.set.tipHide : S.set.tipShow}
        onClick={() => setOpen((o) => !o)}
      >
        ?
      </button>
    ),
    block: (text: string) =>
      open ? (
        <p id={`set-tip-${id}`} className="set-tip">
          {text}
        </p>
      ) : null,
  };
}

/** A section heading with an optional "?" tip under it. */
function SectionHead({ title, tip, tipId }: { title: string; tip?: string; tipId?: string }): JSX.Element {
  const t = useTipToggle(tipId ?? title);
  return (
    <>
      <h3 className="set-h set-label-row">
        {title}
        {tip ? t.button : null}
      </h3>
      {tip ? t.block(tip) : null}
    </>
  );
}

/** A labelled row of mutually exclusive choices, with an optional "?" tip. */
function ChoiceRow<T extends string>({
  label,
  value,
  options,
  onPick,
  disabled,
  provenance,
  tip,
  tipId,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; hint?: string }[];
  onPick: (v: T) => void;
  disabled?: boolean;
  provenance?: JSX.Element | null;
  /** Expanded body of the "?" disclosure. Omit for no tip. */
  tip?: string;
  tipId?: string;
}): JSX.Element {
  const t = useTipToggle(tipId ?? label);
  return (
    <div className="set-row">
      <div className="set-label set-label-row">
        {label}
        {provenance}
        {tip ? t.button : null}
      </div>
      <div className="set-choices">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            className={`set-choice${value === o.value ? ' set-choice-on' : ''}`}
            aria-pressed={value === o.value}
            disabled={disabled}
            // The one-phrase `hint` stays as the button tooltip: it names the
            // option, while the tip explains the setting. They are additive.
            title={o.hint}
            onClick={() => onPick(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
      {tip ? t.block(tip) : null}
    </div>
  );
}

/**
 * One numeric setting inside a `.set-nums` grid, with an optional "?" tip.
 *
 * Returns two grid children rather than one wrapper: the label keeps its place
 * in the two-column grid, and the tip spans every column beneath it.
 */
function NumField({
  label,
  provenance,
  tip,
  tipId,
  value,
  onCommit,
  min,
  max,
  disabled,
}: {
  label: string;
  provenance?: JSX.Element | null;
  tip?: string;
  tipId?: string;
  value: number;
  onCommit: (raw: string) => void;
  min?: number;
  max?: number;
  disabled?: boolean;
}): JSX.Element {
  const t = useTipToggle(tipId ?? label);
  return (
    <>
      <label className="set-num">
        <span className="set-label-row">
          {label}
          {provenance}
          {tip ? t.button : null}
        </span>
        <DraftInput
          className="set-input set-input-num"
          value={value}
          onCommit={onCommit}
          min={min}
          max={max}
          disabled={disabled}
        />
      </label>
      {tip ? t.block(tip) : null}
    </>
  );
}

/**
 * Free-text / numeric setting with a LOCAL draft, committed on blur or Enter.
 *
 * The draft is deliberately separate from `config`: if keystrokes wrote straight
 * into config, the blur handler would compare the typed value against itself and
 * never persist anything. `value` is the saved truth — when the server accepts
 * (or corrects, or rejects) a write, the effect re-syncs the field to it.
 */
function DraftInput({
  value,
  onCommit,
  className,
  min = 0,
  max,
  disabled,
}: {
  value: number;
  onCommit: (raw: string) => void;
  className?: string;
  /** Read-only rendering — a member viewing the team defaults. */
  disabled?: boolean;
  /**
   * Spinner bounds, mirroring the schema's. They are a CONVENIENCE, not the
   * check: a typed out-of-range value still goes to the server, which rejects
   * it against ScaleConfigSchema and comes back as the error banner. Keeping
   * the browser from being the authority is the point — the same value typed
   * into `scale config set` must fail the same way.
   */
  min?: number;
  max?: number;
}): JSX.Element {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);

  const commit = (): void => {
    if (draft.trim() === String(value)) return;
    if (!draft.trim()) {
      setDraft(String(value)); // empty is never a valid setting — snap back
      return;
    }
    onCommit(draft.trim());
  };

  return (
    <input
      className={className ?? 'set-input'}
      type="number"
      min={min}
      {...(max === undefined ? {} : { max })}
      disabled={disabled}
      spellCheck={false}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
    />
  );
}

/**
 * The REAL agent-facing deny text, for the settings currently on screen.
 *
 * Rendered client-side by `gateDenyReason` itself — the same pure function the
 * gate ships, re-exported through `@scale/core/browser`. That is the whole
 * point: a hand-written mock of this text would drift from the product the
 * first time someone edited the wording, and the settings it demonstrates
 * (assessment, enforcement, modality, every `quiz.*` leaf, language) are
 * exactly the ones whose effect is hardest to describe in a sentence. It also
 * means no round-trip, so the block re-renders on the same frame as the click.
 *
 * `component` is a real node id from the loaded map where there is one, because
 * the text embeds it and a placeholder reads like a bug.
 */
function DenyPreview({ config, component }: { config: ScaleConfig; component: string }): JSX.Element {
  const S = useStrings();
  if (!config.gate.enabled) return <p className="set-note">{S.set.denyPreviewNoGate}</p>;
  return (
    <>
      <p className="set-note">{S.set.denyPreviewCaption}</p>
      <pre className="set-preview">{gateDenyReason(component, config)}</pre>
    </>
  );
}

/**
 * A real check for the shape currently on screen, built offline by the server
 * from this repo's own component docs (`GET /api/preview/quiz`).
 *
 * Server-side because it reads `.scale/` off disk; still no model and no key —
 * it is the deterministic generator, the same one that backs a keyless check.
 * Debounced, because `items` is a number field a user can hold the spinner on.
 *
 * The answer key is not in the response and so cannot be shown: these are real
 * items the junior may be asked later.
 */
function QuizPreview({ quiz }: { quiz: ScaleConfig['quiz'] }): JSX.Element {
  const S = useStrings();
  const [preview, setPreview] = useState<QuizPreview_ | null>(null);
  const [component, setComponent] = useState<string | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(() => {
      void previewQuiz({
        items: quiz.items,
        focus: quiz.focus,
        grounding: quiz.grounding,
        ...(component ? { component } : {}),
      }).then(
        (p) => {
          if (cancelled) return;
          setPreview(p);
          setFailed(false);
          setLoading(false);
        },
        () => {
          if (cancelled) return;
          setFailed(true);
          setLoading(false);
        },
      );
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [quiz.items, quiz.focus, quiz.grounding, component]);

  if (failed && !preview) return <p className="set-note">{S.set.quizPreviewUnavailable}</p>;

  return (
    <div className="set-preview-block">
      <p className="set-note">{S.set.quizPreviewCaption}</p>
      {preview && preview.components.length > 1 && (
        <label className="set-row set-preview-pick">
          <span className="set-label set-label-row">{S.set.quizPreviewComponent}</span>
          <select
            className="set-input"
            value={preview.componentId}
            onChange={(e) => setComponent(e.target.value)}
          >
            {preview.components.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
        </label>
      )}
      {/* The previous sample stays on screen while the next one loads, so a
          keystroke in `items` does not blank the panel it is describing. */}
      <ol className={`set-sample${loading ? ' set-sample-stale' : ''}`}>
        {preview?.items.map((item, i) => (
          <li key={`${item.stem}-${i}`} className="set-sample-item">
            <span className="set-sample-stem">
              <span className={`set-dim set-dim-${item.dim}`}>{S.dim[item.dim]}</span>
              {item.stem}
            </span>
            <ul className="set-sample-opts">
              {item.options.map((o) => (
                <li key={o}>{o}</li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
      {loading && !preview && <p className="set-note">{S.set.quizPreviewLoading}</p>}
      {/* Said out loud rather than showing three identical previews for three
          different `grounding` values. */}
      {preview && !preview.groundingPreviewable && (
        <p className="set-note">{S.set.quizPreviewGrounding}</p>
      )}
    </div>
  );
}

/**
 * Schema defaults, materialized once: what a policy leaf falls back to when the
 * team has not set it. `user` is irrelevant here — only the defaulted sections
 * are read.
 */
const SCHEMA_DEFAULTS = ScaleConfigSchema.parse({ user: '' });

/** Read a dotted path out of a sparse object; undefined when any hop is absent. */
function atPath(obj: unknown, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>(
    (acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined),
    obj,
  );
}

/**
 * The mark beside a team-default row.
 *
 * A row the policy does not set shows the SCHEMA default's value, so the reader
 * always sees what is actually in force — the chip is what tells them the team
 * did not choose it. A row the team did set gets the way back instead (for a
 * lead), which removes the leaf rather than writing the default explicitly:
 * pinning today's default into the file would silently freeze the team on it
 * across a future schema change.
 */
function PolicyMark({
  isSet,
  canEdit,
  onRemove,
  disabled,
}: {
  isSet: boolean;
  canEdit: boolean;
  onRemove: () => void;
  disabled?: boolean;
}): JSX.Element | null {
  const S = useStrings();
  if (!isSet) return <span className="set-src set-src-default">{S.set.notSetChip}</span>;
  if (!canEdit) return null;
  return (
    <button type="button" className="set-reset" disabled={disabled} onClick={onRemove}>
      {S.set.removeLeaf}
    </button>
  );
}

/**
 * The Team tab: the committed `.scale/policy.json`.
 *
 * Its own fetch and its own busy/error state, deliberately separate from the
 * personal settings above — this writes a different file, on a different
 * permission, and a failed policy write must not read as a failed settings
 * write. `onPolicyChanged` re-pulls `/api/settings` afterwards, because the
 * provenance chips on the other three tabs are computed against this file and
 * would otherwise go stale the moment a lead changes a default.
 */
function TeamPanel({ onPolicyChanged }: { onPolicyChanged: () => void }): JSX.Element {
  const S = useStrings();
  const [policy, setPolicy] = useState<PolicyResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    let cancelled = false;
    void loadPolicy().then(
      (p) => !cancelled && setPolicy(p),
      (e: unknown) => !cancelled && setErr((e as Error).message),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  /** Run one policy write, then refresh both this tab and the provenance chips. */
  const run = useCallback(
    (op: () => Promise<PolicyResponse>) => {
      setBusy(true);
      setErr(null);
      void op().then(
        (p) => {
          setPolicy(p);
          setBusy(false);
          onPolicyChanged();
        },
        (e: unknown) => {
          setErr((e as Error).message);
          setBusy(false);
        },
      );
    },
    [onPolicyChanged],
  );

  if (err && !policy) return <p className="set-error">{err}</p>;
  if (!policy) return <p className="set-note">{S.set.loadingSettings}</p>;

  const canEdit = policy.isLead;
  const locked = !canEdit || busy;
  const leads = policy.leads;
  const mine = policy.identity;
  const meListed = mine.some((e) => leads.includes(e.toLowerCase()));

  /** Current value of a policy leaf, and whether the TEAM set it. */
  const leaf = (dotted: string): { value: unknown; isSet: boolean } => {
    const fromPolicy = atPath(policy.raw, dotted);
    return fromPolicy === undefined
      ? { value: atPath(SCHEMA_DEFAULTS, dotted), isSet: false }
      : { value: fromPolicy, isSet: true };
  };

  /**
   * The one-sentence outcome of this file for someone with no personal
   * overrides: the policy layered over the schema defaults, which is exactly
   * what `resolveConfig` gives a brand-new member.
   */
  // Only the sections a policy may actually default — `leads` is not one, and
  // a personal key in the file is inert. safeParse, because a policy that fails
  // validation is ignored whole by the server and must not crash this panel.
  const raw = policy.raw ?? {};
  const overlay = SCHEMA_DEFAULTS;
  const parsed = ScaleConfigSchema.safeParse({
    user: '',
    gate: raw.gate,
    quiz: raw.quiz,
    unlock: raw.unlock,
    exempt: raw.exempt,
    drift: raw.drift,
    budgets: raw.budgets,
    thresholds: raw.thresholds,
  });
  const resolved = parsed.success ? parsed.data : overlay;
  const outcome = resolved.gate.enabled
    ? S.set.teamOutcome({
        assessment: resolved.gate.assessment === 'sync' ? S.set.assessSync : S.set.assessAsync,
        modality: resolved.gate.modality === 'quiz' ? S.quest.quiz : S.quest.socratic,
        enforcement:
          resolved.gate.enforcement === 'advisory'
            ? S.set.enfAdvisory
            : resolved.gate.enforcement === 'soft'
              ? S.set.enfSoft
              : S.set.enfHard,
        items: resolved.quiz.items,
        perSession: resolved.budgets.maxPerSession,
      })
    : S.set.teamOutcomeGateOff;

  const mark = (dotted: string, isSet: boolean): JSX.Element | null => (
    <PolicyMark
      isSet={isSet}
      canEdit={canEdit}
      disabled={busy}
      onRemove={() => run(() => unsetPolicy(dotted))}
    />
  );

  /** One enum row over a policy leaf. */
  const choice = <T extends string>(
    dotted: string,
    label: string,
    options: { value: T; label: string; hint?: string }[],
    toPatch: (v: T) => PolicyPatch,
    /** For a leaf whose stored type is not the option token (gate.enabled). */
    toToken: (stored: unknown) => T = (stored) => stored as T,
  ): JSX.Element => {
    const { value, isSet } = leaf(dotted);
    return (
      <ChoiceRow
        label={label}
        provenance={mark(dotted, isSet)}
        value={toToken(value)}
        disabled={locked}
        options={options}
        onPick={(v) => run(() => savePolicy(toPatch(v)))}
      />
    );
  };

  /** One numeric row over a policy leaf. */
  const num = (
    dotted: string,
    label: string,
    toPatch: (v: number) => PolicyPatch,
    bounds?: { min?: number; max?: number },
  ): JSX.Element => {
    const { value, isSet } = leaf(dotted);
    return (
      <label className="set-num" key={dotted}>
        <span className="set-label-row">
          {label}
          {mark(dotted, isSet)}
        </span>
        <DraftInput
          className="set-input set-input-num"
          value={typeof value === 'number' ? value : 0}
          disabled={locked}
          min={bounds?.min}
          max={bounds?.max}
          onCommit={(raw) => {
            const v = Number(raw);
            if (!Number.isFinite(v)) return;
            run(() => savePolicy(toPatch(v)));
          }}
        />
      </label>
    );
  };

  const addLead = (email: string): void => {
    const clean = email.trim().toLowerCase();
    if (!clean || leads.includes(clean)) return;
    setDraft('');
    run(() => savePolicy({ leads: [...leads, clean] }));
  };

  return (
    <>
      <section className="set-section">
        <SectionHead title={S.set.teamHeading} tip={S.set.tipTeam} tipId="team" />
        <p className="set-note">
          {S.set.yourIdentity}{' '}
          {mine.length > 0 ? (
            mine.map((e, i) => (
              <span key={e}>
                {i > 0 && ', '}
                <code>{e}</code>
              </span>
            ))
          ) : (
            <em>{S.set.noIdentity}</em>
          )}{' '}
          <span className={`set-src ${canEdit ? 'set-src-user' : 'set-src-policy'}`}>
            {canEdit ? S.set.roleLead : S.set.roleMember}
          </span>
        </p>
        {!canEdit && <p className="set-note">{S.set.memberNote}</p>}
        {leads.length === 0 && <p className="set-note">{S.set.bootstrapNote}</p>}
        {policy.warning && <p className="set-error">{S.set.lastLeadWarning}</p>}
        {err && <p className="set-error">{err}</p>}
      </section>

      <section className="set-section">
        <h3 className="set-h">{S.set.leadsHeading}</h3>
        {leads.length === 0 ? (
          <p className="set-note">{S.set.leadsEmpty}</p>
        ) : (
          <ul className="set-leads">
            {leads.map((email) => (
              <li key={email} className="set-lead">
                <code>{email}</code>
                {canEdit && (
                  <button
                    type="button"
                    className="set-reset"
                    disabled={busy}
                    aria-label={S.set.removeLead(email)}
                    onClick={() => run(() => savePolicy({ leads: leads.filter((l) => l !== email) }))}
                  >
                    ×
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {canEdit && (
          <div className="set-key-row">
            <input
              className="set-input"
              type="email"
              autoComplete="off"
              spellCheck={false}
              placeholder={S.set.addLeadPlaceholder}
              value={draft}
              disabled={busy}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && draft.trim()) addLead(draft);
              }}
            />
            <button
              type="button"
              className="set-btn"
              disabled={busy || !draft.trim()}
              onClick={() => addLead(draft)}
            >
              {S.set.addLead}
            </button>
            {/* The one click that closes bootstrap, which is the whole point of
                the list — worth not making someone retype their own address. */}
            {mine.length > 0 && !meListed && (
              <button
                type="button"
                className="set-btn set-btn-quiet"
                disabled={busy}
                onClick={() => addLead(mine[0]!)}
              >
                {S.set.addMe}
              </button>
            )}
          </div>
        )}
        <p className="set-note">{S.set.notSecurityNote}</p>
      </section>

      <section className="set-section">
        <h3 className="set-h">{S.set.defaultsHeading}</h3>
        {/* What the FILE actually does, in one sentence. A lead editing leaf by
            leaf otherwise has to hold the resolved outcome in their head — and
            it is resolved, not raw: every leaf the policy leaves alone still
            reaches a new member as its schema default. */}
        <p className="set-preview-line">{outcome}</p>
        {!canEdit && <p className="set-note">{S.set.readOnlyNote}</p>}

        {choice<'on' | 'off'>(
          'gate.enabled',
          S.set.gateEnabled,
          [
            { value: 'on', label: S.set.gateOn, hint: S.set.gateOnHint },
            { value: 'off', label: S.set.gateOff, hint: S.set.gateOffHint },
          ],
          (v) => ({ gate: { enabled: v === 'on' } }),
          // Stored as a boolean; the row speaks on/off.
          (stored) => (stored === false ? 'off' : 'on'),
        )}
        {choice<'sync' | 'async'>(
          'gate.assessment',
          S.set.assessment,
          [
            { value: 'sync', label: S.set.assessSync, hint: S.set.assessSyncHint },
            { value: 'async', label: S.set.assessAsync, hint: S.set.assessAsyncHint },
          ],
          (assessment) => ({ gate: { assessment } }),
        )}
        {choice<'quiz' | 'socratic'>(
          'gate.modality',
          S.set.modality,
          [
            { value: 'quiz', label: S.quest.quiz, hint: S.set.quizHint },
            { value: 'socratic', label: S.quest.socratic, hint: S.set.socraticHint },
          ],
          (modality) => ({ gate: { modality } }),
        )}
        {choice<'advisory' | 'soft' | 'hard'>(
          'gate.enforcement',
          S.set.enforcement,
          [
            { value: 'advisory', label: S.set.enfAdvisory, hint: S.set.enfAdvisoryHint },
            { value: 'soft', label: S.set.enfSoft, hint: S.set.enfSoftHint },
            { value: 'hard', label: S.set.enfHard, hint: S.set.enfHardHint },
          ],
          (enforcement) => ({ gate: { enforcement } }),
        )}

        <div className="set-nums">
          {num('quiz.items', S.set.checkItems, (items) => ({ quiz: { items } }), {
            min: 1,
            max: 5,
          })}
        </div>
        {choice<'auto' | 'structure' | 'concepts' | 'rationale'>(
          'quiz.focus',
          S.set.checkFocus,
          [
            { value: 'auto', label: S.set.focusAuto, hint: S.set.focusAutoHint },
            { value: 'structure', label: S.set.focusStructure, hint: S.set.focusStructureHint },
            { value: 'concepts', label: S.set.focusConcepts, hint: S.set.focusConceptsHint },
            { value: 'rationale', label: S.set.focusRationale, hint: S.set.focusRationaleHint },
          ],
          (focus) => ({ quiz: { focus } }),
        )}
        {choice<'balanced' | 'diff' | 'doc'>(
          'quiz.grounding',
          S.set.checkGrounding,
          [
            { value: 'balanced', label: S.set.groundBalanced, hint: S.set.groundBalancedHint },
            { value: 'diff', label: S.set.groundDiff, hint: S.set.groundDiffHint },
            { value: 'doc', label: S.set.groundDoc, hint: S.set.groundDocHint },
          ],
          (grounding) => ({ quiz: { grounding } }),
        )}

        <div className="set-nums">
          {num(
            'budgets.maxPerSession',
            S.set.perSession,
            (maxPerSession) => ({ budgets: { maxPerSession } }),
            { min: 0 },
          )}
          {num(
            'budgets.cooldownMinutes',
            S.set.cooldownMin,
            (cooldownMinutes) => ({ budgets: { cooldownMinutes } }),
            { min: 0 },
          )}
        </div>
      </section>

      <p className="set-where">
        {S.set.policyPathLabel} <code>{policy.path}</code>
        {' · '}
        {!policy.exists ? (
          <span className="set-policy-missing">{S.set.policyMissing}</span>
        ) : policy.dirty ? (
          <span className="set-policy-dirty">{S.set.dirtyBadge}</span>
        ) : (
          <span className="set-policy-clean">{S.set.committedBadge}</span>
        )}
      </p>
    </>
  );
}

function KeyField({
  provider,
  status,
  onSaved,
  autoFocus,
}: {
  provider: LlmProvider;
  status: KeyStatusMap[LlmProvider] | undefined;
  onSaved: (keys: KeyStatusMap) => void;
  autoFocus?: boolean;
}): JSX.Element {
  const S = useStrings();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const commit = async (value: string): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      onSaved(await saveKey(provider, value));
      setDraft(''); // never keep the secret in component state after the POST
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const envShadowed = status?.source === 'env';

  return (
    <div className="set-key">
      <div className="set-key-head">
        <span className="set-key-name">{PROVIDER_LABEL[provider]}</span>
        {status?.configured ? (
          <span className="set-key-ok" title={S.set.keySource(status.source ?? '')}>
            ● {status.masked}
            <span className="set-key-src"> {status.source}</span>
          </span>
        ) : (
          <span className="set-key-missing">{S.set.notSet}</span>
        )}
      </div>
      <div className="set-key-row">
        <input
          className="set-input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          autoFocus={autoFocus}
          placeholder={PLACEHOLDER[provider]}
          value={draft}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && draft.trim()) void commit(draft);
          }}
        />
        <button
          type="button"
          className="set-btn"
          disabled={busy || !draft.trim()}
          onClick={() => void commit(draft)}
        >
          {busy ? S.set.savingBtn : S.set.save}
        </button>
        {status?.source === 'file' && (
          <button
            type="button"
            className="set-btn set-btn-quiet"
            disabled={busy}
            onClick={() => void commit('')}
          >
            {S.set.clear}
          </button>
        )}
      </div>
      {envShadowed && <p className="set-note">{S.set.envShadowed(ENV_VAR[provider])}</p>}
      {err && <p className="set-error">{err}</p>}
    </div>
  );
}

export function Settings({
  onClose,
  focusProvider,
  onLanguageChange,
  initialTab,
  onTabChange,
}: Props): JSX.Element {
  const S: Strings = useStrings();
  const [config, setConfig] = useState<ScaleConfig | null>(null);
  const [keys, setKeys] = useState<KeyStatusMap | null>(null);
  const [policy, setPolicy] = useState<{ present: boolean; applied: boolean } | null>(null);
  const [sources, setSources] = useState<SettingsSources>({});
  const [where, setWhere] = useState<{ repoId: string; stateDir: string } | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // A missing key that just blocked a dialogue wins over the remembered tab:
  // the key field is on General and it is about to take focus, so opening
  // anywhere else would autoFocus an input nobody can see.
  const [tab, setTab] = useState<SettingsTab>(() =>
    focusProvider ? 'general' : (initialTab ?? readStoredTab()),
  );
  const tabRefs = useRef<Partial<Record<SettingsTab, HTMLButtonElement | null>>>({});

  /**
   * A real component id for the deny-message preview to name.
   *
   * The deny text embeds the territory it is about, and a literal placeholder
   * there reads like a bug in the product rather than a stand-in. The first map
   * node is a component this user actually has; `loadMap` falls back to sample
   * data when there is no backend, so this never blocks the modal.
   */
  const [sampleComponent, setSampleComponent] = useState('your-component');
  useEffect(() => {
    let cancelled = false;
    void loadMap().then(
      (m) => {
        const first = m.nodes[0];
        if (!cancelled && first) setSampleComponent(first.id);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (focusProvider) setTab('general'); // not stored — see TAB_STORAGE_KEY
  }, [focusProvider]);

  // A deep link that lands while the modal is already open (someone pasted a
  // new `#/settings/<tab>` into the tab) moves it. Not stored, same reasoning.
  useEffect(() => {
    if (initialTab) setTab(initialTab);
  }, [initialTab]);

  // Report the live tab up so the address bar can name it — including the tab
  // we opened on, which App cannot predict (it may come from localStorage).
  useEffect(() => {
    onTabChange?.(tab);
  }, [tab, onTabChange]);

  /** A tab the USER chose: select it and remember it for the next open. */
  const pickTab = useCallback((next: SettingsTab) => {
    setTab(next);
    storeTab(next);
  }, []);

  /**
   * Roving arrow-key navigation (WAI-ARIA tabs pattern): ←/→ move selection and
   * carry focus with it, wrapping at both ends. Only the selected tab is in the
   * page's tab order, so Tab moves OUT of the strip into the panel rather than
   * through three buttons.
   */
  const onTabKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const delta = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (delta === 0) return;
    e.preventDefault();
    const at = TAB_IDS.indexOf(tab);
    const next = TAB_IDS[(at + delta + TAB_IDS.length) % TAB_IDS.length]!;
    pickTab(next);
    tabRefs.current[next]?.focus();
  };

  useEffect(() => {
    let cancelled = false;
    void loadSettings().then(
      (s) => {
        if (cancelled) return;
        setConfig(s.config);
        setKeys(s.keys);
        setPolicy(s.policy ?? null);
        setSources(s.sources ?? {});
        setWhere({ repoId: s.repoId, stateDir: s.stateDir });
      },
      (e: unknown) => {
        if (!cancelled) setLoadErr((e as Error).message);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // Esc closes, matching the quest runner's overlay behaviour.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /**
   * Apply locally, then persist; on failure re-read the server's truth.
   *
   * Language needs one extra step on BOTH outcomes: the pick was applied
   * app-wide optimistically (onLanguageChange fires before the save), so the
   * global LangContext must be re-synced to whatever the server actually holds —
   * otherwise a failed save leaves the whole UI in a language config.json
   * doesn't have, desynced until a full reload.
   */
  const applySaved = useCallback(
    (r: SaveResponse) => {
      setConfig(r.config);
      setKeys(r.keys);
      if (r.sources) setSources(r.sources);
      onLanguageChange(r.config.language);
    },
    [onLanguageChange],
  );

  /**
   * Re-pull `/api/settings` after the TEAM policy changed.
   *
   * Nothing in the user's own file moved, but the provenance chips did: a leaf
   * that read `default` reads `policy` the moment a lead sets it, and a `yours`
   * leaf gains a "↺ team default" that points somewhere new. Without this the
   * other three tabs would keep showing the pre-edit picture until the modal
   * was reopened.
   */
  const refreshSettings = useCallback(() => {
    void loadSettings().then((s) => {
      setConfig(s.config);
      setKeys(s.keys);
      setPolicy(s.policy ?? null);
      setSources(s.sources ?? {});
    }, () => undefined);
  }, []);

  /** Drop one personal override; the server answers with what now applies. */
  const reset = useCallback(
    (path: string) => {
      setSaving(true);
      setSaveErr(null);
      void unsetSetting(path).then(
        (r) => {
          applySaved(r);
          setSaving(false);
        },
        (e: unknown) => {
          setSaveErr((e as Error).message);
          setSaving(false);
        },
      );
    },
    [applySaved],
  );

  /** Provenance chip + reset for one dotted path. */
  const prov = (path: string): JSX.Element | null => (
    <Provenance
      source={sources[path]?.source}
      hasPolicy={sources[path]?.policyValue !== undefined}
      disabled={saving}
      onReset={() => reset(path)}
    />
  );

  const patch = useCallback(
    (p: SettingsPatch, optimistic: (c: ScaleConfig) => ScaleConfig) => {
      setConfig((cur) => (cur ? optimistic(cur) : cur));
      setSaving(true);
      setSaveErr(null);
      void saveSettings(p).then(
        (r) => {
          applySaved(r);
          setSaving(false);
        },
        (e: unknown) => {
          setSaveErr((e as Error).message);
          setSaving(false);
          void loadSettings().then(
            (s) => {
              setConfig(s.config);
              onLanguageChange(s.config.language); // roll back the optimistic switch
            },
            () => undefined,
          );
        },
      );
    },
    [onLanguageChange, applySaved],
  );

  const body = (): JSX.Element => {
    if (loadErr) {
      return (
        <p className="set-error">
          {S.set.needsBackendPre} <code>scale serve</code> {S.set.needsBackendPost} {loadErr}
        </p>
      );
    }
    // The Team tab reads a different file and is useful even while the personal
    // settings are still loading — and its own fetch is what it waits on.
    if (tab === 'team') return <TeamPanel onPolicyChanged={refreshSettings} />;

    if (!config || !keys) return <p className="set-note">{S.set.loadingSettings}</p>;

    const m = config.models;

    // Where a setting's value came from, and the way back. Shown on every tab
    // that carries provenance chips — each tab has to stand on its own, and a
    // reader who opens straight into Checks would otherwise meet "yours"/"team
    // default" with nothing explaining them.
    const provenanceNotes = (
      <>
        {policy?.applied ? <p className="set-note">{S.set.policyNote}</p> : null}
        <p className="set-note">{S.set.provenanceNote}</p>
      </>
    );

    if (tab === 'gate') {
      return (
        <>
          <section className="set-section">
            <h3 className="set-h">{S.set.gateHeading}</h3>
            <ChoiceRow
              label={S.set.gateEnabled}
              tip={S.set.tipGateEnabled}
              tipId="gate-enabled"
              provenance={prov('gate.enabled')}
              value={config.gate.enabled ? 'on' : 'off'}
              disabled={saving}
              options={[
                { value: 'on' as const, label: S.set.gateOn, hint: S.set.gateOnHint },
                { value: 'off' as const, label: S.set.gateOff, hint: S.set.gateOffHint },
              ]}
              onPick={(v) =>
                patch({ gate: { enabled: v === 'on' } }, (c) => ({
                  ...c,
                  gate: { ...c.gate, enabled: v === 'on' },
                }))
              }
            />
            <ChoiceRow
              label={S.set.assessment}
              tip={S.set.tipAssessment}
              tipId="gate-assessment"
              provenance={prov('gate.assessment')}
              value={config.gate.assessment}
              disabled={saving}
              options={[
                { value: 'sync' as const, label: S.set.assessSync, hint: S.set.assessSyncHint },
                { value: 'async' as const, label: S.set.assessAsync, hint: S.set.assessAsyncHint },
              ]}
              onPick={(assessment) =>
                patch({ gate: { assessment } }, (c) => ({
                  ...c,
                  gate: { ...c.gate, assessment },
                }))
              }
            />
            <ChoiceRow
              label={S.set.modality}
              tip={S.set.tipModality}
              tipId="gate-modality"
              provenance={prov('gate.modality')}
              value={config.gate.modality}
              disabled={saving}
              options={[
                { value: 'quiz' as const, label: S.quest.quiz, hint: S.set.quizHint },
                { value: 'socratic' as const, label: S.quest.socratic, hint: S.set.socraticHint },
              ]}
              onPick={(modality) =>
                patch({ gate: { modality } }, (c) => ({
                  ...c,
                  gate: { ...c.gate, modality },
                }))
              }
            />
            <ChoiceRow
              label={S.set.enforcement}
              tip={S.set.tipEnforcement}
              tipId="gate-enforcement"
              provenance={prov('gate.enforcement')}
              value={config.gate.enforcement}
              disabled={saving}
              options={[
                {
                  value: 'advisory' as const,
                  label: S.set.enfAdvisory,
                  hint: S.set.enfAdvisoryHint,
                },
                { value: 'soft' as const, label: S.set.enfSoft, hint: S.set.enfSoftHint },
                { value: 'hard' as const, label: S.set.enfHard, hint: S.set.enfHardHint },
              ]}
              onPick={(enforcement) =>
                patch({ gate: { enforcement } }, (c) => ({
                  ...c,
                  gate: { ...c.gate, enforcement },
                }))
              }
            />
            <DenyPreview config={config} component={sampleComponent} />
          </section>

          <section className="set-section">
            <SectionHead title={S.set.budgetHeading} tip={S.set.tipBudgets} tipId="budgets" />
            <div className="set-nums">
              {(
                [
                  ['maxPerSession', S.set.perSession],
                  ['cooldownMinutes', S.set.cooldownMin],
                ] as const
              ).map(([key, label]) => (
                <NumField
                  key={key}
                  label={label}
                  provenance={prov(`budgets.${key}`)}
                  value={config.budgets[key]}
                  onCommit={(raw) => {
                    const v = Number(raw);
                    if (!Number.isFinite(v)) return;
                    patch({ budgets: { [key]: v } }, (c) => ({
                      ...c,
                      budgets: { ...c.budgets, [key]: v },
                    }));
                  }}
                />
              ))}
            </div>
            {/* The two numbers said back as one sentence — the pair is easy to
                set and hard to picture. */}
            <p className="set-preview-line">
              {S.set.freqSentence(config.budgets.maxPerSession, config.budgets.cooldownMinutes)}
            </p>
            <p className="set-note">{S.set.budgetNote}</p>
          </section>

          {provenanceNotes}
        </>
      );
    }

    if (tab === 'checks') {
      return (
        <>
          <section className="set-section">
            <h3 className="set-h">{S.set.checkHeading}</h3>
            <div className="set-nums">
              <NumField
                label={S.set.checkItems}
                tip={S.set.tipItems}
                tipId="quiz-items"
                provenance={prov('quiz.items')}
                value={config.quiz.items}
                min={1}
                max={5}
                onCommit={(raw) => {
                  const v = Number(raw);
                  if (!Number.isFinite(v)) return;
                  patch({ quiz: { items: v } }, (c) => ({ ...c, quiz: { ...c.quiz, items: v } }));
                }}
              />
            </div>
            <p className="set-note">{S.set.checkItemsHint}</p>
            <ChoiceRow
              label={S.set.checkFocus}
              tip={S.set.tipFocus}
              tipId="quiz-focus"
              provenance={prov('quiz.focus')}
              value={config.quiz.focus}
              disabled={saving}
              options={[
                { value: 'auto' as const, label: S.set.focusAuto, hint: S.set.focusAutoHint },
                {
                  value: 'structure' as const,
                  label: S.set.focusStructure,
                  hint: S.set.focusStructureHint,
                },
                {
                  value: 'concepts' as const,
                  label: S.set.focusConcepts,
                  hint: S.set.focusConceptsHint,
                },
                {
                  value: 'rationale' as const,
                  label: S.set.focusRationale,
                  hint: S.set.focusRationaleHint,
                },
              ]}
              onPick={(focus) =>
                patch({ quiz: { focus } }, (c) => ({ ...c, quiz: { ...c.quiz, focus } }))
              }
            />
            <ChoiceRow
              label={S.set.checkGrounding}
              tip={S.set.tipGrounding}
              tipId="quiz-grounding"
              provenance={prov('quiz.grounding')}
              value={config.quiz.grounding}
              disabled={saving}
              options={[
                {
                  value: 'balanced' as const,
                  label: S.set.groundBalanced,
                  hint: S.set.groundBalancedHint,
                },
                { value: 'diff' as const, label: S.set.groundDiff, hint: S.set.groundDiffHint },
                { value: 'doc' as const, label: S.set.groundDoc, hint: S.set.groundDocHint },
              ]}
              onPick={(grounding) =>
                patch({ quiz: { grounding } }, (c) => ({ ...c, quiz: { ...c.quiz, grounding } }))
              }
            />
            <p className="set-note">{S.set.checkNote}</p>
            <QuizPreview quiz={config.quiz} />
          </section>

          {provenanceNotes}
        </>
      );
    }

    return (
      <>
        <section className="set-section">
          {/* Language first: the pick re-skins this very modal live, and the
              option labels stay in their OWN language so either reader can
              always find the way back. */}
          <ChoiceRow
            label={S.set.language}
            tip={S.set.tipLanguage}
            tipId="language"
            value={config.language}
            disabled={saving}
            options={[
              { value: 'en' as Language, label: 'English' },
              { value: 'ko' as Language, label: '한국어' },
            ]}
            onPick={(language) => {
              onLanguageChange(language); // whole app, immediately
              patch({ language }, (c) => ({ ...c, language }));
            }}
          />
          <p className="set-note">{S.set.languageNote}</p>
        </section>

        <section className="set-section">
          <SectionHead title={S.set.apiKeysHeading} tip={S.set.tipKeys} tipId="keys" />
          <p className="set-note">
            {S.set.keysNotePre} <code>~/.scale/keys.json</code> {S.set.keysNotePost}
          </p>
          {(['anthropic', 'openai'] as LlmProvider[]).map((p) => (
            <KeyField
              key={p}
              provider={p}
              status={keys[p]}
              autoFocus={focusProvider === p}
              onSaved={setKeys}
            />
          ))}
        </section>

        <section className="set-section">
          <SectionHead title={S.set.modelHeading} tip={S.set.tipModel} tipId="model" />
          <ChoiceRow
            label={S.set.provider}
            value={m.provider}
            disabled={saving}
            options={[
              { value: 'anthropic' as LlmProvider, label: 'Anthropic' },
              { value: 'openai' as LlmProvider, label: 'OpenAI' },
            ]}
            onPick={(provider) =>
              patch({ models: { provider } }, (c) => ({ ...c, models: { ...c.models, provider } }))
            }
          />
          {/* One tier token drives both providers, so switching provider keeps
              the tier you picked instead of silently changing model class. */}
          <ChoiceRow
            label={S.set.tier}
            value={m.intervention}
            disabled={saving}
            options={
              m.provider === 'anthropic'
                ? [
                    { value: 'sonnet' as const, label: 'Sonnet 5', hint: 'claude-sonnet-5' },
                    { value: 'opus' as const, label: 'Opus 4.8', hint: 'claude-opus-4-8' },
                  ]
                : [
                    { value: 'sonnet' as const, label: 'GPT-5.6 Terra', hint: 'gpt-5.6-terra' },
                    { value: 'opus' as const, label: 'GPT-5.6 Sol', hint: 'gpt-5.6-sol' },
                  ]
            }
            onPick={(intervention) =>
              patch({ models: { intervention } }, (c) => ({
                ...c,
                models: { ...c.models, intervention },
              }))
            }
          />
          <p className="set-note">
            {S.set.modelNoteRuns} <code>{resolveIntervention(m)}</code>. {S.set.modelNoteBuildPre}
            <code>/scale-map</code>
            {S.set.modelNoteBuildMid}
            <code>/model</code>
            {S.set.modelNoteBuildPost}
          </p>
        </section>
      </>
    );
  };

  return (
    <div className="qr-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="qr-modal set-modal" onClick={(e) => e.stopPropagation()}>
        <div className="qr-head">
          <div>
            <div className="qr-kicker">
              <span className="qr-kicker-badge set-badge">⚙</span>
              {S.set.title}
            </div>
            <div className="qr-id">{saving ? S.set.saving : S.set.savesImmediately}</div>
          </div>
          <button
            type="button"
            className="panel-close"
            onClick={onClose}
            aria-label={S.set.closeSettings}
          >
            ×
          </button>
        </div>
        {/* The strip only appears once there is something to switch BETWEEN:
            while settings are loading, or when the backend is unreachable, the
            modal has one message to show and three dead tabs would be noise. */}
        {config && keys && !loadErr && (
          <div className="set-tabs" role="tablist" aria-label={S.set.title} onKeyDown={onTabKeyDown}>
            {TAB_IDS.map((id) => (
              <button
                key={id}
                ref={(el) => {
                  tabRefs.current[id] = el;
                }}
                type="button"
                role="tab"
                id={`set-tab-${id}`}
                aria-controls="set-tabpanel"
                aria-selected={tab === id}
                tabIndex={tab === id ? 0 : -1}
                className={`set-tab${tab === id ? ' set-tab-on' : ''}`}
                onClick={() => pickTab(id)}
              >
                {S.set.tab[id]}
              </button>
            ))}
          </div>
        )}
        <div className="qr-body set-body">
          {/* Outside the panel on purpose: a save that failed on one tab is
              still the modal's state, and the state-dir footer answers "which
              config am I even editing" no matter which tab is open. */}
          {saveErr && <p className="set-error">{S.set.couldNotSave} {saveErr}</p>}
          <div
            id="set-tabpanel"
            role="tabpanel"
            aria-labelledby={`set-tab-${tab}`}
            className="set-panel"
          >
            {body()}
          </div>
          {where && (
            <p className="set-where">
              <code>{where.stateDir}/config.json</code> · repo <code>{where.repoId}</code>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
