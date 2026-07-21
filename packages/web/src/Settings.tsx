import { useCallback, useEffect, useState, type JSX } from 'react';
import {
  resolveInterventionModel as resolveIntervention,
  type Language,
  type LlmProvider,
  type ScaleConfig,
} from '@scale/core/browser';
import {
  loadSettings,
  saveKey,
  saveSettings,
  type KeyStatusMap,
  type SettingsPatch,
} from './data.js';
import { useStrings, type Strings } from './i18n.js';

/**
 * Settings modal for the served map viewer.
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

/** A labelled row of mutually exclusive choices. */
function ChoiceRow<T extends string>({
  label,
  value,
  options,
  onPick,
  disabled,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; hint?: string }[];
  onPick: (v: T) => void;
  disabled?: boolean;
}): JSX.Element {
  return (
    <div className="set-row">
      <div className="set-label">{label}</div>
      <div className="set-choices">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            className={`set-choice${value === o.value ? ' set-choice-on' : ''}`}
            aria-pressed={value === o.value}
            disabled={disabled}
            title={o.hint}
            onClick={() => onPick(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
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
}: {
  value: number;
  onCommit: (raw: string) => void;
  className?: string;
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
      min={0}
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

export function Settings({ onClose, focusProvider, onLanguageChange }: Props): JSX.Element {
  const S: Strings = useStrings();
  const [config, setConfig] = useState<ScaleConfig | null>(null);
  const [keys, setKeys] = useState<KeyStatusMap | null>(null);
  const [where, setWhere] = useState<{ repoId: string; stateDir: string } | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadSettings().then(
      (s) => {
        if (cancelled) return;
        setConfig(s.config);
        setKeys(s.keys);
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
  const patch = useCallback(
    (p: SettingsPatch, optimistic: (c: ScaleConfig) => ScaleConfig) => {
      setConfig((cur) => (cur ? optimistic(cur) : cur));
      setSaving(true);
      setSaveErr(null);
      void saveSettings(p).then(
        (r) => {
          setConfig(r.config);
          setKeys(r.keys);
          onLanguageChange(r.config.language);
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
    [onLanguageChange],
  );

  const body = (): JSX.Element => {
    if (loadErr) {
      return (
        <p className="set-error">
          {S.set.needsBackendPre} <code>scale serve</code> {S.set.needsBackendPost} {loadErr}
        </p>
      );
    }
    if (!config || !keys) return <p className="set-note">{S.set.loadingSettings}</p>;

    const m = config.models;
    const triggers = config.inflow.triggers;
    const toggleTrigger = (t: 'pre-commit' | 'post-task'): void => {
      const next = triggers.includes(t) ? triggers.filter((x) => x !== t) : [...triggers, t];
      patch({ inflow: { triggers: next } }, (c) => ({ ...c, inflow: { ...c.inflow, triggers: next } }));
    };

    return (
      <>
        <section className="set-section">
          {/* Language first: the pick re-skins this very modal live, and the
              option labels stay in their OWN language so either reader can
              always find the way back. */}
          <ChoiceRow
            label={S.set.language}
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
          <h3 className="set-h">{S.set.apiKeysHeading}</h3>
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
          <h3 className="set-h">{S.set.modelHeading}</h3>
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

        <section className="set-section">
          <h3 className="set-h">{S.set.conditionHeading}</h3>
          <ChoiceRow
            label={S.set.timing}
            value={config.condition.timing}
            disabled={saving}
            options={[
              { value: 'inflow' as const, label: S.set.inflow, hint: S.set.inflowHint },
              { value: 'postsession' as const, label: S.set.postsession, hint: S.set.postsessionHint },
            ]}
            onPick={(timing) =>
              patch({ condition: { timing } }, (c) => ({
                ...c,
                condition: { ...c.condition, timing },
              }))
            }
          />
          <ChoiceRow
            label={S.set.modality}
            value={config.condition.modality}
            disabled={saving}
            options={[
              { value: 'quiz' as const, label: S.quest.quiz, hint: S.set.quizHint },
              { value: 'socratic' as const, label: S.quest.socratic, hint: S.set.socraticHint },
            ]}
            onPick={(modality) =>
              patch({ condition: { modality } }, (c) => ({
                ...c,
                condition: { ...c.condition, modality },
              }))
            }
          />
          <div className="set-row">
            <div className="set-label">{S.set.triggers}</div>
            <div className="set-choices">
              {(['pre-commit', 'post-task'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`set-choice${triggers.includes(t) ? ' set-choice-on' : ''}`}
                  aria-pressed={triggers.includes(t)}
                  disabled={saving || config.condition.timing !== 'inflow'}
                  onClick={() => toggleTrigger(t)}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="set-section">
          <h3 className="set-h">{S.set.budgetHeading}</h3>
          <div className="set-nums">
            {(
              [
                ['maxPerCommit', S.set.perCommit],
                ['maxPerSession', S.set.perSession],
                ['cooldownMinutes', S.set.cooldownMin],
                ['minChangedLines', S.set.minChangedLines],
              ] as const
            ).map(([key, label]) => (
              <label className="set-num" key={key}>
                <span>{label}</span>
                <DraftInput
                  className="set-input set-input-num"
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
              </label>
            ))}
          </div>
        </section>

        {where && (
          <p className="set-where">
            <code>{where.stateDir}/config.json</code> · repo <code>{where.repoId}</code>
          </p>
        )}
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
        <div className="qr-body set-body">
          {saveErr && <p className="set-error">{S.set.couldNotSave} {saveErr}</p>}
          {body()}
        </div>
      </div>
    </div>
  );
}
