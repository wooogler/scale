import { describe, it, expect } from 'vitest';
import {
  applyEvidence,
  recomputeDrift,
  materializeCoverage,
  emptyComponentCoverage,
  ScaleConfigSchema,
  type EvidenceEntry,
  type MapJson,
  type ScaleConfig,
  type UserCoverage,
} from '../index.js';

const config: ScaleConfig = ScaleConfigSchema.parse({ user: 'u' });

const map: MapJson = {
  version: 1,
  builtFromSha: 'base000',
  provinces: [{ id: 'p', name: 'P' }],
  nodes: [
    { id: 'a', province: 'p', x: 0.5, y: 0.5, importance: 0.8 },
    { id: 'b', province: 'p', x: 0.4, y: 0.4, importance: 0.2 },
  ],
  edges: [],
};

const HEAD = 'head999';

/** Seed a UserCoverage with fresh records for the map nodes. */
function seed(): UserCoverage {
  return {
    user: 'u',
    updatedAt: '',
    components: { a: emptyComponentCoverage(), b: emptyComponentCoverage() },
  };
}

function touch(ts: string, ids: string[]): EvidenceEntry {
  return { ts, user: 'u', type: 'touch', files: ['x.ts'], componentIds: ids };
}
function socratic(ts: string, id: string, score: number): EvidenceEntry {
  return {
    ts,
    user: 'u',
    type: 'socratic_result',
    componentId: id,
    dims: { structure: score, concepts: score, rationale: score },
  };
}
function quiz(ts: string, id: string, dim: 'structure' | 'concepts' | 'rationale', score: number): EvidenceEntry {
  return { ts, user: 'u', type: 'quiz_result', componentId: id, dim, score };
}
/** Socratic pass carrying its own recorded-at sha (the anchor for validation). */
function socraticSha(ts: string, id: string, score: number, sha: string): EvidenceEntry {
  return {
    ts,
    user: 'u',
    type: 'socratic_result',
    componentId: id,
    dims: { structure: score, concepts: score, rationale: score },
    sha,
  };
}

describe('emptyComponentCoverage', () => {
  it('is fog with zeroed dims, no sha, full loyalty', () => {
    expect(emptyComponentCoverage()).toEqual({
      state: 'fog',
      dims: { structure: 0, concepts: 0, rationale: 0 },
      lastValidatedSha: null,
      loyalty: 1,
    });
  });
});

describe('applyEvidence — passive signals', () => {
  it('takes fog → explored on a touch and grants a small structure credit', () => {
    const next = applyEvidence(seed(), touch('t1', ['a']), config);
    expect(next.components.a?.state).toBe('explored');
    expect(next.components.a?.dims.structure).toBeGreaterThan(0);
    // Concepts/rationale untouched by a passive touch.
    expect(next.components.a?.dims.concepts).toBe(0);
  });

  it('never lets passive touches push structure past passiveStructureCap', () => {
    let cov = seed();
    for (let i = 0; i < 20; i++) cov = applyEvidence(cov, touch(`t${i}`, ['a']), config);
    expect(cov.components.a?.dims.structure).toBeLessThanOrEqual(config.thresholds.passiveStructureCap);
    expect(cov.components.a?.dims.structure).toBeCloseTo(config.thresholds.passiveStructureCap);
    // Passive alone never conquers.
    expect(cov.components.a?.state).toBe('explored');
  });

  it('caps paper_read credit at paperReadCap across all three dims', () => {
    let cov = seed();
    const read: EvidenceEntry = { ts: 'r1', user: 'u', type: 'paper_read', componentId: 'a' };
    for (let i = 0; i < 20; i++) cov = applyEvidence(cov, { ...read, ts: `r${i}` }, config);
    const d = cov.components.a!.dims;
    expect(d.structure).toBeCloseTo(config.thresholds.paperReadCap);
    expect(d.concepts).toBeCloseTo(config.thresholds.paperReadCap);
    expect(d.rationale).toBeCloseTo(config.thresholds.paperReadCap);
    expect(cov.components.a?.state).toBe('explored');
  });
});

describe('applyEvidence — diff_review and intervention are non-modeling', () => {
  it('diff_review does not change any coverage', () => {
    const before = seed();
    const review: EvidenceEntry = { ts: 'd1', user: 'u', type: 'diff_review', file: 'x.ts', proposeToExecuteMs: 1200 };
    const after = applyEvidence(before, review, config);
    expect(after.components).toEqual(before.components);
  });
  it('intervention does not change any coverage', () => {
    const before = seed();
    const iv: EvidenceEntry = {
      ts: 'i1', user: 'u', type: 'intervention', componentId: 'a',
      timing: 'inflow', modality: 'quiz', outcome: 'shown',
    };
    const after = applyEvidence(before, iv, config);
    expect(after.components).toEqual(before.components);
  });
});

