import { useRef, useState, useEffect, type JSX } from 'react';
import type {
  ComponentCoverage,
  DimName,
  LlmProvider,
  Quest,
  QuestItem,
} from '@scale/core/browser';
import { skinFor, QUEST_SKIN } from './skin.js';
import {
  completeQuiz,
  sendSocraticMessage,
  type CompleteResponse,
  type DimResult,
  type SocraticResponse,
} from './data.js';
import { useLang, useStrings } from './i18n.js';

interface Props {
  quest: Quest;
  /** Component display title (falls back to the id). */
  title: string;
  onClose: () => void;
  /** Called once coverage has actually moved, so the map can re-fetch + animate. */
  onCompleted: (componentId: string, component: ComponentCoverage) => void;
  /** Open this component's paper (the "just read it" escape hatch). */
  onReadPaper: () => void;
  /** Open the settings modal, optionally focused on a provider's key field. */
  onOpenSettings: (provider?: LlmProvider) => void;
}

const OPTION_LETTERS = ['A', 'B', 'C', 'D'];
const DIM_KEYS: DimName[] = ['structure', 'concepts', 'rationale'];

/** Read the loosely-typed extras off a passthrough QuestItem. */
function itemField<T>(item: QuestItem, key: string): T | undefined {
  return (item as unknown as Record<string, unknown>)[key] as T | undefined;
}

function DimResultBar({ dim, score }: { dim: DimName; score: number }): JSX.Element {
  const S = useStrings();
  const pct = Math.round(score * 100);
  return (
    <div className="qr-dimline">
      <span className="qr-dimname">{S.dim[dim]}</span>
      <div className="qr-dimbar">
        <div className="qr-dimfill" style={{ width: `${pct}%` }} />
      </div>
      <span className="qr-dimval">{pct}</span>
    </div>
  );
}

