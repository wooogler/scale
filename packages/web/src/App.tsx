import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { unificationProgress } from '@scale/core/browser';
import { MapView } from './MapView.js';
import { Panel } from './Panel.js';
import { DocsIndex } from './DocsIndex.js';
import { QuestRunner } from './QuestRunner.js';
import { Settings } from './Settings.js';
import { SKIN } from './skin.js';
import { LangContext, STRINGS } from './i18n.js';
import { applyRoute, currentRoute, type Route, type SettingsTab } from './route.js';
import {
  loadMap,
  loadCoverage,
  loadQuests,
  loadLocks,
  loadSettings,
  loadDocIndex,
  bootstrapToken,
  apiAuthFailed,
  sampleDataActive,
  type LocksResponse,
} from './data.js';
import type {
  CoverageState,
  DocIndexEntry,
  Language,
  LlmProvider,
  MapJson,
  Quest,
  UserCoverage,
} from '@scale/core/browser';

const LEGEND_ORDER: CoverageState[] = ['fog', 'explored', 'validated', 'stale'];

/**
 * SCALE map viewer skeleton (PLAN §7.3). Renders the FROZEN map layout with
 * LIVE coverage. Map + coverage are fetched from the `scale serve` API via the
 * data layer on mount (with a bundled-sample fallback for standalone dev).
 * This is the read-only shell: map + panel + header. Quest runner and live
 * state engine arrive in later phases.
 */
