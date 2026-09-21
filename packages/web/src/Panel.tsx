import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import {
  headingSlugs,
  type ComponentCoverage,
  type Dimensions,
  type DocIndexEntry,
  type Quest,
} from '@scale/core/browser';
import { skinFor, DRIFT_SKIN, QUEST_SKIN } from './skin.js';
import {
  loadDoc,
  loadDocTranslation,
  createVoluntaryQuest,
  type DocResponse,
  type DocTranslationResponse,
} from './data.js';
import { Markdown } from './Markdown.js';
import { idByDir, resolveDocLink, type DocLink } from './doclink.js';
import { useLang, useStrings } from './i18n.js';

interface Props {
  componentId: string;
  /**
   * Anchor a `#/c/<id>/<section>` link asked for: `concepts`, `decisions`, or a
   * heading slug. A section this doc does not have is not an error — the panel
   * simply does not scroll (see the effect below).
   */
  section?: string;
  coverage: ComponentCoverage | undefined;
  quests: Quest[];
  /** Every component doc's `{ id, title, province, dir }` — resolves in-doc links. */
  docs: DocIndexEntry[];
  /** A denied edit here still owes a check (async assessment). */
  owed?: boolean;
  onStartQuest: (quest: Quest) => void;
  /** Follow a link from inside this doc to another component's doc. */
  onNavigate: (id: string) => void;
  onClose: () => void;
}

/** How long a deep-linked section stays highlighted (matches styles.css). */
const SECTION_FLASH_MS = 1500;

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

export function Panel({
  componentId,
  section,
  coverage,
  quests,
  docs,
  owed = false,
  onStartQuest,
  onNavigate,
  onClose,
}: Props): JSX.Element {
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

  /**
   * Anchor ids for the body headings, computed from the ENGLISH source and only
   * from it. A translated heading has no stable anchor (`## 요약` slugifies to
   * nothing), and one derived per language would make a link written by a
   * Korean reader miss for an English one. Markdown maps these onto whichever
   * body is on screen by position — see Markdown.tsx.
   */
  const headingIds = useMemo(() => headingSlugs(doc?.body ?? ''), [doc?.body]);

  /**
   * Resolve this doc's own relative links. The folder comes from the doc
   * response, with the index as a fallback for a server old enough not to send
   * it; with neither, `resolveDocLink` simply resolves nothing and the links
   * render as text, which is what they did before this existed.
   */
  const dirIndex = useMemo(() => idByDir(docs), [docs]);
  const fromDir = doc?.dir ?? docs.find((d) => d.id === componentId)?.dir ?? '';
  const resolveLink = useCallback(
    (href: string): DocLink | null => resolveDocLink(href, { fromDir, idByDir: dirIndex }),
    [fromDir, dirIndex],
  );

  /**
   * Scroll a deep-linked section into view, once there is something to scroll
   * to, and flash it so the reader can see where they landed.
   *
   * `translation` is in the deps on purpose: when the panel opens in Korean the
   * English source paints first and the translation swaps in seconds later,
   * re-laying-out the whole doc under the reader. Anchoring only on the first
   * paint would leave them somewhere else entirely, so the scroll re-runs when
   * the swap lands. The rendered `body` is NOT in the deps, which is the same
   * decision from the other side: "show original" is the reader moving, and
   * yanking them back to the anchor they arrived at would fight them.
   *
   * A section id that is not on the page (an old link, a heading that was
   * renamed, a `concepts` anchor on a doc with no concepts) does nothing at
   * all: the reader gets the doc from the top, which is the same philosophy as
   * route.ts's "unknown input is never an error".
   */
  useEffect(() => {
    if (!section || loadingDoc || !doc) return;
    let el: HTMLElement | null = null;
    let timer = 0;
    // One frame, so the body that just changed has actually been laid out.
    const raf = window.requestAnimationFrame(() => {
      el = document.getElementById(section);
      if (!el) return;
      el.scrollIntoView({ block: 'start', behavior: 'smooth' });
      el.classList.add('section-target');
      timer = window.setTimeout(() => el?.classList.remove('section-target'), SECTION_FLASH_MS);
    });
    return () => {
      window.cancelAnimationFrame(raf);
      if (timer) window.clearTimeout(timer);
      el?.classList.remove('section-target');
    };
  }, [section, componentId, loadingDoc, doc, translation]);

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

          {/* `concepts` / `decisions` are RESERVED anchor ids (core's
              PANEL_SECTION_IDS): both lists are rendered from frontmatter, not
              from the body, so they have no heading slug of their own and
              `#/c/<id>/concepts` has to mean the same thing in every doc. */}
          <section className="panel-section" id="concepts">
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
            <section className="panel-section" id="decisions">
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
            <Markdown
              source={body ?? ''}
              headingIds={headingIds}
              resolveLink={resolveLink}
              onNavigate={onNavigate}
            />
          </section>
        </>
      )}
      {!loadingDoc && !doc && <p className="state-blurb">{S.noDoc}</p>}
    </aside>
  );
}