/** Post-completion summary shared by both modalities. */
function Outcome({
  component,
  grades,
}: {
  component: ComponentCoverage;
  grades?: Record<DimName, number>;
}): JSX.Element {
  const S = useStrings();
  const skin = skinFor(component.state, component.driftCause ?? null);
  return (
    <div className="qr-outcome">
      <div className="qr-won">
        <span className="qr-won-badge" style={{ background: skin.color }}>
          {QUEST_SKIN.badge}
        </span>
        <div>
          <div className="qr-won-title">{S.quest.won}</div>
          <div className="qr-won-state">
            → <strong style={{ color: skin.color }}>{S.state[component.state].label}</strong>
          </div>
        </div>
      </div>
      <div className="qr-outcome-stats">
        <div className="qr-outcome-head">
          {S.devStats} {grades ? `· ${S.grades}` : ''}
        </div>
        {DIM_KEYS.map((d) => (
          <DimResultBar key={d} dim={d} score={grades ? grades[d] : component.dims[d]} />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Quiz
// ---------------------------------------------------------------------------

function QuizRunner({ quest, onCompleted }: { quest: Quest; onCompleted: Props['onCompleted'] }): JSX.Element {
  const S = useStrings();
  const items = quest.items;
  const [picks, setPicks] = useState<(number | null)[]>(() => items.map(() => null));
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CompleteResponse | null>(null);

  const allAnswered = picks.every((p) => p !== null);

  const submit = async (): Promise<void> => {
    if (!allAnswered || busy) return;
    setBusy(true);
    // Tally per-dim: average correctness across items sharing a dim (§5.1).
    const byDim = new Map<DimName, { sum: number; n: number }>();
    items.forEach((item, i) => {
      const dim = (itemField<DimName>(item, 'dim') ?? 'concepts') as DimName;
      const correctIndex = itemField<number>(item, 'correctIndex') ?? 0;
      const score = picks[i] === correctIndex ? 1 : 0;
      const cur = byDim.get(dim) ?? { sum: 0, n: 0 };
      cur.sum += score;
      cur.n += 1;
      byDim.set(dim, cur);
    });
    const results: DimResult[] = [...byDim.entries()].map(([dim, { sum, n }]) => ({
      dim,
      score: n ? sum / n : 0,
    }));
    const res = await completeQuiz(quest.id, results);
    setResult(res);
    setSubmitted(true);
    setBusy(false);
    onCompleted(res.componentId || quest.componentId, res.component);
  };

  return (
    <div className="qr-body">
      <div className="qr-cards">
        {items.map((item, i) => {
          const options = itemField<string[]>(item, 'options') ?? [];
          const correctIndex = itemField<number>(item, 'correctIndex') ?? 0;
          const dim = itemField<DimName>(item, 'dim') ?? 'concepts';
          const explanation = itemField<string>(item, 'explanation');
          const answer = itemField<string>(item, 'answer') ?? options[correctIndex];
          return (
            <div className="qr-card" key={i}>
              <div className="qr-card-head">
                <span className="qr-card-num">Q{i + 1}</span>
                <span className="qr-card-dim">{S.dim[dim]}</span>
              </div>
              <p className="qr-stem">{item.prompt}</p>
              <div className="qr-options">
                {options.map((opt, oi) => {
                  const picked = picks[i] === oi;
                  const isCorrect = oi === correctIndex;
                  let cls = 'qr-option';
                  if (submitted) {
                    if (isCorrect) cls += ' qr-option-correct';
                    else if (picked) cls += ' qr-option-wrong';
                  } else if (picked) {
                    cls += ' qr-option-picked';
                  }
                  return (
                    <button
                      type="button"
                      key={oi}
                      className={cls}
                      disabled={submitted}
                      onClick={() =>
                        setPicks((prev) => prev.map((p, pi) => (pi === i ? oi : p)))
                      }
                    >
                      <span className="qr-option-letter">{OPTION_LETTERS[oi]}</span>
                      <span className="qr-option-text">{opt}</span>
                      {submitted && isCorrect && <span className="qr-option-mark">✓</span>}
                      {submitted && picked && !isCorrect && <span className="qr-option-mark">✗</span>}
                    </button>
                  );
                })}
              </div>
              {submitted && (
                <p className="qr-explain">
                  <strong>{S.answerLabel}</strong> {answer}
                  {explanation ? ` — ${explanation}` : ''}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {!submitted ? (
        <button type="button" className="qr-submit" disabled={!allAnswered || busy} onClick={() => void submit()}>
          {busy ? S.recording : S.submitAnswers}
        </button>
      ) : (
        result && <Outcome component={result.component} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Socratic
// ---------------------------------------------------------------------------

interface ChatMsg {
  role: 'assistant' | 'user';
  text: string;
}

function SocraticRunner({
  quest,
  onCompleted,
  onReadPaper,
  onOpenSettings,
}: {
  quest: Quest;
  onCompleted: Props['onCompleted'];
  onReadPaper: Props['onReadPaper'];
  onOpenSettings: Props['onOpenSettings'];
}): JSX.Element {
  const S = useStrings();
  const lang = useLang();
  const seed = quest.items[0]?.prompt ?? S.socraticSeed;
  const [messages, setMessages] = useState<ChatMsg[]>([{ role: 'assistant', text: seed }]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsKey, setNeedsKey] = useState<LlmProvider | null>(null);
  const [final, setFinal] = useState<SocraticResponse | null>(null);
  const userTurns = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  const send = async (): Promise<void> => {
    const text = input.trim();
    if (!text || busy || done) return;
    setInput('');
    setError(null);
    setNeedsKey(null);
    setMessages((m) => [...m, { role: 'user', text }]);
    setBusy(true);
    const turn = userTurns.current + 1;
    const res = await sendSocraticMessage(quest.id, text, turn, lang);
    setBusy(false);

    if (res.error) {
      // API auth / proxy error. The server rolled the turn back, so undo it here
      // too and hand the text back to the input — otherwise the transcript on
      // screen would diverge from the dialogue the server actually holds.
      setMessages((m) => m.slice(0, -1));
      setInput(text);
      setError(res.error);
      setNeedsKey(res.needsKey ?? null);
      return;
    }
    userTurns.current = turn;
    if (res.reply) setMessages((m) => [...m, { role: 'assistant', text: res.reply! }]);
    if (res.done) {
      setDone(true);
      setFinal(res);
      onCompleted(res.componentId || quest.componentId, res.component!);
    }
  };

  return (
    <div className="qr-body">
      <div className="qr-chat" ref={scrollRef}>
        {messages.map((m, i) => (
          <div key={i} className={`qr-msg qr-msg-${m.role}`}>
            <span className="qr-msg-who">{m.role === 'assistant' ? S.tutorName : S.youName}</span>
            <div className="qr-bubble">{m.text}</div>
          </div>
        ))}
        {busy && (
          <div className="qr-msg qr-msg-assistant">
            <span className="qr-msg-who">{S.tutorName}</span>
            <div className="qr-bubble qr-typing">…</div>
          </div>
        )}
      </div>

      {error && (
        <div className="qr-error">
          <p>
            {S.socraticUnavailable} {error}
          </p>
          <div className="qr-error-actions">
            {needsKey && (
              <button
                type="button"
                className="qr-key-btn"
                onClick={() => onOpenSettings(needsKey)}
              >
                {S.addApiKey(needsKey)}
              </button>
            )}
            <button
              type="button"
              className="qr-read-btn"
              onClick={() => {
                setError(null);
                setNeedsKey(null);
              }}
            >
              {S.tryAgain}
            </button>
            <button type="button" className="qr-read-btn" onClick={onReadPaper}>
              {S.readPaperInstead}
            </button>
          </div>
        </div>
      )}

      {done && final?.component ? (
        <Outcome component={final.component} grades={final.grades} />
      ) : (
        !error && (
          <form
            className="qr-inputrow"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <input
              className="qr-input"
              value={input}
              placeholder={done ? S.dialogueComplete : S.inputPlaceholder}
              disabled={busy || done}
              onChange={(e) => setInput(e.target.value)}
            />
            <button type="submit" className="qr-send" disabled={busy || done || !input.trim()}>
              {S.send}
            </button>
          </form>
        )
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

export function QuestRunner({
  quest,
  title,
  onClose,
  onCompleted,
  onReadPaper,
  onOpenSettings,
}: Props): JSX.Element {
  const S = useStrings();
  const modality = quest.modality;
  const label = modality === 'quiz' ? S.quest.quiz : S.quest.socratic;

  return (
    <div className="qr-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="qr-modal" onClick={(e) => e.stopPropagation()}>
        <div className="qr-head">
          <div>
            <div className="qr-kicker">
              <span className="qr-kicker-badge">{QUEST_SKIN.badge}</span>
              {label}
            </div>
            <div className="qr-title">{title}</div>
            <div className="qr-id">
              {quest.componentId} · {S.origin[quest.origin]}
            </div>
          </div>
          <button type="button" className="panel-close" onClick={onClose} aria-label={S.closeQuest}>
            ×
          </button>
        </div>

        {modality === 'quiz' ? (
          <QuizRunner quest={quest} onCompleted={onCompleted} />
        ) : (
          <SocraticRunner
            quest={quest}
            onCompleted={onCompleted}
            onReadPaper={onReadPaper}
            onOpenSettings={onOpenSettings}
          />
        )}
      </div>
    </div>
  );
}
