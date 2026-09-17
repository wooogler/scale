import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  computeLayout,
  loadScaleDir,
  componentSourcesIndex,
  MapJsonSchema,
  MIN_DIST,
  BOUND_LO,
  BOUND_HI,
  type LayoutInput,
  type MapJson,
} from '../index.js';

const here = dirname(fileURLToPath(import.meta.url));
const sampleRoot = join(here, '..', '..', 'fixtures', 'scale-sample');

function inputFromSample(): LayoutInput {
  const loaded = loadScaleDir(sampleRoot);
  return {
    provinces: loaded.provinces,
    nodes: loaded.docs.map((d) => ({ id: d.id, province: d.province })),
    edges: loaded.edges,
  };
}

/** Synthetic 7-province × 4–5-node input (≈31 nodes) — the territory case. */
function sevenProvinceInput(): LayoutInput {
  const counts = [5, 4, 5, 4, 5, 4, 4]; // 31 nodes total
  const provinces = counts.map((_, p) => ({ id: `prov${p}`, name: `Province ${p}` }));
  const nodes: { id: string; province: string }[] = [];
  for (let p = 0; p < counts.length; p++) {
    for (let k = 0; k < counts[p]!; k++) {
      nodes.push({ id: `prov${p}-node${k}`, province: `prov${p}` });
    }
  }
  // A few reference edges so importance is exercised (not all-zero).
  const edges = [
    { from: 'prov0-node1', to: 'prov0-node0', kind: 'reference' as const },
    { from: 'prov1-node0', to: 'prov0-node0', kind: 'reference' as const },
    { from: 'prov2-node1', to: 'prov2-node0', kind: 'reference' as const },
  ];
  return { provinces, nodes, edges };
}

/** Minimum pairwise distance among all node coordinates. */
function minPairwise(map: MapJson): number {
  let m = Infinity;
  for (let i = 0; i < map.nodes.length; i++) {
    for (let j = i + 1; j < map.nodes.length; j++) {
      const a = map.nodes[i]!;
      const b = map.nodes[j]!;
      m = Math.min(m, Math.hypot(a.x - b.x, a.y - b.y));
    }
  }
  return m;
}

/** Province centroids = mean of each province's final node positions. */
function provinceCentroids(map: MapJson): Map<string, { x: number; y: number }> {
  const acc = new Map<string, { x: number; y: number; n: number }>();
  for (const n of map.nodes) {
    const a = acc.get(n.province) ?? { x: 0, y: 0, n: 0 };
    a.x += n.x;
    a.y += n.y;
    a.n += 1;
    acc.set(n.province, a);
  }
  const out = new Map<string, { x: number; y: number }>();
  for (const [prov, a] of acc) out.set(prov, { x: a.x / a.n, y: a.y / a.n });
  return out;
}

/** Fraction of nodes whose nearest province centroid is their own province. */
function ownProvinceFraction(map: MapJson): number {
  const cents = provinceCentroids(map);
  let ok = 0;
  for (const n of map.nodes) {
    let best = '';
    let bestD = Infinity;
    for (const [prov, c] of cents) {
      const d = Math.hypot(n.x - c.x, n.y - c.y);
      if (d < bestD) {
        bestD = d;
        best = prov;
      }
    }
    if (best === n.province) ok += 1;
  }
  return ok / map.nodes.length;
}

