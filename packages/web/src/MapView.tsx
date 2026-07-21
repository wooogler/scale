import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { MapJson, MapNode, UserCoverage, CoverageState, Quest } from '@scale/core/browser';
import { skinFor, QUEST_SKIN } from './skin.js';
import { useStrings } from './i18n.js';

const VIEW_W = 1000;
const VIEW_H = 680;
const PAD = 70; // keep nodes off the very edges of the frozen layout box

// Zoom limits.
const MIN_SCALE = 0.45;
const MAX_SCALE = 4.5;

/**
 * Fit-to-content is CLAMPED to this scale so the realm always opens in the
 * province (territory) tier — comfortably below NODE_FADE_IN[0].
 */
const FIT_MAX_SCALE = 0.82;

/**
 * Level-of-detail thresholds, expressed in current zoom `scale`. Each tier
 * cross-fades via smoothstep so zooming feels continuous (no popping).
 *
 *   territory tier   scale < ~0.9        provinces as filled hulls + names only
 *   node tier        ~0.9 – ~1.5         castles fade in; names shrink/dim a bit
 *   detail tier      scale > ~1.5        node labels + incident roads fade in
 */
const NODE_FADE_IN: [number, number] = [0.86, 1.35]; // castles + quest badges
const LABEL_FADE_IN: [number, number] = [1.5, 1.95]; // node labels
const EDGE_FADE_IN: [number, number] = [0.95, 1.4]; // incident roads (hover/select)
const EDGE_HINT: [number, number] = [1.75, 2.4]; // faint hint of the whole graph

// Brightened, higher-saturation province tints so each FILLED hull reads as a
// distinct colored region on the near-black ground (they used to be muddy).
const PROVINCE_TINTS = [
  '#9a7dff',
  '#3fc4b0',
  '#e07bab',
  '#e6bd52',
  '#5aa8f0',
  '#f0774a',
  '#6cc47d',
  '#a394ef',
  '#e57070',
];

interface Props {
  map: MapJson;
  coverage: UserCoverage;
  selectedId: string | null;
  onSelect: (id: string) => void;
  pendingByComponent: Map<string, Quest[]>;
  justUpdatedId: string | null;
  onStartQuest: (quest: Quest) => void;
  /** Coverage state currently hovered/focused in the legend, or null. */
  highlightState: CoverageState | null;
}

interface Transform {
  scale: number;
  tx: number;
  ty: number;
}

interface Pt {
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Smooth 0→1 ramp between two edges (Hermite), for continuous cross-fades. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function stateOf(coverage: UserCoverage, id: string): CoverageState {
  return coverage.components[id]?.state ?? 'fog';
}

function px(nx: number): number {
  return PAD + nx * (VIEW_W - 2 * PAD);
}
function py(ny: number): number {
  return PAD + ny * (VIEW_H - 2 * PAD);
}

function nodeRadius(importance: number): number {
  return 12 + importance * 22;
}

/** Andrew's monotone-chain convex hull. Returns CCW hull vertices. */
function convexHull(points: Pt[]): Pt[] {
  const pts = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  const n = pts.length;
  if (n <= 2) return pts;
  const cross = (o: Pt, a: Pt, b: Pt): number =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const lower: Pt[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0)
      lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0)
      upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** A smooth closed path through the edge-midpoints of a polygon (blobby). */
function roundedClosedPath(poly: Pt[]): string {
  const n = poly.length;
  if (n < 3) return '';
  const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const start = mid(poly[n - 1]!, poly[0]!);
  let d = `M ${start.x.toFixed(1)} ${start.y.toFixed(1)}`;
  for (let i = 0; i < n; i++) {
    const curr = poly[i]!;
    const m = mid(curr, poly[(i + 1) % n]!);
    d += ` Q ${curr.x.toFixed(1)} ${curr.y.toFixed(1)} ${m.x.toFixed(1)} ${m.y.toFixed(1)}`;
  }
  return d + ' Z';
}

/**
 * A padded, rounded territory outline around a province's node points, in VIEW
 * coords. 3+ points → padded convex hull; 1–2 points → a padded rounded blob
 * (octagon) so a sparse province still reads as a region.
 */
function territoryPath(points: Pt[], pad: number): { d: string; cx: number; cy: number } {
  const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const cy = points.reduce((s, p) => s + p.y, 0) / points.length;

  let hull = convexHull(points);
  if (hull.length < 3) {
    const rr = Math.max(0, ...points.map((p) => Math.hypot(p.x - cx, p.y - cy))) + pad + 34;
    const oct: Pt[] = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      oct.push({ x: cx + Math.cos(a) * rr, y: cy + Math.sin(a) * rr });
    }
    return { d: roundedClosedPath(oct), cx, cy };
  }

