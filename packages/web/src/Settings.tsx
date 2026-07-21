import { useCallback, useEffect, useState, type JSX } from 'react';
import { OPENAI_INTERVENTION_IDS, type LlmProvider, type ScaleConfig } from '@scale/core/browser';
import {
  loadSettings,
  saveKey,
  saveSettings,
  type KeyStatusMap,
  type SettingsPatch,
} from './data.js';

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
  ko,
  value,
  options,
  onPick,
  disabled,
}: {
  label: string;
  ko?: string;
  value: T;
  options: { value: T; label: string; hint?: string }[];
  onPick: (v: T) => void;
  disabled?: boolean;
}): JSX.Element {
  return (
    <div className="set-row">
      <div className="set-label">
        {label}
        {ko && <span className="ko-sub"> {ko}</span>}
      </div>
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
  numeric,
  onCommit,
  className,
  placeholder,
  disabled,
  allowEmpty,
}: {
  value: string | number;
  numeric?: boolean;
  onCommit: (raw: string) => void;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
  /** Empty is a meaningful value (clears an override) rather than a mistake. */
  allowEmpty?: boolean;
}): JSX.Element {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);

  const commit = (): void => {
    if (draft.trim() === String(value)) return;
    if (!draft.trim() && !allowEmpty) {
      setDraft(String(value)); // empty is never a valid setting — snap back
      return;
    }
    onCommit(draft.trim());
  };

  return (
    <input
      className={className ?? 'set-input'}
      type={numeric ? 'number' : 'text'}
      min={numeric ? 0 : undefined}
      spellCheck={false}
      placeholder={placeholder}
      disabled={disabled}
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
          <span className="set-key-ok" title={`source: ${status.source}`}>
            ● {status.masked}
            <span className="set-key-src"> {status.source}</span>
          </span>
        ) : (
          <span className="set-key-missing">not set</span>
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
          {busy ? 'Saving…' : 'Save'}
        </button>
        {status?.source === 'file' && (
          <button
            type="button"
            className="set-btn set-btn-quiet"
            disabled={busy}
            onClick={() => void commit('')}
          >
            Clear
          </button>
        )}
      </div>
      {envShadowed && (
        <p className="set-note">
          {ENV_VAR[provider]} is set in the environment and takes precedence — anything saved here
          stays unused until you unset it.
        </p>
      )}
      {err && <p className="set-error">{err}</p>}
    </div>
  );
}