describe('applyEvidence — active validation conquers', () => {
  it('two solid socratic sessions conquer a component (α=0.5 cadence)', () => {
    const av: Record<string, number> = {};
    let cov = seed();
    // Session 1: emaUpdate(0, 1, 0.5) = 0.5 on every dim. Mean 0.5 < 0.6 bar,
    // one validation → explored, but the map visibly moves (0 → 0.5).
    cov = applyEvidence(cov, socratic('s1', 'a', 1), config, { headSha: HEAD, activeValidations: av });
    expect(cov.components.a?.dims).toEqual({ structure: 0.5, concepts: 0.5, rationale: 0.5 });
    expect(cov.components.a?.state).toBe('explored');
    // Session 2: emaUpdate(0.5, 1, 0.5) = 0.75 on every dim. Mean 0.75 >= 0.6 with
    // 2 validations → validated (conquest), sha stamped, loyalty fresh.
    cov = applyEvidence(cov, socratic('s2', 'a', 1), config, { headSha: HEAD, activeValidations: av });
    expect(cov.components.a?.dims).toEqual({ structure: 0.75, concepts: 0.75, rationale: 0.75 });
    expect(av.a).toBe(2);
    expect(cov.components.a?.state).toBe('validated');
    expect(cov.components.a?.lastValidatedSha).toBe(HEAD);
    expect(cov.components.a?.loyalty).toBe(1);
  });

  it('still requires >= 2 active validations: one perfect session stays explored', () => {
    const av: Record<string, number> = {};
    let cov = seed();
    // Even a perfect single session (dims 0.5) is only ONE validation → explored.
    cov = applyEvidence(cov, socratic('s1', 'a', 1), config, { headSha: HEAD, activeValidations: av });
    expect(av.a).toBe(1);
    expect(cov.components.a?.state).toBe('explored');
    expect(cov.components.a?.lastValidatedSha).toBeNull();
  });

  it('a single dim quizzed twice does not validate (weighted mean too low)', () => {
    const av: Record<string, number> = {};
    let cov = seed();
    cov = applyEvidence(cov, quiz('q1', 'a', 'structure', 1), config, { headSha: HEAD, activeValidations: av });
    cov = applyEvidence(cov, quiz('q2', 'a', 'structure', 1), config, { headSha: HEAD, activeValidations: av });
    expect(av.a).toBe(2); // active validations counted
    expect(cov.components.a?.state).toBe('explored');
    expect(cov.components.a?.lastValidatedSha).toBeNull();
  });

  it('is pure: does not mutate the input coverage', () => {
    const before = seed();
    const snapshot = JSON.parse(JSON.stringify(before));
    applyEvidence(before, socratic('s1', 'a', 1), config, { headSha: HEAD, activeValidations: {} });
    expect(before).toEqual(snapshot);
  });
});

describe('recomputeDrift', () => {
  it('leaves loyalty at 1 and nothing stale with empty churn/sizes', () => {
    const validated = materializeCoverage(
      [socratic('s1', 'a', 1), socratic('s2', 'a', 1), socratic('s3', 'a', 1)],
      { map, config, user: 'u', headSha: HEAD, now: 'T' },
    );
    expect(validated.components.a?.state).toBe('validated');
    const drifted = recomputeDrift(validated, { churn: {}, sizes: {}, config });
    expect(drifted.components.a?.loyalty).toBe(1);
    expect(drifted.components.a?.state).toBe('validated');
  });

  it('flips a validated component to stale under high churn/size', () => {
    const validated = materializeCoverage(
      [socratic('s1', 'a', 1), socratic('s2', 'a', 1), socratic('s3', 'a', 1)],
      { map, config, user: 'u', headSha: HEAD, now: 'T' },
    );
    const drifted = recomputeDrift(validated, { churn: { a: 200 }, sizes: { a: 100 }, config });
    expect(drifted.components.a?.loyalty).toBe(0);
    expect(drifted.components.a?.state).toBe('stale');
  });

  it('never touches components that were never validated', () => {
    const cov = applyEvidence(seed(), touch('t1', ['a']), config);
    const drifted = recomputeDrift(cov, { churn: { a: 999 }, sizes: { a: 1 }, config });
    expect(drifted.components.a?.loyalty).toBe(1);
    expect(drifted.components.a?.state).toBe('explored');
  });
});