  const expanded = hull.map((v) => {
    const dx = v.x - cx;
    const dy = v.y - cy;
    const dist = Math.hypot(dx, dy) || 1;
    return { x: v.x + (dx / dist) * pad, y: v.y + (dy / dist) * pad };
  });
  return { d: roundedClosedPath(expanded), cx, cy };
}

function boxesOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

// ---------------------------------------------------------------------------
// component
// ---------------------------------------------------------------------------

export function MapView({
  map,
  coverage,
  selectedId,
  onSelect,
  pendingByComponent,
  justUpdatedId,
  onStartQuest,
  highlightState,
}: Props): JSX.Element {
  const S = useStrings();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const drag = useRef<{ x: number; y: number; tx: number; ty: number; moved: boolean } | null>(null);
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinch = useRef<{ dist: number; scale: number } | null>(null);

  const [hoveredId, setHoveredId] = useState<string | null>(null);

  // Fit-to-content: frame the whole realm with padding, clamped into the
  // territory tier so the map opens on provinces (PLAN §1 survey knowledge).
  const fitTransform = useMemo<Transform>(() => {
    const pts = map.nodes.map((n) => ({ x: px(n.x), y: py(n.y) }));
    if (pts.length === 0) return { scale: FIT_MAX_SCALE, tx: 0, ty: 0 };
    const minX = Math.min(...pts.map((p) => p.x));
    const maxX = Math.max(...pts.map((p) => p.x));
    const minY = Math.min(...pts.map((p) => p.y));
    const maxY = Math.max(...pts.map((p) => p.y));
    const contentPad = 150; // room for territory hulls + province names
    const bw = maxX - minX + contentPad * 2;
    const bh = maxY - minY + contentPad * 2;
    const scale = clamp(Math.min(VIEW_W / bw, VIEW_H / bh), MIN_SCALE, FIT_MAX_SCALE);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    return { scale, tx: VIEW_W / 2 - scale * cx, ty: VIEW_H / 2 - scale * cy };
  }, [map.nodes]);

  const [t, setT] = useState<Transform>(fitTransform);
  const s = t.scale;

  // When a legend status is highlighted, the whole "landscape" recedes so the
  // matching castles are the only strong read.
  const hlActive = highlightState != null;
  const hlDim = hlActive ? 0.28 : 1;

  // --- per-tier cross-fade opacities (all continuous in scale) ---
  // Territories are now BOLDLY FILLED at the overview tier (dominant read),
  // fading down as we zoom into detail so they never overpower castle labels.
  const territoryFill =
    (0.82 - 0.6 * smoothstep(0.9, 1.7, s) - 0.12 * smoothstep(1.7, 2.6, s)) * hlDim;
  const territoryStroke = 0.7 * (1 - 0.35 * smoothstep(1.0, 1.8, s)) * hlDim;
  const provinceNameAlpha = (1 - 0.72 * smoothstep(1.55, 2.6, s)) * (hlActive ? 0.22 : 1);
  const nodeAlpha = smoothstep(NODE_FADE_IN[0], NODE_FADE_IN[1], s);
  const labelAlpha = smoothstep(LABEL_FADE_IN[0], LABEL_FADE_IN[1], s);
  const incidentEdgeAlpha = smoothstep(EDGE_FADE_IN[0], EDGE_FADE_IN[1], s) * hlDim;
  const edgeHintAlpha = 0.09 * smoothstep(EDGE_HINT[0], EDGE_HINT[1], s) * hlDim;
  const nodesInteractive = nodeAlpha > 0.12;

  const tintByProvince = useMemo(() => {
    const m = new Map<string, string>();
    map.provinces.forEach((p, i) => m.set(p.id, PROVINCE_TINTS[i % PROVINCE_TINTS.length] ?? '#888'));
    return m;
  }, [map.provinces]);

  const nodeById = useMemo(() => {
    const m = new Map<string, MapNode>();
    for (const n of map.nodes) m.set(n.id, n);
    return m;
  }, [map.nodes]);

  // Territory hull path + name anchor per province (VIEW coords; frozen layout).
  const territories = useMemo(() => {
    return map.provinces
      .map((p) => {
        const pts = map.nodes
          .filter((n) => n.province === p.id)
          .map((n) => ({ x: px(n.x), y: py(n.y) }));
        if (pts.length === 0) return null;
        const geo = territoryPath(pts, 62);
        return { id: p.id, name: p.name, tint: tintByProvince.get(p.id) ?? '#888', ...geo };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  }, [map.provinces, map.nodes, tintByProvince]);

  // Greedy label decluttering in SCREEN space, by importance desc. Hovered /
  // selected reserve their boxes first so they always win; others skip if they
  // would overlap an already-placed label. Hidden labels still show on hover.
  const labelVisible = useMemo(() => {
    const show = new Set<string>();
    if (labelAlpha <= 0.02) return show;
    const boxes: { x: number; y: number; w: number; h: number }[] = [];
    const boxFor = (n: MapNode) => {
      const sx = t.tx + px(n.x) * s;
      const sy = t.ty + py(n.y) * s;
      const r = nodeRadius(n.importance);
      const w = n.id.length * 7 + 14;
      return { x: sx - w / 2, y: sy + r + 2, w, h: 18 };
    };
    // reserve priority labels first
    for (const n of map.nodes) {
      if (n.id === hoveredId || n.id === selectedId) boxes.push(boxFor(n));
    }
    const ordered = [...map.nodes].sort((a, b) => b.importance - a.importance);
    for (const n of ordered) {
      if (n.id === hoveredId || n.id === selectedId) {
        show.add(n.id);
        continue;
      }
      const box = boxFor(n);
      if (boxes.some((b) => boxesOverlap(box, b))) continue;
      boxes.push(box);
      show.add(n.id);
    }
    return show;
  }, [map.nodes, t, s, labelAlpha, hoveredId, selectedId]);

  const activeId = hoveredId ?? selectedId;

  // client px -> svg viewBox coords
  const toView = (clientX: number, clientY: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: ((clientX - rect.left) / rect.width) * VIEW_W,
      y: ((clientY - rect.top) / rect.height) * VIEW_H,
    };
  };

  // Wheel + trackpad-pinch zoom. React's onWheel is passive (preventDefault is
  // a no-op there), so we attach a NON-PASSIVE native listener and preventDefault
  // every wheel over the map — the map is the whole surface, nothing scrolls.
  // On a macOS trackpad a pinch arrives as a wheel event with ctrlKey === true;
  // without preventDefault the BROWSER page-zooms. We also add a capture-phase
  // document listener as a belt-and-suspenders against browser global zoom, plus
  // Safari gesture* preventDefault.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;

    const viewAt = (clientX: number, clientY: number) => {
      const rect = el.getBoundingClientRect();
      return {
        x: ((clientX - rect.left) / rect.width) * VIEW_W,
        y: ((clientY - rect.top) / rect.height) * VIEW_H,
      };
    };
    const zoomAbout = (p: Pt, factor: number) =>
      setT((prev) => {
        const next = clamp(prev.scale * factor, MIN_SCALE, MAX_SCALE);
        const k = next / prev.scale; // keep the point under the cursor fixed
        return { scale: next, tx: p.x - k * (p.x - prev.tx), ty: p.y - k * (p.y - prev.ty) };
      });

    const onWheelNative = (e: WheelEvent) => {
      e.preventDefault();
      // pinch → smooth exponential; plain scroll → step (deltaY<0 → in)
      const factor = e.ctrlKey
        ? Math.exp(-e.deltaY * 0.012)
        : e.deltaY < 0
          ? 1.1
          : 1 / 1.1;
      zoomAbout(viewAt(e.clientX, e.clientY), factor);
    };
    el.addEventListener('wheel', onWheelNative, { passive: false });

    // Capture-phase guard: kill any pinch-wheel over the map before the browser
    // can turn it into a page zoom, even if the target is a nested SVG child.
    const onDocWheelCapture = (e: WheelEvent) => {
      if (e.ctrlKey && el.contains(e.target as Node)) e.preventDefault();
    };
    document.addEventListener('wheel', onDocWheelCapture, { passive: false, capture: true });

    // Safari pinch: gesture events. preventDefault stops page zoom; e.scale
    // (the cumulative pinch ratio) drives the map zoom about the element center.
    let gestureBase = 1;
    const gestureCenter = () => viewAt(el.getBoundingClientRect().left + el.clientWidth / 2, el.getBoundingClientRect().top + el.clientHeight / 2);
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      gestureBase = (e as unknown as { scale: number }).scale || 1;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const sc = (e as unknown as { scale: number }).scale || 1;
      const factor = sc / (gestureBase || 1);
      gestureBase = sc;
      zoomAbout(gestureCenter(), factor);
    };
    const onGestureEnd = (e: Event) => e.preventDefault();
    el.addEventListener('gesturestart', onGestureStart as EventListener);
    el.addEventListener('gesturechange', onGestureChange as EventListener);
    el.addEventListener('gestureend', onGestureEnd as EventListener);

    return () => {
      el.removeEventListener('wheel', onWheelNative);
      document.removeEventListener('wheel', onDocWheelCapture, { capture: true } as EventListenerOptions);
      el.removeEventListener('gesturestart', onGestureStart as EventListener);
      el.removeEventListener('gesturechange', onGestureChange as EventListener);
      el.removeEventListener('gestureend', onGestureEnd as EventListener);
    };
  }, []);

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      if (a && b) pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), scale: t.scale };
      drag.current = null;
    } else {
      drag.current = { x: e.clientX, y: e.clientY, tx: t.tx, ty: t.ty, moved: false };
    }
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.current.size === 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      if (a && b) {
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const next = clamp((pinch.current.scale * dist) / pinch.current.dist, MIN_SCALE, MAX_SCALE);
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
      if (Math.abs(e.clientX - drag.current.x) + Math.abs(e.clientY - drag.current.y) > 3)
        drag.current.moved = true;
      const d = drag.current;
      setT((prev) => ({
        ...prev,
        tx: d.tx + (e.clientX - d.x) * sx,
        ty: d.ty + (e.clientY - d.y) * sy,
      }));
    }
  };

  const endPointer = (e: ReactPointerEvent<SVGSVGElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size === 0) drag.current = null;
  };

  const reset = () => setT(fitTransform);
  const zoomBy = (factor: number) =>
    setT((prev) => {
      const next = clamp(prev.scale * factor, MIN_SCALE, MAX_SCALE);
      const k = next / prev.scale;
      // zoom toward the viewport center
      return {
        scale: next,
        tx: VIEW_W / 2 - k * (VIEW_W / 2 - prev.tx),
        ty: VIEW_H / 2 - k * (VIEW_H / 2 - prev.ty),
      };
    });

  // did this node group receive a real click (not the end of a pan)?
  const clickNode = (id: string) => {
    if (drag.current?.moved) return;
    onSelect(id);
  };

  return (
    <div className="map-wrap">
      <svg
        ref={svgRef}
        className="map-svg"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="xMidYMid meet"
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
          {/* ---- TERRITORY TIER: filled province hulls ---- */}
          {territories.map((tr) => (
            <path
              key={`terr-${tr.id}`}
              d={tr.d}
              className="territory"
              fill={tr.tint}
              fillOpacity={territoryFill}
              stroke={tr.tint}
              strokeOpacity={territoryStroke}
              vectorEffect="non-scaling-stroke"
            />
          ))}

          {/* faint hint of the whole road graph (detail tier only) */}
          {edgeHintAlpha > 0.01 &&
            map.edges.map((e, i) => {
              const a = nodeById.get(e.from);
              const b = nodeById.get(e.to);
              if (!a || !b) return null;
              return (
                <line
                  key={`hint${i}`}
                  x1={px(a.x)}
                  y1={py(a.y)}
                  x2={px(b.x)}
                  y2={py(b.y)}
                  className={`edge edge-${e.kind}`}
                  opacity={edgeHintAlpha}
                  vectorEffect="non-scaling-stroke"
                />
              );
            })}

          {/* incident roads for the hovered / selected castle only */}
          {activeId &&
            incidentEdgeAlpha > 0.01 &&
            map.edges.map((e, i) => {
              if (e.from !== activeId && e.to !== activeId) return null;
              const a = nodeById.get(e.from);
              const b = nodeById.get(e.to);
              if (!a || !b) return null;
              return (
                <line
                  key={`inc${i}`}
                  x1={px(a.x)}
                  y1={py(a.y)}
                  x2={px(b.x)}
                  y2={py(b.y)}
                  className={`edge edge-${e.kind} edge-incident`}
                  opacity={incidentEdgeAlpha}
                  vectorEffect="non-scaling-stroke"
                />
              );
            })}

          {/* ---- province names (centered on each territory) ---- */}
          {provinceNameAlpha > 0.02 &&
            territories.map((tr) => (
              <text
                key={`name-${tr.id}`}
                x={tr.cx}
                y={tr.cy}
                className="province-name"
                textAnchor="middle"
                dominantBaseline="middle"
                opacity={provinceNameAlpha}
                fill={tr.tint}
              >
                {tr.name}
              </text>
            ))}

          {/* ---- NODE / DETAIL TIER: castles ----
              When a legend status is highlighted, matching castles render (and
              POP) even at the overview tier so you can spot e.g. every 정복
              across the realm at a glance. */}
          {(nodeAlpha > 0.02 || hlActive) &&
            map.nodes.map((n) => {
              const st = stateOf(coverage, n.id);
              const skin = skinFor(st);
              const r = nodeRadius(n.importance);
              const selected = n.id === selectedId;
              const hovered = n.id === hoveredId;
              const fog = skin.treatment === 'fog';
              const pendingQuests = pendingByComponent.get(n.id) ?? [];
              const hasQuest = pendingQuests.length > 0;
              const updated = n.id === justUpdatedId;
              const matches = hlActive && st === highlightState;
              // opacity: highlighted status pops to full; everything else dims
              // heavily. Otherwise fall back to the normal LOD node fade.
              const nodeOpacity = hlActive
                ? matches
                  ? 1
                  : Math.min(nodeAlpha, 0.1)
                : nodeAlpha;
              const interactive = matches || nodesInteractive;
              const showLabel = matches
                ? 1
                : labelVisible.has(n.id)
                  ? labelAlpha
                  : hovered || selected
                    ? 1
                    : 0;
              const w = n.id.length * 7 + 14;
              return (
                <g
                  key={n.id}
                  // counter-scale so castles keep a constant on-screen size
                  transform={`translate(${px(n.x)} ${py(n.y)}) scale(${1 / s})`}
                  className={`node node-${skin.treatment}${selected ? ' node-selected' : ''}${
                    updated ? ' node-updated' : ''
                  }${matches ? ' node-highlighted' : ''}`}
                  style={{ opacity: nodeOpacity, pointerEvents: interactive ? 'auto' : 'none' }}
                  onClick={() => clickNode(n.id)}
                  onPointerEnter={() => setHoveredId(n.id)}
                  onPointerLeave={() => setHoveredId((cur) => (cur === n.id ? null : cur))}
                  role="button"
                  tabIndex={interactive ? 0 : -1}
                  onKeyDown={(ev) => {
                    if (ev.key === 'Enter' || ev.key === ' ') {
                      ev.preventDefault();
                      onSelect(n.id);
                    }
                  }}
                >
                  {matches && (
                    <circle r={r + 6} className="highlight-ring" stroke={skin.color} />
                  )}
                  {updated && <circle r={r} className="conquest-pulse" stroke={skin.color} />}
                  {skin.treatment === 'rebellion' && (
                    <circle r={r + 7} className="rebellion-ring" stroke={skin.color} />
                  )}
                  {selected && <circle r={r + 4} className="select-ring" />}
                  <circle
                    r={r}
                    fill={skin.treatment === 'filled' ? skin.color : '#151a24'}
                    stroke={skin.color}
                    strokeWidth={
                      skin.treatment === 'outlined' || skin.treatment === 'rebellion' ? 3 : 2
                    }
                    opacity={fog ? 0.6 : 1}
                  />

                  {/* decluttered label with a dark pill for contrast */}
                  {showLabel > 0 && (
                    <g className="node-label-g" opacity={showLabel} style={{ pointerEvents: 'none' }}>
                      <rect
                        className="node-label-pill"
                        x={-w / 2}
                        y={r + 4}
                        width={w}
                        height={17}
                        rx={5}
                      />
                      <text
                        y={r + 16}
                        textAnchor="middle"
                        className={`node-label${fog ? ' node-label-fog' : ''}`}
                      >
                        {n.id}
                      </text>
                    </g>
                  )}

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
                      aria-label={`${S.questOffer} (${n.id})`}
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
        <button type="button" onClick={() => zoomBy(1.25)} aria-label={S.zoomIn}>
          +
        </button>
        <button type="button" onClick={() => zoomBy(1 / 1.25)} aria-label={S.zoomOut}>
          −
        </button>
        <button type="button" onClick={reset} aria-label={S.resetView}>
          ⤢
        </button>
      </div>
      <div className="map-hint">{S.mapHint}</div>
    </div>
  );
}