export function Settings({ onClose, focusProvider }: Props): JSX.Element {
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

  /** Apply locally, then persist; on failure re-read the server's truth. */
  const patch = useCallback(
    (p: SettingsPatch, optimistic: (c: ScaleConfig) => ScaleConfig) => {
      setConfig((cur) => (cur ? optimistic(cur) : cur));
      setSaving(true);
      setSaveErr(null);
      void saveSettings(p).then(
        (r) => {
          setConfig(r.config);
          setKeys(r.keys);
          setSaving(false);
        },
        (e: unknown) => {
          setSaveErr((e as Error).message);
          setSaving(false);
          void loadSettings().then((s) => setConfig(s.config), () => undefined);
        },
      );
    },
    [],
  );

  const body = (): JSX.Element => {
    if (loadErr) {
      return (
        <p className="set-error">
          Settings need a live <code>scale serve</code> backend: {loadErr}
        </p>
      );
    }
    if (!config || !keys) return <p className="set-note">Loading settings…</p>;

    const m = config.models;
    const triggers = config.inflow.triggers;
    const toggleTrigger = (t: 'pre-commit' | 'post-task'): void => {
      const next = triggers.includes(t) ? triggers.filter((x) => x !== t) : [...triggers, t];
      patch({ inflow: { triggers: next } }, (c) => ({ ...c, inflow: { ...c.inflow, triggers: next } }));
    };

    return (
      <>
        <section className="set-section">
          <h3 className="set-h">
            API keys <span className="ko-sub">API 키</span>
          </h3>
          <p className="set-note">
            Used for the Socratic tutor and LLM-written quests. Stored in{' '}
            <code>~/.scale/keys.json</code> (mode 0600) on this machine; never sent anywhere but the
            provider you choose.
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
          <h3 className="set-h">
            Intervention model <span className="ko-sub">개입 모델</span>
          </h3>
          <ChoiceRow
            label="Provider"
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
            label="Tier"
            ko="등급"
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
          <div className="set-row">
            <div className="set-label">
              Model id <span className="ko-sub">직접 지정</span>
            </div>
            <DraftInput
              value={m.openaiModel ?? ''}
              placeholder={
                m.provider === 'openai' ? OPENAI_INTERVENTION_IDS[m.intervention] : '(OpenAI only)'
              }
              allowEmpty
              disabled={m.provider !== 'openai'}
              onCommit={(openaiModel) =>
                patch({ models: { openaiModel: openaiModel || undefined } }, (c) => ({
                  ...c,
                  models: { ...c.models, openaiModel: openaiModel || undefined },
                }))
              }
            />
          </div>
          <ChoiceRow
            label="Build model"
            ko="지도 생성"
            value={m.build}
            disabled={saving}
            options={[
              { value: 'opus' as const, label: 'Opus' },
              { value: 'fable' as const, label: 'Fable' },
            ]}
            onPick={(build) =>
              patch({ models: { build } }, (c) => ({ ...c, models: { ...c.models, build } }))
            }
          />
          <p className="set-note">
            The build tier is Claude-only — a coverage-memory build is long-horizon reasoning. Only
            interventions (quests, Socratic dialogue) follow the provider above. Leave “Model id”
            empty to use the tier’s default GPT model.
          </p>
        </section>

        <section className="set-section">
          <h3 className="set-h">
            Condition <span className="ko-sub">개입 조건</span>
          </h3>
          <ChoiceRow
            label="Timing"
            ko="시점"
            value={config.condition.timing}
            disabled={saving}
            options={[
              { value: 'inflow' as const, label: 'In-flow', hint: 'interrupt while working' },
              { value: 'postsession' as const, label: 'Post-session', hint: 'at session end' },
            ]}
            onPick={(timing) =>
              patch({ condition: { timing } }, (c) => ({
                ...c,
                condition: { ...c.condition, timing },
              }))
            }
          />
          <ChoiceRow
            label="Modality"
            ko="방식"
            value={config.condition.modality}
            disabled={saving}
            options={[
              { value: 'quiz' as const, label: 'Quiz', hint: 'multiple choice' },
              { value: 'socratic' as const, label: 'Socratic', hint: 'dialogue (needs a key)' },
            ]}
            onPick={(modality) =>
              patch({ condition: { modality } }, (c) => ({
                ...c,
                condition: { ...c.condition, modality },
              }))
            }
          />
          <div className="set-row">
            <div className="set-label">
              In-flow triggers <span className="ko-sub">트리거</span>
            </div>
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
          <h3 className="set-h">
            Interruption budget <span className="ko-sub">방해 예산</span>
          </h3>
          <div className="set-nums">
            {(
              [
                ['maxPerCommit', 'per commit'],
                ['maxPerSession', 'per session'],
                ['cooldownMinutes', 'cooldown (min)'],
                ['minChangedLines', 'min changed lines'],
              ] as const
            ).map(([key, label]) => (
              <label className="set-num" key={key}>
                <span>{label}</span>
                <DraftInput
                  className="set-input set-input-num"
                  numeric
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
              Settings <span className="ko-sub">설정</span>
            </div>
            <div className="qr-id">{saving ? 'saving…' : 'changes save immediately'}</div>
          </div>
          <button type="button" className="panel-close" onClick={onClose} aria-label="Close settings">
            ×
          </button>
        </div>
        <div className="qr-body set-body">
          {saveErr && <p className="set-error">Could not save: {saveErr}</p>}
          {body()}
        </div>
      </div>
    </div>
  );
}
