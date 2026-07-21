import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { unificationProgress } from '@scale/core/browser';
import { MapView } from './MapView.js';
import { Panel } from './Panel.js';
import { QuestRunner } from './QuestRunner.js';
import { Settings } from './Settings.js';
import { SKIN } from './skin.js';
import { LangContext, STRINGS } from './i18n.js';
import { loadMap, loadCoverage, loadQuests, loadSettings } from './data.js';
import type {
  CoverageState,
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [map, setMap] = useState<MapJson | null>(null);
  const [coverage, setCoverage] = useState<UserCoverage | null>(null);
  const [quests, setQuests] = useState<Quest[]>([]);
  const [activeQuest, setActiveQuest] = useState<Quest | null>(null);
  // Component whose coverage just moved — drives a one-shot map "conquest" pulse.
  const [justUpdatedId, setJustUpdatedId] = useState<string | null>(null);
  // Legend hover/focus → highlight all castles of that status on the map.
  const [highlightState, setHighlightState] = useState<CoverageState | null>(null);
  // Settings modal; the value is the provider whose key field should take focus
  // (set when a Socratic dialogue was blocked by a missing key), else null.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsFocus, setSettingsFocus] = useState<LlmProvider | null>(null);
  // Interaction language (config.json `language`, per-user). Loaded with the
  // other settings on mount; a pick in the Settings modal applies here
  // optimistically so the whole tree re-renders before the server round-trip.
  const [lang, setLang] = useState<Language>('en');
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
    setSettingsOpen(true);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([loadMap(), loadCoverage(), loadQuests()]).then(([m, c, q]) => {
      if (cancelled) return;
      setMap(m);
      setCoverage(c);
      setQuests(q);
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
    // A quest created on demand by the Challenge button isn't in `quests` yet;
    // fold it in so the map badge and the panel's quest list see it too.
    setQuests((prev) => (prev.some((q) => q.id === quest.id) ? prev : [...prev, quest]));
    setActiveQuest(quest);
  }, []);

  // Called by the runner once coverage actually moved: re-fetch live coverage +
  // quests (§7.3 "re-fetch /api/coverage so the header + node states update"),
  // then fire the node's conquest animation.
  const onQuestCompleted = useCallback((componentId: string) => {
    void Promise.all([loadCoverage(), loadQuests()]).then(([c, q]) => {
      setCoverage(c);
      setQuests(q);
      setJustUpdatedId(componentId);
      window.setTimeout(() => setJustUpdatedId((cur) => (cur === componentId ? null : cur)), 1600);
    });
  }, []);

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
          </div>

          <button
            type="button"
            className="settings-btn"
            title={S.settingsButtonTitle}
            aria-label={S.openSettings}
            onClick={() => openSettings()}
          >
            ⚙
          </button>
        </header>

        <main className="content">
          {loading ? (
            <div className="map-wrap map-loading">{S.loadingMap}</div>
          ) : (
            <MapView
              map={map}
              coverage={coverage}
              selectedId={selectedId}
              onSelect={setSelectedId}
              pendingByComponent={pendingByComponent}
              justUpdatedId={justUpdatedId}
              onStartQuest={startQuest}
              highlightState={highlightState}
            />
          )}
          {selectedId && (
            <Panel
              componentId={selectedId}
              coverage={selectedCoverage}
              quests={pendingByComponent.get(selectedId) ?? []}
              onStartQuest={startQuest}
              onClose={() => setSelectedId(null)}
            />
          )}
          {activeQuest && (
            <QuestRunner
              quest={activeQuest}
              title={activeQuest.componentId}
              onClose={() => setActiveQuest(null)}
              onCompleted={(componentId) => onQuestCompleted(componentId)}
              onOpenSettings={openSettings}
              onReadPaper={() => {
                setSelectedId(activeQuest.componentId);
                setActiveQuest(null);
              }}
            />
          )}
          {settingsOpen && (
            <Settings
              focusProvider={settingsFocus}
              onLanguageChange={setLang}
              onClose={() => setSettingsOpen(false)}
            />
          )}
        </main>
      </div>
    </LangContext.Provider>
  );
}