export function App(): JSX.Element {
  // Dev-only: true once any loader fell back to bundled demo fixtures. Rendered
  // as a banner because a fabricated map is otherwise indistinguishable from the
  // user's own repo — which made every screenshot of it untrustworthy.
  const [usingSample, setUsingSample] = useState(false);
  // The route the tab was opened on (`#/c/<id>` or `#/settings[/<tab>]`, see
  // route.ts). Read once, synchronously, so a deep link is honoured on the
  // first paint instead of flashing the bare map first.
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    const r = currentRoute();
    return r?.kind === 'component' ? r.id : null;
  });
  // The section of that component's doc the link asked for (`#/c/<id>/<section>`),
  // or null. Kept beside `selectedId` rather than inside the Panel because it is
  // part of the ROUTE: it has to survive into the address bar and back out of it.
  const [selectedSection, setSelectedSection] = useState<string | null>(() => {
    const r = currentRoute();
    return r?.kind === 'component' ? (r.section ?? null) : null;
  });
  const [map, setMap] = useState<MapJson | null>(null);
  // Every component doc's id/title/province/folder — one request, loaded once.
  // Resolves the relative links inside a doc and feeds the Docs browser.
  const [docIndex, setDocIndex] = useState<DocIndexEntry[]>([]);
  const [docsOpen, setDocsOpen] = useState(false);
  const [coverage, setCoverage] = useState<UserCoverage | null>(null);
  const [quests, setQuests] = useState<Quest[]>([]);
  // The lock picture over coverage — see /api/locks. Empty until the server answers.
  const [locks, setLocks] = useState<LocksResponse | null>(null);
  const [activeQuest, setActiveQuest] = useState<Quest | null>(null);
  // Component whose coverage just moved — drives a one-shot map "conquest" pulse.
  const [justUpdatedId, setJustUpdatedId] = useState<string | null>(null);
  // Legend hover/focus → highlight all castles of that status on the map.
  const [highlightState, setHighlightState] = useState<CoverageState | null>(null);
  // Settings modal; the value is the provider whose key field should take focus
  // (set when a Socratic dialogue was blocked by a missing key), else null.
  const [settingsOpen, setSettingsOpen] = useState(() => currentRoute()?.kind === 'settings');
  const [settingsFocus, setSettingsFocus] = useState<LlmProvider | null>(null);
  // Two different things. `settingsTab` mirrors the tab the modal is ACTUALLY
  // on (it reports up, because the tab it opens on can come from localStorage)
  // and exists only to write the hash. `settingsRouteTab` is the tab a deep
  // link asked for, and is null whenever Settings was opened by the gear.
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general');
  const [settingsRouteTab, setSettingsRouteTab] = useState<SettingsTab | null>(() => {
    const r = currentRoute();
    return r?.kind === 'settings' ? r.tab : null;
  });
  // Interaction language (config.json `language`, per-user). Loaded with the
  // other settings on mount; a pick in the Settings modal applies here
  // optimistically so the whole tree re-renders before the server round-trip.
  const [lang, setLang] = useState<Language>('en');
  const [authExpired, setAuthExpired] = useState(false);
  // App renders the Provider itself, so it reads the table directly — hooks
  // below the Provider (children) use useStrings().
  const S = STRINGS[lang];

  // Keep the document's language honest (index.html ships lang="en"): screen
  // readers, spellcheck, and font selection all key off this attribute.
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const openSettings = useCallback((provider?: LlmProvider) => {
    setSettingsFocus(provider ?? null);
    setSettingsRouteTab(null); // opened from the app, not from a link
    setSettingsOpen(true);
  }, []);

  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    setSettingsRouteTab(null);
  }, []);

  /**
   * Whether the NEXT route write is a history push rather than a replace.
   *
   * A ref, not state: it is an attribute of the gesture that just happened, not
   * of the app's state, and it must be readable by the route effect in the same
   * commit that the selection changes. See route.ts for why the two gestures
   * differ — clicking a castle is browsing a map, following a link from one doc
   * to another is navigating between documents, and only the second is
   * something the back button should undo.
   */
  const pushNextRoute = useRef(false);

  /** Select a component the way the MAP does: no section, no history entry. */
  const selectFromMap = useCallback((id: string | null) => {
    setSelectedSection(null);
    setSelectedId(id);
  }, []);

  /**
   * Select a component the way a DOCUMENT does — an in-doc link or the Docs
   * browser. Pushes history, closes the browser, and starts at the top of the
   * new doc (a link points at a component, not at a section of one).
   */
  const selectFromDoc = useCallback((id: string) => {
    pushNextRoute.current = true;
    setSelectedSection(null);
    setSelectedId(id);
    setDocsOpen(false);
    setSettingsOpen(false);
  }, []);

  /**
   * Address bar ← app. Settings is the foreground surface, so it wins the hash
   * while it is open and closing it falls back to the selected component.
   * replaceState (see route.ts) means this never fires `hashchange`, so it
   * cannot loop with the listener below.
   */
  useEffect(() => {
    const route: Route | null = settingsOpen
      ? { kind: 'settings', tab: settingsTab }
      : selectedId
        ? { kind: 'component', id: selectedId, ...(selectedSection ? { section: selectedSection } : {}) }
        : null;
    applyRoute(route, { push: pushNextRoute.current });
    pushNextRoute.current = false;
  }, [settingsOpen, settingsTab, selectedId, selectedSection]);

  /**
   * Address bar → app: a hash pasted into an already-open tab, and the back and
   * forward buttons.
   *
   * BOTH events, deliberately. `hashchange` covers a pasted or edited hash;
   * `popstate` covers traversal of the entries pushState created for in-doc
   * link follows, which browsers do not consistently report as a hash change.
   * The handler reads the address bar rather than any event payload, so being
   * called twice for one navigation is free.
   */
  useEffect(() => {
    const onRouteChange = (): void => {
      const r = currentRoute();
      if (r?.kind === 'settings') {
        setSettingsFocus(null);
        setSettingsRouteTab(r.tab);
        setSettingsOpen(true);
      } else if (r?.kind === 'component') {
        setSettingsOpen(false);
        setSettingsRouteTab(null);
        setSelectedId(r.id); // validated against the map below
        setSelectedSection(r.section ?? null);
      } else {
        setSettingsOpen(false);
        setSettingsRouteTab(null);
        setSelectedId(null);
        setSelectedSection(null);
      }
    };
    window.addEventListener('hashchange', onRouteChange);
    window.addEventListener('popstate', onRouteChange);
    return () => {
      window.removeEventListener('hashchange', onRouteChange);
      window.removeEventListener('popstate', onRouteChange);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Off-loopback `scale serve` hands the API token over in the URL exactly
    // once; stash it before the first fetch or every call below 401s.
    bootstrapToken();
    void Promise.all([loadMap(), loadCoverage(), loadQuests(), loadLocks()])
      .then(([m, c, q, l]) => {
        setUsingSample(sampleDataActive());
        if (cancelled) return;
        setMap(m);
        setCoverage(c);
        setQuests(q);
        setLocks(l);
      })
      .catch(() => {
        // A 401 means the token this tab holds no longer opens the server. Say
        // so instead of rendering nothing (or, in dev, someone else's repo).
        if (!cancelled) setAuthExpired(apiAuthFailed());
      });
    // The doc index is its own request because it never throws and never blocks
    // the map: without it, in-doc links render as plain text and the Docs
    // browser is empty — degraded, not broken.
    void loadDocIndex().then((d) => {
      if (!cancelled) setDocIndex(d);
    });
    // Language rides along with the other settings. loadSettings has no sample
    // fallback (unlike map/coverage), so swallow the failure — offline vite dev
    // simply stays on the 'en' default.
    void loadSettings()
      .then((s) => {
        if (!cancelled) setLang(s.config.language);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * A deep link can name a component this repo does not have — the map was
   * re-mapped, or the link came from someone else's checkout. Drop it silently
   * once the map is in: a stale bookmark should land on the plain map, not on
   * an error. (Until then the Panel is held back; see the render below.)
   */
  useEffect(() => {
    if (!map || !selectedId) return;
    if (!map.nodes.some((n) => n.id === selectedId)) {
      setSelectedId(null);
      setSelectedSection(null);
    }
  }, [map, selectedId]);

  // Pending quests indexed by component (map badges + panel list read this).
  const pendingByComponent = useMemo(() => {
    const m = new Map<string, Quest[]>();
    for (const q of quests) {
      if (q.status !== 'pending') continue;
      const arr = m.get(q.componentId) ?? [];
      arr.push(q);
      m.set(q.componentId, arr);
    }
    return m;
  }, [quests]);

  const startQuest = useCallback((quest: Quest) => {
    setSelectedId(quest.componentId);
    setSelectedSection(null);
    // A quest created on demand by the Challenge button isn't in `quests` yet;
    // fold it in so the map badge and the panel's quest list see it too.
    setQuests((prev) => (prev.some((q) => q.id === quest.id) ? prev : [...prev, quest]));
    setActiveQuest(quest);
  }, []);

  // Called by the runner once coverage actually moved: re-fetch live coverage +
  // quests (§7.3 "re-fetch /api/coverage so the header + node states update"),
  // then fire the node's conquest animation.
  const onQuestCompleted = useCallback((componentId: string) => {
    void Promise.all([loadCoverage(), loadQuests(), loadLocks()]).then(([c, q, l]) => {
      setCoverage(c);
      setQuests(q);
      setLocks(l); // a passed check clears its pending-unlock badge
      setJustUpdatedId(componentId);
      window.setTimeout(() => setJustUpdatedId((cur) => (cur === componentId ? null : cur)), 1600);
    });
  }, []);

  // Territories a denied edit still owes a check on (async assessment). These
  // are the async user's to-do list, so they get a badge on the map and a chip
  // in the header — otherwise the promise "unlock it later, here" had no here.
  const owedUnlocks = useMemo(
    () => new Set(Object.keys(locks?.pendingUnlocks ?? {})),
    [locks],
  );

  // §5.1 / §2: weighted total coverage = "unification progress". Computed
  // client-side with @scale/core's pure function (it imports fine in the browser).
  const progress = useMemo(
    () => (map && coverage ? unificationProgress(map.nodes, coverage) : 0),
    [map, coverage],
  );

  const counts = useMemo(() => {
    const c: Record<CoverageState, number> = { fog: 0, explored: 0, validated: 0, stale: 0 };
    if (!map || !coverage) return c;
    for (const n of map.nodes) {
      const st = coverage.components[n.id]?.state ?? 'fog';
      c[st] += 1;
    }
    return c;
  }, [map, coverage]);

  const selectedCoverage = selectedId && coverage ? coverage.components[selectedId] : undefined;

  const loading = !map || !coverage;

  return (
    <LangContext.Provider value={lang}>
      <div className="app">
        {authExpired ? (
          <div className="auth-banner" role="alert">
            {S.authExpired}
          </div>
        ) : null}
        {usingSample ? (
          <div className="sample-banner" role="status">
            <strong>Demo data.</strong> The live API is unreachable, so this map is
            bundled sample content — <em>not</em> your repository. Start{' '}
            <code>scale serve</code> in the repo you want to see.
          </div>
        ) : null}
        <header className="header">
          <div className="brand">
            <span className="brand-mark">◆</span>
            <span className="brand-name">SCALE</span>
            <span className="brand-sub">{S.brandSub}</span>
          </div>

          <div className="progress">
            <div className="progress-labels">
              <span className="progress-en">{S.unificationProgress}</span>
              <span className="progress-pct">{Math.round(progress * 100)}%</span>
            </div>
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
          </div>

          <div className="legend">
            {LEGEND_ORDER.map((st) => (
              <button
                type="button"
                className={`legend-item${highlightState === st ? ' legend-item-active' : ''}`}
                key={st}
                title={S.state[st].blurb}
                aria-pressed={highlightState === st}
                onMouseEnter={() => setHighlightState(st)}
                onMouseLeave={() => setHighlightState((cur) => (cur === st ? null : cur))}
                onFocus={() => setHighlightState(st)}
                onBlur={() => setHighlightState((cur) => (cur === st ? null : cur))}
              >
                <span className="legend-dot" style={{ background: SKIN[st].color }} />
                <span className="legend-ko">{S.state[st].label}</span>
                <span className="legend-count">{counts[st]}</span>
              </button>
            ))}
            {owedUnlocks.size > 0 && (
              <span className="legend-item legend-owed" title={S.owedUnlockNote}>
                <span className="legend-ko">🔒 {S.owedUnlock}</span>
                <span className="legend-count">{owedUnlocks.size}</span>
              </span>
            )}
          </div>

          {/* The map is a picture, not a table of contents: the Docs button is
              how a reader reaches a component doc they cannot point at. */}
          <div className="header-actions">
            <button
              type="button"
              className="docs-btn"
              title={S.docsIndexTitle}
              onClick={() => setDocsOpen(true)}
            >
              📖 {S.docsIndex}
            </button>
            <button
              type="button"
              className="settings-btn"
              title={S.settingsButtonTitle}
              aria-label={S.openSettings}
              onClick={() => openSettings()}
            >
              ⚙
            </button>
          </div>
        </header>

        <main className="content">
          {loading ? (
            <div className="map-wrap map-loading">{S.loadingMap}</div>
          ) : (
            <MapView
              map={map}
              coverage={coverage}
              selectedId={selectedId}
              onSelect={selectFromMap}
              pendingByComponent={pendingByComponent}
              owedUnlocks={owedUnlocks}
              justUpdatedId={justUpdatedId}
              onStartQuest={startQuest}
              highlightState={highlightState}
            />
          )}
          {/* `map &&`: a hash-borne id is only known to be real once the map is
              in, and a Panel for a component that does not exist would fetch a
              doc that 404s. */}
          {selectedId && map && (
            <Panel
              componentId={selectedId}
              section={selectedSection ?? undefined}
              coverage={selectedCoverage}
              quests={pendingByComponent.get(selectedId) ?? []}
              docs={docIndex}
              owed={owedUnlocks.has(selectedId)}
              onStartQuest={startQuest}
              onNavigate={selectFromDoc}
              onClose={() => selectFromMap(null)}
            />
          )}
          {activeQuest && (
            <QuestRunner
              quest={activeQuest}
              title={activeQuest.componentId}
              onClose={() => setActiveQuest(null)}
              onCompleted={(componentId) => onQuestCompleted(componentId)}
              onOpenSettings={openSettings}
              onReadDoc={() => {
                setSelectedId(activeQuest.componentId);
                setActiveQuest(null);
              }}
            />
          )}
          {docsOpen && (
            <DocsIndex
              docs={docIndex}
              map={map}
              selectedId={selectedId}
              onSelect={selectFromDoc}
              onClose={() => setDocsOpen(false)}
            />
          )}
          {settingsOpen && (
            <Settings
              focusProvider={settingsFocus}
              initialTab={settingsRouteTab}
              onTabChange={setSettingsTab}
              onLanguageChange={setLang}
              onClose={closeSettings}
            />
          )}
        </main>
      </div>
    </LangContext.Provider>
  );
}
