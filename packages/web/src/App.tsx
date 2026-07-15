import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { unificationProgress } from '@scale/core/browser';
import { MapView } from './MapView.js';
import { Panel } from './Panel.js';
import { QuestRunner } from './QuestRunner.js';
import {
  SKIN,
  UNIFICATION_LABEL_EN,
  UNIFICATION_LABEL_KO,
} from './skin.js';
import { loadMap, loadCoverage, loadQuests } from './data.js';
import type { CoverageState, MapJson, Quest, UserCoverage } from '@scale/core/browser';

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

  useEffect(() => {
    let cancelled = false;
    void Promise.all([loadMap(), loadCoverage(), loadQuests()]).then(([m, c, q]) => {
      if (cancelled) return;
      setMap(m);
      setCoverage(c);
      setQuests(q);
    });
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
    <div className="app">
      <header className="header">
        <div className="brand">
          <span className="brand-mark">◆</span>
          <span className="brand-name">SCALE</span>
          <span className="brand-sub">territory map</span>
        </div>

        <div className="progress">
          <div className="progress-labels">
            <span className="progress-en">{UNIFICATION_LABEL_EN}</span>
            <span className="progress-ko">{UNIFICATION_LABEL_KO}</span>
            <span className="progress-pct">{Math.round(progress * 100)}%</span>
          </div>
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        </div>

        <div className="legend">
          {LEGEND_ORDER.map((st) => (
            <div className="legend-item" key={st}>
              <span className="legend-dot" style={{ background: SKIN[st].color }} />
              <span className="legend-ko">{SKIN[st].labelKo}</span>
              <span className="legend-count">{counts[st]}</span>
            </div>
          ))}
        </div>
      </header>

      <main className="content">
        {loading ? (
          <div className="map-wrap map-loading">Loading territory map…</div>
        ) : (
          <MapView
            map={map}
            coverage={coverage}
            selectedId={selectedId}
            onSelect={setSelectedId}
            pendingByComponent={pendingByComponent}
            justUpdatedId={justUpdatedId}
            onStartQuest={startQuest}
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
            onReadPaper={() => {
              setSelectedId(activeQuest.componentId);
              setActiveQuest(null);
            }}
          />
        )}
      </main>
    </div>
  );
}
