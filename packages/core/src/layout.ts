/**
 * Deterministic, reproducible map layout (PLAN §4.2). Spatial stability is the
 * whole point of the map (survey knowledge / method-of-loci), and the viewer is
 * a Koei-Sangokushi-style semantic zoom where a zoomed-out province reads as one
 * filled TERRITORY — so provinces must be spatially distinct and nodes must not
 * overlap. The layout therefore guarantees:
 *
 *   - No `Math.random`. A seeded PRNG (mulberry32) keyed off the sorted node-id
 *     set makes the layout byte-identical across runs.
 *   - SEPARATED PROVINCES. Each province gets a spread radius from its node count
 *     (`spread = base + k·√count`, bounded). Centroids sit on a ring whose radius
 *     R ≥ (maxSpread + margin) / sin(π/P) guarantees that every province's spread
 *     circle is disjoint from every other's (adjacent-centroid distance
 *     2·R·sin(π/P) ≥ 2·maxSpread + 2·margin). The ring is then scaled/translated
 *     so all nodes fall inside [BOUND_LO, BOUND_HI]. A single province → center.
 *   - NO NODE COLLISIONS. Within a province nodes start on a compact sunflower
 *     spiral, then a deterministic relaxation (RELAX_ITERS passes) pushes apart
 *     any pair closer than MIN_DIST while gently pulling each node toward its
 *     province centroid and clamping to the province radius + bounds. Result: no
 *     two nodes closer than ~MIN_DIST, provinces stay tight and disjoint.
 *   - INCREMENTAL: when an `existing` map.json is supplied (and `relayout` is not
 *     forced), every node id already present KEEPS its exact coordinates; only
 *     genuinely new ids are placed (near their province's existing cluster) and
 *     relaxed against the frozen nodes as fixed obstacles. Existing nodes never
 *     move. Passing `existing = null` or `opts.relayout` FORCES a full recompute.
 */
import {
  MapJsonSchema,
  type MapJson,
  type MapEdge,
  type MapNode,
  type Province,
} from './schema/map.js';

export interface LayoutInput {
  provinces: Province[];
  nodes: { id: string; province: string }[];
  edges: MapEdge[];
  /** Git SHA the docs were built from; falls back to existing or ''. */
  builtFromSha?: string;
}

export interface LayoutOptions {
  /**
   * Force a full recompute from scratch (deterministic), ignoring any coords in
   * `existing`. Equivalent to passing `existing = null`. Without it, an
   * `existing` map is honored incrementally (existing coords preserved).
   */
  relayout?: boolean;
}

// --- tunable geometry constants --------------------------------------------

/** No two nodes end up closer than this (normalized units). */
export const MIN_DIST = 0.045;
/** All coordinates are kept within [BOUND_LO, BOUND_HI]. */
export const BOUND_LO = 0.06;
export const BOUND_HI = 0.94;

/** Province spread radius = clamp(SPREAD_BASE + SPREAD_K·√count, min, max). */
const SPREAD_BASE = 0.04;
const SPREAD_K = 0.022;
const SPREAD_MIN = 0.05;
const SPREAD_MAX = 0.14;
/** Extra gap enforced between neighboring province spread circles. */
const RING_MARGIN = MIN_DIST;

/** Collision-relaxation passes (with the centroid pull active). */
const RELAX_ITERS = 60;
/** Extra push-only settling passes so the final min-distance holds. */
const SETTLE_ITERS = 20;
/** Per-iteration pull toward the province centroid (0..1). */
const PULL = 0.04;
/**
 * Push colliding pairs apart to slightly MORE than MIN_DIST, so residual jitter
 * from later pairs in the same Gauss-Seidel pass still leaves them ≥ MIN_DIST.
 */
const SEP_TARGET = MIN_DIST * 1.12;

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

// --- seeded PRNG ------------------------------------------------------------