describe('materializeCoverage', () => {
  it('seeds a record for every map node', () => {
    const cov = materializeCoverage([], { map, config, user: 'u', headSha: HEAD, now: 'T' });
    expect(Object.keys(cov.components).sort()).toEqual(['a', 'b']);
    expect(cov.components.a?.state).toBe('fog');
    expect(cov.updatedAt).toBe('T');
    expect(cov.user).toBe('u');
  });

  it('folds evidence: touch explores, active validation conquers with sha', () => {
    const cov = materializeCoverage(
      [touch('t1', ['b']), socratic('s1', 'a', 1), socratic('s2', 'a', 1), socratic('s3', 'a', 1)],
      { map, config, user: 'u', headSha: HEAD, now: 'T' },
    );
    expect(cov.components.b?.state).toBe('explored');
    expect(cov.components.a?.state).toBe('validated');
    expect(cov.components.a?.lastValidatedSha).toBe(HEAD);
  });

  it('is deterministic: same evidence + opts → identical UserCoverage', () => {
    const evidence: EvidenceEntry[] = [
      touch('t1', ['a']),
      socratic('s2', 'a', 1),
      quiz('q3', 'b', 'concepts', 0.9),
    ];
    const opts = { map, config, user: 'u', headSha: HEAD, now: 'T' as const };
    const one = materializeCoverage(evidence, opts);
    const two = materializeCoverage(evidence, opts);
    expect(one).toEqual(two);
  });

  it('anchors lastValidatedSha to the validating evidence sha, not ctx.headSha', () => {
    // Evidence recorded at sha 'AAA', but the current HEAD has moved to 'ZZZ'.
    // The validation must anchor to where it was recorded ('AAA'), NOT HEAD.
    const cov = materializeCoverage(
      [
        socraticSha('s1', 'a', 1, 'AAA'),
        socraticSha('s2', 'a', 1, 'AAA'),
        socraticSha('s3', 'a', 1, 'AAA'),
      ],
      { map, config, user: 'u', headSha: 'ZZZ', now: 'T' },
    );
    expect(cov.components.a?.state).toBe('validated');
    expect(cov.components.a?.lastValidatedSha).toBe('AAA');
    expect(cov.components.a?.lastValidatedSha).not.toBe('ZZZ');
  });

  it('staleness PERSISTS: drift stays stale across repeated re-materializations', () => {
    const evidence: EvidenceEntry[] = [
      socraticSha('s1', 'a', 1, 'AAA'),
      socraticSha('s2', 'a', 1, 'AAA'),
      socraticSha('s3', 'a', 1, 'AAA'),
    ];

    // 1) Validated at the recorded sha 'AAA', no churn yet.
    const v = materializeCoverage(evidence, { map, config, user: 'u', headSha: 'AAA', now: 'T' });
    expect(v.components.a?.state).toBe('validated');
    expect(v.components.a?.lastValidatedSha).toBe('AAA');

    // 2) Code drifted: churn measured from 'AAA' exceeds size → stale. HEAD is now
    //    the post-drift 'ZZZ', but the anchor must stay 'AAA' (never become HEAD).
    const opts = {
      map,
      config,
      user: 'u',
      headSha: 'ZZZ',
      churn: { a: 200 },
      sizes: { a: 100 },
      now: 'T',
    } as const;
    const drift1 = materializeCoverage(evidence, opts);
    expect(drift1.components.a?.state).toBe('stale');
    expect(drift1.components.a?.lastValidatedSha).toBe('AAA');

    // 3) A THIRD identical recompute with NO new evidence must STILL be stale —
    //    the anchor never self-heals forward to HEAD. This is the regression the
    //    fix guards: previously lastValidatedSha drifted to HEAD → churn 0 → heal.
    const drift2 = materializeCoverage(evidence, opts);
    expect(drift2.components.a?.state).toBe('stale');
    expect(drift2.components.a?.lastValidatedSha).toBe('AAA');
    expect(drift2).toEqual(drift1); // deterministic + stable
  });

  it('orders evidence by ts regardless of input order', () => {
    const inOrder: EvidenceEntry[] = [socratic('2026-01-01T00:00:01Z', 'a', 1), socratic('2026-01-01T00:00:02Z', 'a', 1), socratic('2026-01-01T00:00:03Z', 'a', 1)];
    const shuffled: EvidenceEntry[] = [inOrder[2]!, inOrder[0]!, inOrder[1]!];
    const a = materializeCoverage(inOrder, { map, config, user: 'u', headSha: HEAD, now: 'T' });
    const b = materializeCoverage(shuffled, { map, config, user: 'u', headSha: HEAD, now: 'T' });
    expect(a).toEqual(b);
  });
});
