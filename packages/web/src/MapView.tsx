import { useMemo, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react';
import type { MapJson, UserCoverage, CoverageState, Quest } from '@scale/core/browser';
import { skinFor, QUEST_SKIN } from './skin.js';

const VIEW_W = 1000;
const VIEW_H = 680;
const PAD = 70; // keep nodes off the very edges

interface Props {
  map: MapJson;
  coverage: UserCoverage;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Pending quests per component id — components with one get a siege badge. */
  pendingByComponent: Map<string, Quest[]>;
  /** Component that just moved coverage — plays a one-shot conquest pulse. */
  justUpdatedId: string | null;
  /** Begin a quest (from a badge click). */
  onStartQuest: (quest: Quest) => void;
}

interface Transform {
  scale: number;
  tx: number;
  ty: number;
}

/** Deterministic tint per province index (survey knowledge = stable colors). */
const PROVINCE_TINTS = ['#7c5cff', '#2f9e8f', '#c76b98', '#c9a13b', '#4a90d9', '#d1603a', '#5aa469', '#8a7bd8', '#c05b5b'];

function stateOf(coverage: UserCoverage, id: string): CoverageState {
  return coverage.components[id]?.state ?? 'fog';
}

function px(nx: number): number {
  return PAD + nx * (VIEW_W - 2 * PAD);
}
function py(ny: number): number {
  return PAD + ny * (VIEW_H - 2 * PAD);
}

/** Convex-hull-ish tinted region per province: a soft blob behind its nodes. */
function ProvinceRegion({
  map,
  provinceId,
  tint,
}: {
  map: MapJson;
  provinceId: string;
  tint: string;
}): JSX.Element | null {
  const pts = map.nodes.filter((n) => n.province === provinceId).map((n) => ({ x: px(n.x), y: py(n.y) }));
  if (pts.length === 0) return null;
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  // radius that comfortably encloses the province's nodes
  const r = Math.max(90, ...pts.map((p) => Math.hypot(p.x - cx, p.y - cy))) + 70;
  return <circle cx={cx} cy={cy} r={r} fill={tint} opacity={0.1} stroke={tint} strokeOpacity={0.25} strokeWidth={1.5} />;
}

export function MapView({
  map,
  coverage,
  selectedId,
  onSelect,
  pendingByComponent,
  justUpdatedId,
  onStartQuest,
}: Props): JSX.Element {
  const [t, setT] = useState<Transform>({ scale: 1, tx: 0, ty: 0 });
  const svgRef = useRef<SVGSVGElement | null>(null);
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinch = useRef<{ dist: number; scale: number } | null>(null);

  const tintByProvince = useMemo(() => {
    const m = new Map<string, string>();
    map.provinces.forEach((p, i) => m.set(p.id, PROVINCE_TINTS[i % PROVINCE_TINTS.length] ?? '#888'));
    return m;
  }, [map.provinces]);

  const nodeById = useMemo(() => {
    const m = new Map<string, (typeof map.nodes)[number]>();
    for (const n of map.nodes) m.set(n.id, n);
    return m;
  }, [map.nodes]);

  // client px -> svg viewBox coords
  const toView = (clientX: number, clientY: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: ((clientX - rect.left) / rect.width) * VIEW_W,
      y: ((clientY - rect.top) / rect.height) * VIEW_H,
    };
  };

  const onWheel = (e: ReactWheelEvent<SVGSVGElement>) => {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.0015);
    const next = Math.min(4, Math.max(0.5, t.scale * factor));
    const p = toView(e.clientX, e.clientY);
    // keep the point under the cursor fixed
    const k = next / t.scale;
    setT({
      scale: next,
      tx: p.x - k * (p.x - t.tx),
      ty: p.y - k * (p.y - t.ty),
    });
  };

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      if (a && b) pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), scale: t.scale };
      drag.current = null;
    } else {
      drag.current = { x: e.clientX, y: e.clientY, tx: t.tx, ty: t.ty };
    }
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.current.size === 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      if (a && b) {
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const next = Math.min(4, Math.max(0.5, (pinch.current.scale * dist) / pinch.current.dist));
        const mid = toView((a.x + b.x) / 2, (a.y + b.y) / 2);
        const k = next / t.scale;
        setT({ scale: next, tx: mid.x - k * (mid.x - t.tx), ty: mid.y - k * (mid.y - t.ty) });
      }
      return;
    }

    if (drag.current) {
      const rect = svgRef.current?.getBoundingClientRect();
      const sx = rect ? VIEW_W / rect.width : 1;
      const sy = rect ? VIEW_H / rect.height : 1;
      setT((prev) => ({
        ...prev,
        tx: drag.current!.tx + (e.clientX - drag.current!.x) * sx,
        ty: drag.current!.ty + (e.clientY - drag.current!.y) * sy,
      }));
    }
  };

  const endPointer = (e: ReactPointerEvent<SVGSVGElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size === 0) drag.current = null;
  };

  const reset = () => setT({ scale: 1, tx: 0, ty: 0 });

  return (
    <div className="map-wrap">
      <svg
        ref={svgRef}
        className="map-svg"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="xMidYMid meet"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onPointerLeave={endPointer}
      >
        <defs>
          <radialGradient id="bg" cx="50%" cy="40%" r="75%">
            <stop offset="0%" stopColor="#12151d" />
            <stop offset="100%" stopColor="#0a0c12" />
          </radialGradient>
        </defs>
        <rect x={0} y={0} width={VIEW_W} height={VIEW_H} fill="url(#bg)" />

        <g transform={`translate(${t.tx} ${t.ty}) scale(${t.scale})`}>
          {/* province regions (tinted hulls) */}
          {map.provinces.map((p) => (
            <ProvinceRegion key={p.id} map={map} provinceId={p.id} tint={tintByProvince.get(p.id) ?? '#888'} />
          ))}

          {/* province labels */}
          {map.provinces.map((p) => {
            const pts = map.nodes.filter((n) => n.province === p.id);
            if (pts.length === 0) return null;
            const cx = pts.reduce((s, n) => s + px(n.x), 0) / pts.length;
            const minY = Math.min(...pts.map((n) => py(n.y)));
            return (
              <text key={`lbl-${p.id}`} x={cx} y={minY - 78} className="province-label" textAnchor="middle">
                {p.name}
              </text>
            );
          })}

          {/* edges (node<->node only; province-hierarchy edges skipped) */}
          {map.edges.map((e, i) => {
            const a = nodeById.get(e.from);
            const b = nodeById.get(e.to);
            if (!a || !b) return null;
            return (
              <line
                key={`e${i}`}
                x1={px(a.x)}
                y1={py(a.y)}
                x2={px(b.x)}
                y2={py(b.y)}
                className={`edge edge-${e.kind}`}
              />
            );
          })}

          {/* nodes (components / castles) */}
          {map.nodes.map((n) => {
            const st = stateOf(coverage, n.id);
            const skin = skinFor(st);
            const r = 12 + n.importance * 22;
            const selected = n.id === selectedId;
            const fog = skin.treatment === 'fog';
            const pendingQuests = pendingByComponent.get(n.id) ?? [];
            const hasQuest = pendingQuests.length > 0;
            const updated = n.id === justUpdatedId;
            return (
              <g
                key={n.id}
                transform={`translate(${px(n.x)} ${py(n.y)})`}
                className={`node node-${skin.treatment}${selected ? ' node-selected' : ''}${updated ? ' node-updated' : ''}`}
                onClick={() => onSelect(n.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(ev) => {
                  if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault();
                    onSelect(n.id);
                  }
                }}
              >
                {updated && <circle r={r} className="conquest-pulse" stroke={skin.color} />}
                {skin.treatment === 'rebellion' && (
                  <circle r={r + 7} className="rebellion-ring" stroke={skin.color} />
                )}
                {selected && <circle r={r + 4} className="select-ring" />}
                <circle
                  r={r}
                  fill={skin.treatment === 'filled' ? skin.color : '#151a24'}
                  stroke={skin.color}
                  strokeWidth={skin.treatment === 'outlined' || skin.treatment === 'rebellion' ? 3 : 2}
                  opacity={fog ? 0.55 : 1}
                />
                <text y={r + 16} textAnchor="middle" className={`node-label${fog ? ' node-label-fog' : ''}`}>
                  {n.id}
                </text>

                {/* siege badge — a pending quest waiting to be waged (§7.3) */}
                {hasQuest && (
                  <g
                    className="quest-badge"
                    transform={`translate(${r * 0.72} ${-r * 0.72})`}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      onStartQuest(pendingQuests[0]!);
                    }}
                    role="button"
                    tabIndex={0}
                    aria-label={`${QUEST_SKIN.offerEn} (${n.id})`}
                    onKeyDown={(ev) => {
                      if (ev.key === 'Enter' || ev.key === ' ') {
                        ev.preventDefault();
                        ev.stopPropagation();
                        onStartQuest(pendingQuests[0]!);
                      }
                    }}
                  >
                    <circle r={12} className="quest-badge-bg" />
                    <text className="quest-badge-icon" textAnchor="middle" dy={4}>
                      {QUEST_SKIN.badge}
                    </text>
                    {pendingQuests.length > 1 && (
                      <text className="quest-badge-count" x={11} y={-8} textAnchor="middle">
                        {pendingQuests.length}
                      </text>
                    )}
                  </g>
                )}
              </g>
            );
          })}
        </g>
      </svg>

      <div className="map-controls">
        <button type="button" onClick={() => setT((p) => ({ ...p, scale: Math.min(4, p.scale * 1.2) }))} aria-label="Zoom in">
          +
        </button>
        <button type="button" onClick={() => setT((p) => ({ ...p, scale: Math.max(0.5, p.scale / 1.2) }))} aria-label="Zoom out">
          −
        </button>
        <button type="button" onClick={reset} aria-label="Reset view">
          ⤢
        </button>
      </div>
      <div className="map-hint">Scroll to zoom · drag to pan · pinch on touch</div>
    </div>
  );
}