/** FNV-1a 32-bit string hash → a stable numeric seed. */
function hashStringToSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — tiny deterministic PRNG in [0,1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clampBounds = (v: number): number => Math.max(BOUND_LO, Math.min(BOUND_HI, v));

/** Province spread radius from node count. */
function spreadFor(count: number): number {
  return Math.max(SPREAD_MIN, Math.min(SPREAD_MAX, SPREAD_BASE + SPREAD_K * Math.sqrt(count)));
}

interface Pt {
  x: number;
  y: number;
}

// --- collision relaxation ---------------------------------------------------

/**
 * Deterministic Gauss-Seidel relaxation. Moves only `movable` indices; every
 * other point is a fixed obstacle. Each pass: pull movable nodes toward their
 * province centroid (clamped to the province radius + bounds), then push apart
 * any pair closer than MIN_DIST (clamped to bounds). The push is the final
 * operation, so the returned positions satisfy the min-distance separation.
 */
function relax(
  pts: Pt[],
  movable: boolean[],
  centroidOf: Pt[],
  spreadOf: number[],
  iters: number,
): void {
  const n = pts.length;

  /** One push-apart pass over all colliding pairs; ends on a clean separation. */
  const pushPass = (): void => {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (!movable[i] && !movable[j]) continue;
        let dx = pts[j]!.x - pts[i]!.x;
        let dy = pts[j]!.y - pts[i]!.y;
        let d = Math.hypot(dx, dy);
        if (d >= SEP_TARGET) continue;
        if (d < 1e-9) {
          // Coincident: separate along a deterministic direction.
          const ang = ((i * 7 + j) % 360) * GOLDEN_ANGLE;
          dx = Math.cos(ang);
          dy = Math.sin(ang);
          d = 1;
        }
        const ux = dx / d;
        const uy = dy / d;
        const overlap = SEP_TARGET - d;
        if (movable[i] && movable[j]) {
          pts[i]!.x -= ux * overlap * 0.5;
          pts[i]!.y -= uy * overlap * 0.5;
          pts[j]!.x += ux * overlap * 0.5;
          pts[j]!.y += uy * overlap * 0.5;
        } else if (movable[i]) {
          pts[i]!.x -= ux * overlap;
          pts[i]!.y -= uy * overlap;
        } else {
          pts[j]!.x += ux * overlap;
          pts[j]!.y += uy * overlap;
        }
        if (movable[i]) {
          pts[i]!.x = clampBounds(pts[i]!.x);
          pts[i]!.y = clampBounds(pts[i]!.y);
        }
        if (movable[j]) {
          pts[j]!.x = clampBounds(pts[j]!.x);
          pts[j]!.y = clampBounds(pts[j]!.y);
        }
      }
    }
  };

  const clampToProvince = (i: number): void => {
    const c = centroidOf[i]!;
    const r = spreadOf[i]!;
    let dx = pts[i]!.x - c.x;
    let dy = pts[i]!.y - c.y;
    const d = Math.hypot(dx, dy);
    if (d > r && d > 0) {
      dx = (dx / d) * r;
      dy = (dy / d) * r;
      pts[i]!.x = c.x + dx;
      pts[i]!.y = c.y + dy;
    }
    pts[i]!.x = clampBounds(pts[i]!.x);
    pts[i]!.y = clampBounds(pts[i]!.y);
  };

  for (let it = 0; it < iters; it++) {
    // 1) Pull toward centroid + clamp to province radius and bounds.
    for (let i = 0; i < n; i++) {
      if (!movable[i]) continue;
      const c = centroidOf[i]!;
      pts[i]!.x += PULL * (c.x - pts[i]!.x);
      pts[i]!.y += PULL * (c.y - pts[i]!.y);
      clampToProvince(i);
    }
    // 2) Push apart every colliding pair.
    pushPass();
  }

  // Final push-only settling: with the centroid pull switched off, iterate the
  // separation to convergence so the returned min-distance is ≥ MIN_DIST.
  for (let s = 0; s < SETTLE_ITERS; s++) pushPass();
}

