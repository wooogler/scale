/**
 * Deterministic, reproducible map layout (PLAN §4.2). Spatial stability is the
 * whole point of the map (survey knowledge / method-of-loci), so:
 *
 *   - No `Math.random`. A seeded PRNG (mulberry32) keyed off the sorted node-id
 *     set makes the layout byte-identical across runs.
 *   - Provinces cluster: each province gets a centroid on a circle; its
 *     components are placed on a golden-angle spiral around that centroid, all
 *     coordinates produced directly in [0,1] (no global renormalization pass,
 *     which would move existing nodes).
 *   - INCREMENTAL: when an `existing` map.json is supplied, every node id already
 *     present KEEPS its exact coordinates; only genuinely new ids are placed
 *     (near their province centroid). Existing nodes never move.
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
  /** Git SHA the papers were built from; falls back to existing or ''. */
  builtFromSha?: string;
}

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

const clamp01 = (v: number): number => Math.max(0.02, Math.min(0.98, v));
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/**
 * Compute (or incrementally extend) the frozen map layout. Deterministic:
 * identical input → identical output. Validated against MapJsonSchema.
 */
export function computeLayout(input: LayoutInput, existing?: MapJson | null): MapJson {
  const provinces = [...input.provinces].sort((a, b) => a.id.localeCompare(b.id));

  // Seed from the sorted node-id set → reproducible across runs.
  const sortedIds = input.nodes.map((n) => n.id).slice().sort();
  const rand = mulberry32(hashStringToSeed(sortedIds.join(',')));
  const baseAngle = rand() * Math.PI * 2;

  // Province centroids on a circle around the map center.
  const centroids = new Map<string, { x: number; y: number }>();
  const P = provinces.length;
  provinces.forEach((prov, i) => {
    if (P <= 1) {
      centroids.set(prov.id, { x: 0.5, y: 0.5 });
    } else {
      const angle = (2 * Math.PI * i) / P;
      const R = 0.3;
      centroids.set(prov.id, { x: 0.5 + R * Math.cos(angle), y: 0.5 + R * Math.sin(angle) });
    }
  });
  const fallbackCentroid = { x: 0.5, y: 0.5 };

  // Importance from reference/depends_on in-degree (centrality proxy).
  // TODO: fold in git churn (kept at 0 for now — PLAN §4.2).
  const indeg = new Map<string, number>();
  for (const n of input.nodes) indeg.set(n.id, 0);
  for (const e of input.edges) {
    if (e.kind === 'reference' || e.kind === 'depends_on') {
      indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    }
  }
  const maxIndeg = Math.max(0, ...indeg.values());

  // Preserve existing coordinates verbatim.
  const existingCoords = new Map<string, { x: number; y: number }>();
  for (const n of existing?.nodes ?? []) existingCoords.set(n.id, { x: n.x, y: n.y });

  // Group node ids by province, sorted, for a stable spiral index.
  const byProvince = new Map<string, string[]>();
  for (const n of [...input.nodes].sort((a, b) => a.id.localeCompare(b.id))) {
    const list = byProvince.get(n.province) ?? [];
    list.push(n.id);
    byProvince.set(n.province, list);
  }

  const provinceOf = new Map(input.nodes.map((n) => [n.id, n.province]));
  const outNodes: MapNode[] = [];

  // Iterate in a globally stable order so the PRNG stream depends only on the
  // node-id set (not on which nodes happen to be pre-existing).
  for (const prov of [...byProvince.keys()].sort()) {
    const ids = byProvince.get(prov)!;
    const centroid = centroids.get(prov) ?? fallbackCentroid;
    ids.forEach((id, k) => {
      const jx = rand();
      const jy = rand();
      let x: number;
      let y: number;
      const kept = existingCoords.get(id);
      if (kept) {
        x = kept.x;
        y = kept.y;
      } else {
        const radius = ids.length <= 1 ? 0 : Math.min(0.13, 0.045 * Math.sqrt(k + 0.5));
        const ang = baseAngle + k * GOLDEN_ANGLE;
        x = clamp01(centroid.x + radius * Math.cos(ang) + (jx - 0.5) * 0.012);
        y = clamp01(centroid.y + radius * Math.sin(ang) + (jy - 0.5) * 0.012);
      }
      const importance = maxIndeg > 0 ? (indeg.get(id) ?? 0) / maxIndeg : 0;
      outNodes.push({ id, province: provinceOf.get(id) ?? prov, x, y, importance });
    });
  }

  const result: MapJson = {
    version: 1,
    builtFromSha: input.builtFromSha ?? existing?.builtFromSha ?? '',
    provinces,
    nodes: outNodes,
    edges: input.edges,
  };
  return MapJsonSchema.parse(result);
}
