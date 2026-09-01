import { useEffect, useState, type JSX } from 'react';
import type { ComponentCoverage, Dimensions, Quest } from '@scale/core/browser';
import { skinFor, DRIFT_SKIN, QUEST_SKIN } from './skin.js';
import { loadPaper, createVoluntaryQuest, type PaperResponse } from './data.js';
import { Markdown } from './Markdown.js';
import { useLang, useStrings } from './i18n.js';

interface Props {
  componentId: string;
  coverage: ComponentCoverage | undefined;
  quests: Quest[];
  /** A denied edit here still owes a check (async assessment). */
  owed?: boolean;
  onStartQuest: (quest: Quest) => void;
  onClose: () => void;
}

const DIM_KEYS: (keyof Dimensions)[] = ['structure', 'concepts', 'rationale'];

function DevStat({ label, value, color }: { label: string; value: number; color: string }): JSX.Element {
  const pct = Math.round(value * 100);
  return (
    <div className="stat">
      <div className="stat-head">
        <span className="stat-label">{label}</span>
        <span className="stat-val">{pct}</span>
      </div>
      <div className="stat-bar">
        <div className="stat-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

export function Panel({ componentId, coverage, quests, owed = false, onStartQuest, onClose }: Props): JSX.Element {
  const S = useStrings();
  const lang = useLang();
  // Papers are fetched lazily per selected node (GET /api/paper/:id) with a
  // bundled-sample fallback baked into loadPaper. While the fetch is in flight
  // the panel shows a loading state.
  const [paper, setPaper] = useState<PaperResponse | null>(null);
  const [loadingPaper, setLoadingPaper] = useState(true);
  // Challenge = create-a-quest-on-demand; it hits the network, so it has its own
  // in-flight + error state (a dead button is worse than a slow one).
  const [preparing, setPreparing] = useState(false);
  const [questError, setQuestError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadingPaper(true);
    setPaper(null);
    void loadPaper(componentId).then((p) => {
      if (cancelled) return;
      setPaper(p);
      setLoadingPaper(false);
    });
    return () => {
      cancelled = true;
    };
  }, [componentId]);

  const state = coverage?.state ?? 'fog';
  const skin = skinFor(state, coverage?.driftCause ?? null);
  const dims = coverage?.dims ?? { structure: 0, concepts: 0, rationale: 0 };

  const challenge = async (): Promise<void> => {
    // §6.3 voluntary learning — available in every condition, no interruption
    // budget. If a pending quest already sits on this component, wage it;
    // otherwise ask the server to CREATE one on demand (POST /api/quests) and
    // open the runner immediately. The server falls back to deterministic
    // paper-grounded items when there's no API key, so this always works.
    if (quests.length > 0) {
      onStartQuest(quests[0]!);
      return;
    }
    setPreparing(true);
    setQuestError(null);
    const quest = await createVoluntaryQuest(componentId, lang);
    setPreparing(false);
    if (quest) onStartQuest(quest);
    else setQuestError(S.challengeError);
  };

  return (
    <aside className="panel">
      <div className="panel-head">
        <div>
          <div className="panel-title">{paper?.frontmatter.title ?? componentId}</div>
          <div className="panel-id">{componentId}</div>
        </div>
        <button type="button" className="panel-close" onClick={onClose} aria-label={S.closePanel}>
          ×
        </button>
      </div>

      <div className="panel-state" style={{ borderColor: skin.color }}>
        <span className="state-dot" style={{ background: skin.color }} />
        <span className="state-ko">{skin.labelKo !== skin.labelEn ? (lang === 'ko' ? skin.labelKo : skin.labelEn) : S.state[state].label}</span>
      </div>
      <p className="state-blurb">
        {state === 'stale' && coverage?.driftCause
          ? lang === 'ko'
            ? DRIFT_SKIN[coverage.driftCause].blurbKo
            : DRIFT_SKIN[coverage.driftCause].blurbEn
          : S.state[state].blurb}
      </p>
      {/* Naming WHO is the whole reason the drift split exists: it turns a
          re-lock from an arbitrary setback into a legible event. */}
      {state === 'stale' && (coverage?.driftAuthors.length ?? 0) > 0 && (
        <p className="state-blurb drift-authors">
          {DRIFT_SKIN.foreign.icon} {coverage!.driftAuthors.join(', ')}
        </p>
      )}

      {owed && <p className="state-blurb owed-note">🔒 {S.owedUnlockNote}</p>}

      <section className="panel-section">
        <h4>{S.devStats}</h4>
        <div className="stats">
          {DIM_KEYS.map((k) => (
            <DevStat key={k} label={S.dim[k]} value={dims[k]} color={skin.color} />
          ))}
        </div>
        <dl className="meta">
          <dt>{S.loyalty}</dt>
          <dd>{coverage ? Math.round(coverage.loyalty * 100) + '%' : '—'}</dd>
          <dt>{S.lastValidated}</dt>
          <dd>{coverage?.lastValidatedSha ?? '—'}</dd>
        </dl>
      </section>

      {quests.length > 0 && (
        <section className="panel-section">
          <h4>{S.pendingQuestsHeading}</h4>
          <ul className="quest-list">
            {quests.map((q) => (
              <li key={q.id} className="quest-item">
                <div className="quest-item-meta">
                  <span className={`quest-tag quest-tag-${q.modality}`}>
                    {q.modality === 'quiz' ? S.quest.quiz : S.quest.socratic}
                  </span>
                  <span className="quest-origin">{S.origin[q.origin]}</span>
                </div>
                <button type="button" className="quest-start-btn" onClick={() => onStartQuest(q)}>
                  {QUEST_SKIN.badge} {S.quest.start}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <button
        type="button"
        className="challenge-btn"
        onClick={() => void challenge()}
        disabled={preparing}
        aria-busy={preparing}
      >
        {preparing
          ? `${QUEST_SKIN.badge} ${S.challengePreparing}`
          : `${QUEST_SKIN.badge} ${S.challenge}`}
      </button>
      {questError && <p className="state-blurb quest-error">{questError}</p>}

      {loadingPaper && <p className="state-blurb">{S.loadingPaper}</p>}
      {!loadingPaper && paper && (
        <>
          <section className="panel-section">
            <h4>{S.conceptsHeading}</h4>
            <ul className="concepts">
              {paper.frontmatter.concepts.map((c) => (
                <li key={c.id}>
                  <strong>{c.id}</strong> — {c.name}
                </li>
              ))}
            </ul>
          </section>

          <section className="panel-section paper">
            {/* Paper CONTENT is repo-shared state and always English (§2). */}
            <h4>{S.paperHeading}</h4>
            <Markdown source={paper.body} />
          </section>
        </>
      )}
      {!loadingPaper && !paper && <p className="state-blurb">{S.noPaper}</p>}
    </aside>
  );
}