/**
 * Compute (or incrementally extend) the frozen map layout. Deterministic:
 * identical input → identical output. Validated against MapJsonSchema.
 *
 * @param existing prior map.json for incremental placement (coords preserved).
 * @param opts     `relayout: true` forces a full recompute ignoring `existing`.
 */
export function computeLayout(
  input: LayoutInput,
  existing?: MapJson | null,
  opts?: LayoutOptions,
): MapJson {
  const provinces = [...input.provinces].sort((a, b) => a.id.localeCompare(b.id));
  const P = provinces.length;

  // Force full recompute when asked, or when there is no prior map to honor.
  const forceFull = opts?.relayout === true || existing == null;

  // Seed from the sorted node-id set → reproducible across runs.
  const sortedIds = input.nodes.map((n) => n.id).slice().sort();
  const rand = mulberry32(hashStringToSeed(sortedIds.join(',')));
  const baseAngle = rand() * Math.PI * 2;

  // Importance from reference/depends_on in-degree (centrality proxy).
  const indeg = new Map<string, number>();
  for (const n of input.nodes) indeg.set(n.id, 0);
  for (const e of input.edges) {
    if (e.kind === 'reference' || e.kind === 'depends_on') {
      indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    }
  }
  const maxIndeg = Math.max(0, ...indeg.values());
  const importanceOf = (id: string): number =>
    maxIndeg > 0 ? (indeg.get(id) ?? 0) / maxIndeg : 0;

  // Group node ids by province, sorted, for a stable placement index.
  const byProvince = new Map<string, string[]>();
  for (const n of [...input.nodes].sort((a, b) => a.id.localeCompare(b.id))) {
    const list = byProvince.get(n.province) ?? [];
    list.push(n.id);
    byProvince.set(n.province, list);
  }
  const provinceOf = new Map(input.nodes.map((n) => [n.id, n.province]));
  const provinceOrder = [...byProvince.keys()].sort();

  // Per-province spread radius (from node count) and the ring radius R that
  // guarantees disjoint province circles.
  const spreadByProvince = new Map<string, number>();
  for (const [prov, ids] of byProvince) spreadByProvince.set(prov, spreadFor(ids.length));
  const maxSpread = Math.max(SPREAD_MIN, ...spreadByProvince.values());
  // R ≥ (maxSpread + margin) / sin(π/P): adjacent centroids are then
  // 2·R·sin(π/P) ≥ 2·maxSpread + 2·margin apart → spread circles are disjoint.
  const ringR = P <= 1 ? 0 : (maxSpread + RING_MARGIN) / Math.sin(Math.PI / P);

  // "Ideal" province centroids on the ring around the map center (0.5, 0.5).
  // Used directly by the full recompute; used as a fallback for brand-new
  // provinces in the incremental path.
  const idealCentroid = new Map<string, Pt>();
  provinceOrder.forEach((prov, i) => {
    if (P <= 1) {
      idealCentroid.set(prov, { x: 0.5, y: 0.5 });
    } else {
      const angle = baseAngle + (2 * Math.PI * i) / P;
      idealCentroid.set(prov, {
        x: 0.5 + ringR * Math.cos(angle),
        y: 0.5 + ringR * Math.sin(angle),
      });
    }
  });

  // ---- assemble the working point set -------------------------------------
  const existingCoords = new Map<string, Pt>();
  if (!forceFull) {
    for (const n of existing?.nodes ?? []) existingCoords.set(n.id, { x: n.x, y: n.y });
  }

  // Incremental province centroids: mean of a province's EXISTING nodes (so new
  // nodes join their neighbors), falling back to the ideal ring slot.
  const incCentroid = new Map<string, Pt>();
  if (!forceFull) {
    for (const prov of provinceOrder) {
      const kept = byProvince
        .get(prov)!
        .map((id) => existingCoords.get(id))
        .filter((p): p is Pt => p != null);
      if (kept.length > 0) {
        const cx = kept.reduce((s, p) => s + p.x, 0) / kept.length;
        const cy = kept.reduce((s, p) => s + p.y, 0) / kept.length;
        incCentroid.set(prov, { x: cx, y: cy });
      } else {
        incCentroid.set(prov, idealCentroid.get(prov)!);
      }
    }
  }

  // Flat parallel arrays for relaxation, in a globally stable order.
  const ids: string[] = [];
  const pts: Pt[] = [];
  const movable: boolean[] = [];
  const centroidOf: Pt[] = [];
  const spreadOf: number[] = [];

  for (const prov of provinceOrder) {
    const provIds = byProvince.get(prov)!;
    const spread = spreadByProvince.get(prov)!;
    const centroid = (forceFull ? idealCentroid.get(prov) : incCentroid.get(prov))!;
    const count = provIds.length;
    provIds.forEach((id, k) => {
      const kept = existingCoords.get(id);
      // Draw two PRNG values per node regardless of path so the stream depends
      // only on the node-id set, not on which nodes are pre-existing.
      const jx = rand();
      const jy = rand();
      ids.push(id);
      centroidOf.push(centroid);
      spreadOf.push(spread);
      if (kept) {
        pts.push({ x: kept.x, y: kept.y });
        movable.push(false);
      } else {
        // Compact sunflower placement inside the province spread circle.
        const rr = count <= 1 ? 0 : spread * Math.sqrt((k + 0.5) / count);
        const ang = baseAngle + k * GOLDEN_ANGLE;
        pts.push({
          x: centroid.x + rr * Math.cos(ang) + (jx - 0.5) * 0.01,
          y: centroid.y + rr * Math.sin(ang) + (jy - 0.5) * 0.01,
        });
        movable.push(true);
      }
    });
  }

  // ---- full recompute: normalize the whole ring into [BOUND_LO, BOUND_HI] --
  if (forceFull && pts.length > 0) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    const spanX = maxX - minX;
    const spanY = maxY - minY;
    const span = Math.max(spanX, spanY);
    const target = BOUND_HI - BOUND_LO;
    const scale = span > 1e-9 ? target / span : 1;
    // Uniform scale (keeps province circles circular) + center within bounds.
    const offX = BOUND_LO + (target - spanX * scale) / 2;
    const offY = BOUND_LO + (target - spanY * scale) / 2;
    const apply = (p: Pt): Pt => ({
      x: offX + (p.x - minX) * scale,
      y: offY + (p.y - minY) * scale,
    });
    for (let i = 0; i < pts.length; i++) pts[i] = apply(pts[i]!);
    // Transform the pull targets too, and scale the spread radii to match.
    const movedCentroid = new Map<string, Pt>();
    for (const prov of provinceOrder) movedCentroid.set(prov, apply(idealCentroid.get(prov)!));
    for (let i = 0; i < ids.length; i++) {
      centroidOf[i] = movedCentroid.get(provinceOf.get(ids[i]!) ?? provinceOrder[0]!)!;
      spreadOf[i] = spreadOf[i]! * scale;
    }
  }

  // ---- relax to remove collisions (moves only `movable` nodes) ------------
  if (movable.some(Boolean)) {
    relax(pts, movable, centroidOf, spreadOf, RELAX_ITERS);
  }

  // ---- emit ---------------------------------------------------------------
  const outNodes: MapNode[] = ids.map((id, i) => ({
    id,
    province: provinceOf.get(id) ?? provinceOrder[0]!,
    x: clampBounds(pts[i]!.x),
    y: clampBounds(pts[i]!.y),
    importance: importanceOf(id),
  }));

  const result: MapJson = {
    version: 1,
    builtFromSha: input.builtFromSha ?? (forceFull ? '' : existing?.builtFromSha) ?? '',
    provinces,
    nodes: outNodes,
    edges: input.edges,
  };
  return MapJsonSchema.parse(result);
}
