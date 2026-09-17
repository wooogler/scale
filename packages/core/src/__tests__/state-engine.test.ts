import { describe, it, expect } from 'vitest';
import {
  applyEvidence,
  recomputeDrift,
  causeOfDrift,
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
      driftCause: null,
      driftAuthors: [],
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

  it('caps doc_read credit at docReadCap across all three dims', () => {
    let cov = seed();
    const read: EvidenceEntry = { ts: 'r1', user: 'u', type: 'doc_read', componentId: 'a' };
    for (let i = 0; i < 20; i++) cov = applyEvidence(cov, { ...read, ts: `r${i}` }, config);
    const d = cov.components.a!.dims;
    expect(d.structure).toBeCloseTo(config.thresholds.docReadCap);
    expect(d.concepts).toBeCloseTo(config.thresholds.docReadCap);
    expect(d.rationale).toBeCloseTo(config.thresholds.docReadCap);
    expect(cov.components.a?.state).toBe('explored');
  });

  it('credits a legacy paper_read row exactly as a doc_read', () => {
    // evidence.jsonl is append-only and coverage is re-materialized by folding
    // it from the beginning, so every row written before the rename is replayed
    // on every run. Treating the old literal as unknown would silently erase the
    // reading credit of every user who has one.
    const fold = (type: 'doc_read' | 'paper_read'): number => {
      let cov = seed();
      for (let i = 0; i < 3; i++) {
        cov = applyEvidence(cov, { ts: `r${i}`, user: 'u', type, componentId: 'a' }, config);
      }
      return cov.components.a!.dims.concepts;
    };
    expect(fold('paper_read')).toBe(fold('doc_read'));
    expect(fold('paper_read')).toBeGreaterThan(0);
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
    const drifted = recomputeDrift(validated, { churn: { a: { foreign: 200, self: 0 } }, sizes: { a: 100 }, config });
    expect(drifted.components.a?.loyalty).toBe(0);
    expect(drifted.components.a?.state).toBe('stale');
  });

  it('never touches components that were never validated', () => {
    const cov = applyEvidence(seed(), touch('t1', ['a']), config);
    const drifted = recomputeDrift(cov, { churn: { a: { foreign: 999, self: 0 } }, sizes: { a: 1 }, config });
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
      churn: { a: { foreign: 200, self: 0 } },
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

describe('causeOfDrift — the single drift rule (PLAN-GATE S2)', () => {
  const cfg = (rebellion: Record<string, unknown> = {}): ScaleConfig =>
    ScaleConfigSchema.parse({ user: 'u', rebellion });

  it('foreign churn fires at the (lower) foreign bar', () => {
    // 30/100 = 0.30 ≥ foreignRatio 0.25
    expect(causeOfDrift({ foreign: 30, self: 0 }, 100, cfg())).toBe('foreign');
    expect(causeOfDrift({ foreign: 20, self: 0 }, 100, cfg())).toBeNull();
  });

  it('the SAME churn from the user themselves does not fire', () => {
    // This asymmetry is the design: the edit gate cleared them before they wrote
    // it, so their own work is not evidence their understanding lapsed.
    expect(causeOfDrift({ foreign: 0, self: 30 }, 100, cfg())).toBeNull();
    expect(causeOfDrift({ foreign: 0, self: 85 }, 100, cfg())).toBe('self');
  });

  it('foreign wins when both bars are crossed — it is the more informative cause', () => {
    expect(causeOfDrift({ foreign: 50, self: 90 }, 100, cfg())).toBe('foreign');
  });

  it('an unmeasurable foreign change (binary-classified file) fires on its own', () => {
    expect(
      causeOfDrift({ foreign: 0, self: 0, unmeasurableForeign: true }, 100, cfg()),
    ).toBe('foreign');
    // A binary change the USER made is not a rebellion.
    expect(causeOfDrift({ foreign: 0, self: 0 }, 100, cfg())).toBeNull();
  });

  it('unknown size treats any churn as total, erring toward re-checking', () => {
    expect(causeOfDrift({ foreign: 1, self: 0 }, 0, cfg())).toBe('foreign');
    expect(causeOfDrift({ foreign: 0, self: 0 }, 0, cfg())).toBeNull();
  });

  it('any-foreign-commit mode fires on a single commit, whatever its size', () => {
    const c = cfg({ trigger: 'any-foreign-commit' });
    expect(causeOfDrift({ foreign: 1, self: 0, foreignCommits: 1 }, 100000, c)).toBe('foreign');
    expect(causeOfDrift({ foreign: 0, self: 9999, foreignCommits: 0 }, 100, c)).toBeNull();
  });

  it('thresholds are policy-settable', () => {
    const strict = cfg({ foreignRatio: 0.01 });
    expect(causeOfDrift({ foreign: 2, self: 0 }, 100, strict)).toBe('foreign');
    const loose = cfg({ foreignRatio: 1 });
    expect(causeOfDrift({ foreign: 99, self: 0 }, 100, loose)).toBeNull();
  });
});

describe('recomputeDrift — split churn', () => {
  const cfg = ScaleConfigSchema.parse({ user: 'u' });
  const validated = (): UserCoverage => ({
    user: 'u',
    updatedAt: '',
    components: {
      a: {
        state: 'validated',
        dims: { structure: 0.9, concepts: 0.9, rationale: 0.9 },
        lastValidatedSha: 'abc',
        loyalty: 1,
        driftCause: null,
        driftAuthors: [],
      },
    },
  });

  it('loyalty reflects TOTAL churn while the trigger reads only the split', () => {
    const d = recomputeDrift(validated(), {
      churn: { a: { foreign: 10, self: 40 } },
      sizes: { a: 100 },
      config: cfg,
    });
    // 50/100 churned → loyalty 0.5, but neither bar (foreign 0.10, self 0.40) is met.
    expect(d.components.a?.loyalty).toBeCloseTo(0.5);
    expect(d.components.a?.state).toBe('validated');
  });

  it('a component that is not validated is never re-locked by drift', () => {
    const cov = validated();
    cov.components.a!.state = 'explored';
    const d = recomputeDrift(cov, {
      churn: { a: { foreign: 999, self: 0 } },
      sizes: { a: 1 },
      config: cfg,
    });
    expect(d.components.a?.state).toBe('explored');
  });
});
