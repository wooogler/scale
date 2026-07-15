import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  computeLayout,
  loadScaleDir,
  componentSourcesIndex,
  MapJsonSchema,
  type LayoutInput,
  type MapJson,
} from '../index.js';

const here = dirname(fileURLToPath(import.meta.url));
const sampleRoot = join(here, '..', '..', 'fixtures', 'scale-sample');

function inputFromSample(): LayoutInput {
  const loaded = loadScaleDir(sampleRoot);
  return {
    provinces: loaded.provinces,
    nodes: loaded.papers.map((p) => ({ id: p.id, province: p.province })),
    edges: loaded.edges,
  };
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
