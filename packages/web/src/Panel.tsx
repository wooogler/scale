import { useEffect, useState, type JSX } from 'react';
import type { ComponentCoverage, Dimensions, Quest } from '@scale/core/browser';
import { skinFor, DEV_STATS_LABEL_EN, DEV_STATS_LABEL_KO, QUEST_SKIN } from './skin.js';
import { loadPaper, createVoluntaryQuest, type PaperResponse } from './data.js';
import { Markdown } from './Markdown.js';

interface Props {
  componentId: string;
  coverage: ComponentCoverage | undefined;
  quests: Quest[];
  onStartQuest: (quest: Quest) => void;
  onClose: () => void;
}

const DIM_LABELS: { key: keyof Dimensions; label: string }[] = [
  { key: 'structure', label: 'Structure' },
  { key: 'concepts', label: 'Concepts' },
  { key: 'rationale', label: 'Rationale' },
];

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

export function Panel({ componentId, coverage, quests, onStartQuest, onClose }: Props): JSX.Element {
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
  const skin = skinFor(state);
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
    const quest = await createVoluntaryQuest(componentId);
    setPreparing(false);
    if (quest) onStartQuest(quest);
    else setQuestError('Could not prepare a challenge for this territory.');
  };

  return (
    <aside className="panel">
      <div className="panel-head">
        <div>
          <div className="panel-title">{paper?.frontmatter.title ?? componentId}</div>
          <div className="panel-id">{componentId}</div>
        </div>
        <button type="button" className="panel-close" onClick={onClose} aria-label="Close panel">
          ×
        </button>
      </div>

      <div className="panel-state" style={{ borderColor: skin.color }}>
        <span className="state-dot" style={{ background: skin.color }} />
        <span className="state-ko">{skin.labelKo}</span>
        <span className="state-en">{skin.labelEn}</span>
      </div>
      <p className="state-blurb">{skin.blurb}</p>

      <section className="panel-section">
        <h4>
          {DEV_STATS_LABEL_EN} <span className="ko-sub">{DEV_STATS_LABEL_KO}</span>
        </h4>
        <div className="stats">
          {DIM_LABELS.map((d) => (
            <DevStat key={d.key} label={d.label} value={dims[d.key]} color={skin.color} />
          ))}
        </div>
        <dl className="meta">
          <dt>Loyalty</dt>
          <dd>{coverage ? Math.round(coverage.loyalty * 100) + '%' : '—'}</dd>
          <dt>Last validated</dt>
          <dd>{coverage?.lastValidatedSha ?? '—'}</dd>
        </dl>
      </section>

      {quests.length > 0 && (
        <section className="panel-section">
          <h4>
            {QUEST_SKIN.quizEn === 'Quiz' ? 'Pending sieges' : 'Quests'}{' '}
            <span className="ko-sub">{QUEST_SKIN.labelKo}</span>
          </h4>
          <ul className="quest-list">
            {quests.map((q) => (
              <li key={q.id} className="quest-item">
                <div className="quest-item-meta">
                  <span className={`quest-tag quest-tag-${q.modality}`}>
                    {q.modality === 'quiz' ? QUEST_SKIN.quizEn : QUEST_SKIN.socraticEn}
                  </span>
                  <span className="quest-origin">{q.origin}</span>
                </div>
                <button type="button" className="quest-start-btn" onClick={() => onStartQuest(q)}>
                  {QUEST_SKIN.badge} {QUEST_SKIN.startEn}{' '}
                  <span className="ko-sub">{QUEST_SKIN.startKo}</span>
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
        {preparing ? (
          <>⚔ Preparing… <span className="ko-sub">퀘스트 준비 중</span></>
        ) : (
          <>⚔ Challenge <span className="ko-sub">도전 (voluntary quest)</span></>
        )}
      </button>
      {questError && <p className="state-blurb quest-error">{questError}</p>}

      {loadingPaper && <p className="state-blurb">Loading paper…</p>}
      {!loadingPaper && paper && (
        <>
          <section className="panel-section">
            <h4>Concepts</h4>
            <ul className="concepts">
              {paper.frontmatter.concepts.map((c) => (
                <li key={c.id}>
                  <strong>{c.id}</strong> — {c.name}
                </li>
              ))}
            </ul>
          </section>

          <section className="panel-section paper">
            <h4>Paper</h4>
            <Markdown source={paper.body} />
          </section>
        </>
      )}
      {!loadingPaper && !paper && (
        <p className="state-blurb">No paper found for this component.</p>
      )}
    </aside>
  );
}