describe('computeLayout', () => {
  it('is deterministic: same input twice → identical MapJson', () => {
    const input = inputFromSample();
    const a = computeLayout(input);
    const b = computeLayout(input);
    expect(a).toEqual(b);
  });

  it('produces coordinates in [0,1] and validates against the schema', () => {
    const map = computeLayout(inputFromSample());
    for (const n of map.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.x).toBeLessThanOrEqual(1);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeLessThanOrEqual(1);
      expect(n.importance).toBeGreaterThanOrEqual(0);
      expect(n.importance).toBeLessThanOrEqual(1);
    }
    expect(() => MapJsonSchema.parse(map)).not.toThrow();
    expect(map.nodes).toHaveLength(6);
  });

  it('derives importance from reference in-degree (most-linked node is 1)', () => {
    const map = computeLayout(inputFromSample());
    const sm = map.nodes.find((n) => n.id === 'session-management');
    // session-management has the highest reference in-degree (3) → importance 1.
    expect(sm?.importance).toBe(1);
  });

  it('INCREMENTAL: preserves existing node coords and only places new ids', () => {
    const full = inputFromSample();

    // Build an "existing" map that lacks one component (the new one).
    const withoutNew: LayoutInput = {
      ...full,
      nodes: full.nodes.filter((n) => n.id !== 'comments'),
    };
    const existing: MapJson = computeLayout(withoutNew);

    // Now lay out the full set, passing the existing map.
    const next = computeLayout(full, existing);

    // Every previously-present node keeps its EXACT coordinates.
    for (const prev of existing.nodes) {
      const now = next.nodes.find((n) => n.id === prev.id);
      expect(now).toBeDefined();
      expect(now!.x).toBe(prev.x);
      expect(now!.y).toBe(prev.y);
    }

    // The new node exists and is in range.
    const added = next.nodes.find((n) => n.id === 'comments');
    expect(added).toBeDefined();
    expect(added!.x).toBeGreaterThanOrEqual(0);
    expect(added!.x).toBeLessThanOrEqual(1);
    expect(next.nodes).toHaveLength(6);
  });

  it('passes builtFromSha through from existing when not supplied', () => {
    const input = inputFromSample();
    const existing = computeLayout({ ...input, builtFromSha: 'abc1234' });
    const next = computeLayout(input, existing);
    expect(next.builtFromSha).toBe('abc1234');
  });

  it('carries componentSourcesIndex ids as nodes (loader ↔ layout contract)', () => {
    const loaded = loadScaleDir(sampleRoot);
    const ids = new Set(componentSourcesIndex(loaded).map((c) => c.id));
    const map = computeLayout(inputFromSample());
    for (const n of map.nodes) expect(ids.has(n.id)).toBe(true);
  });
});

describe('computeLayout — 7-province territory separation', () => {
  it('(a) no two nodes are closer than MIN_DIST', () => {
    const map = computeLayout(sevenProvinceInput());
    expect(minPairwise(map)).toBeGreaterThanOrEqual(MIN_DIST - 1e-9);
  });

  it('(b) ≥90% of nodes are nearest their own province centroid', () => {
    const map = computeLayout(sevenProvinceInput());
    expect(ownProvinceFraction(map)).toBeGreaterThanOrEqual(0.9);
  });

  it('(c) is deterministic across runs', () => {
    const input = sevenProvinceInput();
    expect(computeLayout(input)).toEqual(computeLayout(input));
  });

  it('(d) keeps all coordinates within [BOUND_LO, BOUND_HI]', () => {
    const map = computeLayout(sevenProvinceInput());
    for (const n of map.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(BOUND_LO - 1e-9);
      expect(n.x).toBeLessThanOrEqual(BOUND_HI + 1e-9);
      expect(n.y).toBeGreaterThanOrEqual(BOUND_LO - 1e-9);
      expect(n.y).toBeLessThanOrEqual(BOUND_HI + 1e-9);
    }
  });

  it('(e) incremental preserves existing coords; relayout does not', () => {
    const full = sevenProvinceInput();
    const withoutNew: LayoutInput = {
      ...full,
      nodes: full.nodes.filter((n) => n.id !== 'prov3-node3'),
    };
    const existing = computeLayout(withoutNew);

    // Incremental: every prior node keeps its exact coordinates; the new node
    // is placed and the map still separates cleanly.
    const inc = computeLayout(full, existing);
    for (const prev of existing.nodes) {
      const now = inc.nodes.find((n) => n.id === prev.id)!;
      expect(now.x).toBe(prev.x);
      expect(now.y).toBe(prev.y);
    }
    expect(inc.nodes.find((n) => n.id === 'prov3-node3')).toBeDefined();
    expect(minPairwise(inc)).toBeGreaterThanOrEqual(MIN_DIST - 1e-9);

    // Relayout: full recompute ignores existing coords — at least one prior node
    // moves (coords are not preserved).
    const relaid = computeLayout(full, existing, { relayout: true });
    const moved = existing.nodes.some((prev) => {
      const now = relaid.nodes.find((n) => n.id === prev.id)!;
      return now.x !== prev.x || now.y !== prev.y;
    });
    expect(moved).toBe(true);
  });
});
