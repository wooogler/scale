import { useEffect, useState, type JSX } from 'react';
import type { ComponentCoverage, Dimensions, Quest } from '@scale/core/browser';
import { skinFor, DRIFT_SKIN, QUEST_SKIN } from './skin.js';
import {
  loadDoc,
  loadDocTranslation,
  createVoluntaryQuest,
  type DocResponse,
  type DocTranslationResponse,
} from './data.js';
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
  // Docs are fetched lazily per selected node (GET /api/doc/:id) with a
  // bundled-sample fallback baked into loadDoc. While the fetch is in flight
  // the panel shows a loading state.
  const [doc, setDoc] = useState<DocResponse | null>(null);
  const [loadingDoc, setLoadingDoc] = useState(true);
  // The TRANSLATION rides alongside, never in front. A doc's source is English
  // and shared through the repo; the display language is one user's setting, so
  // reading must never wait on an LLM that may take minutes on a cache miss.
  // The English source renders as soon as it lands and the translated fields
  // swap in afterwards — which also means a failed or missing translation costs
  // the reader nothing but a one-line note.
  const [translation, setTranslation] = useState<DocTranslationResponse | null>(null);
  const [translating, setTranslating] = useState(false);
  // Whose choice this is: once a translation is on screen the reader may pin the
  // English source instead. Session-scoped on purpose — it follows them across
  // components while the tab lives, and does not outlive it.
  const [showOriginal, setShowOriginal] = useState(false);
  // Challenge = create-a-quest-on-demand; it hits the network, so it has its own
  // in-flight + error state (a dead button is worse than a slow one).
  const [preparing, setPreparing] = useState(false);
  const [questError, setQuestError] = useState<string | null>(null);

  useEffect(() => {
    // Two independent in-flight requests share ONE cancellation flag: selecting
    // another component (or switching language) must not let a slow translation
    // of the PREVIOUS component land on the new one.
    let cancelled = false;
    setLoadingDoc(true);
    setDoc(null);
    setTranslation(null);
    setTranslating(lang !== 'en');
    void loadDoc(componentId).then((d) => {
      if (cancelled) return;
      setDoc(d);
      setLoadingDoc(false);
      // Nothing to translate — don't leave a status hanging over an empty panel.
      if (!d) setTranslating(false);
    });
    if (lang !== 'en') {
      void loadDocTranslation(componentId, lang).then((t) => {
        if (cancelled) return;
        setTranslation(t);
        setTranslating(false);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [componentId, lang]);

  // A server answer of `translated: false` is NOT a failure to hide: it carries
  // the reason (no API key, the model refused…) and the English source to show
  // meanwhile. A null `translation` is the other case — no server, no note.
  const translated = translation?.translated === true ? translation : null;
  const translationError =
    translation && !translation.translated ? (translation.error ?? null) : null;
  const showingTranslation = translated !== null && !showOriginal;
  const fm = showingTranslation ? translated.frontmatter : doc?.frontmatter;
  const body = showingTranslation ? translated.body : doc?.body;

  const state = coverage?.state ?? 'fog';
  const skin = skinFor(state, coverage?.driftCause ?? null);
  const dims = coverage?.dims ?? { structure: 0, concepts: 0, rationale: 0 };

  const challenge = async (): Promise<void> => {
    // §6.3 voluntary learning — available in every condition, no interruption
    // budget. If a pending quest already sits on this component, wage it;
    // otherwise ask the server to CREATE one on demand (POST /api/quests) and
    // open the runner immediately. The server falls back to deterministic
    // doc-grounded items when there's no API key, so this always works.
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
          <div className="panel-title">{fm?.title ?? componentId}</div>
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

      {loadingDoc && <p className="state-blurb">{S.loadingDoc}</p>}
      {!loadingDoc && doc && (
        <>
          {/* Translation chrome sits ABOVE the doc sections because the swap is
              not only the body: title, concept names and rationale prose all
              come from whichever frontmatter is on screen. */}
          {(translating || translated || translationError) && (
            <div className="translate-bar">
              {translating && <span className="translate-status">{S.translating}</span>}
              {showingTranslation && (
                <span className="translate-badge">
                  {S.translatedBadge}
                  {translated.cached && (
                    <span className="translate-cached">{S.cachedBadge}</span>
                  )}
                </span>
              )}
              {translated && (
                <button
                  type="button"
                  className="translate-toggle"
                  onClick={() => setShowOriginal((v) => !v)}
                >
                  {showOriginal ? S.showTranslation : S.showOriginal}
                </button>
              )}
            </div>
          )}
          {translationError && (
            <p className="state-blurb translate-note">
              {S.translationUnavailable}{' '}
              <span className="translate-detail">{translationError.message}</span>
            </p>
          )}

          <section className="panel-section">
            <h4>{S.conceptsHeading}</h4>
            <ul className="concepts">
              {(fm?.concepts ?? []).map((c) => (
                <li key={c.id}>
                  <strong>{c.id}</strong> — {c.name}
                </li>
              ))}
            </ul>
          </section>

          {/* Rationale is a GRADED dimension (§5.1) — the panel used to grade it
              while never showing it, so the only way to meet a rationale item
              was to have read the file on disk. */}
          {(fm?.rationale.length ?? 0) > 0 && (
            <section className="panel-section">
              <h4>{S.designDecisionsHeading}</h4>
              <ul className="rationale">
                {(fm?.rationale ?? []).map((r, i) => (
                  <li key={`r${i}`}>
                    <strong>{r.decision}</strong>
                    {r.why && <div className="rationale-why">{r.why}</div>}
                    {r.alternatives && (
                      <div className="rationale-alts">
                        {S.alternativesLabel}: {r.alternatives}
                      </div>
                    )}
                    <span className="rationale-prov">{r.provenance}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="panel-section doc">
            {/* The doc SOURCE is English and shared through the repo; the
                DISPLAY is translated per user at render time. */}
            <h4>{S.docHeading}</h4>
            <Markdown source={body ?? ''} />
          </section>
        </>
      )}
      {!loadingDoc && !doc && <p className="state-blurb">{S.noDoc}</p>}
    </aside>
  );
}
