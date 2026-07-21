import { describe, it, expect } from 'vitest';
import {
  gateDecision,
  gateDenyReason,
  ScaleConfigSchema,
  emptyComponentCoverage,
  type GateInput,
  type GateSession,
  type ScaleConfig,
  type UserCoverage,
  type ComponentCoverage,
} from '../index.js';

const NOW = '2026-07-15T12:00:00.000Z';

/** Default in-flow/quiz config with the shipped budget/threshold defaults. */
function cfg(overrides: Record<string, unknown> = {}): ScaleConfig {
  return ScaleConfigSchema.parse({ user: 'u', ...overrides });
}

function freshSession(over: Partial<GateSession> = {}): GateSession {
  return {
    interventionsThisSession: 0,
    lastInterventionAt: null,
    pendingComponent: null,
    ...over,
  };
}

/** Coverage with the given per-component records; unnamed → not present (fog). */
function coverageOf(components: Record<string, ComponentCoverage>): UserCoverage {
  return { user: 'u', updatedAt: '', components };
}

function comp(over: Partial<ComponentCoverage>): ComponentCoverage {
  return { ...emptyComponentCoverage(), ...over };
}

/** A component explored with a given weighted mean (all dims equal). */
function explored(mean: number): ComponentCoverage {
  return comp({ state: 'explored', dims: { structure: mean, concepts: mean, rationale: mean } });
}

function validated(): ComponentCoverage {
  return comp({
    state: 'validated',
    dims: { structure: 0.8, concepts: 0.8, rationale: 0.8 },
    lastValidatedSha: 'abc',
  });
}

function stale(): ComponentCoverage {
  return comp({ state: 'stale', dims: { structure: 0.7, concepts: 0.7, rationale: 0.7 }, loyalty: 0.2, lastValidatedSha: 'abc' });
}

/** Assemble a GateInput with sensible non-triggering-diff defaults overridden. */
function input(over: Partial<GateInput> = {}): GateInput {
  return {
    touched: ['a'],
    coverage: coverageOf({ a: comp({ state: 'fog' }) }),
    config: cfg(),
    session: freshSession(),
    changedLines: 100, // well above minChangedLines default (20)
    recentlyAddressed: [],
    now: NOW,
    ...over,
  };
}

describe('gateDecision — allow paths (first-match-wins order)', () => {
  it('non-inflow (post-session) condition never gates', () => {
    const d = gateDecision(
      input({ config: cfg({ condition: { timing: 'postsession', modality: 'quiz' } }) }),
    );
    expect(d.action).toBe('allow');
    expect(d.reason).toMatch(/post-session/);
  });

  it('allows when pre-commit is not among the enabled triggers', () => {
    const d = gateDecision(
      input({ config: cfg({ inflow: { triggers: ['post-task'] } }) }),
    );
    expect(d.action).toBe('allow');
    expect(d.reason).toMatch(/trigger not enabled/);
  });

  it('allows when no touched component is fog/stale/low-coverage', () => {
    const d = gateDecision(
      input({ touched: ['a'], coverage: coverageOf({ a: validated() }) }),
    );
    expect(d.action).toBe('allow');
    expect(d.reason).toMatch(/no fog\/stale\/low-coverage/);
  });

  it('allows an explored component already at/above the validate bar', () => {
    const d = gateDecision(
      input({ touched: ['a'], coverage: coverageOf({ a: explored(0.6) }) }),
    );
    expect(d.action).toBe('allow');
  });

  it('allows (retry passes) when a candidate is recentlyAddressed', () => {
    const d = gateDecision(input({ touched: ['a'], recentlyAddressed: ['a'] }));
    expect(d.action).toBe('allow');
    expect(d.reason).toMatch(/recently addressed/);
  });

  it('allows (defer=drop) — a deferred component is in recentlyAddressed', () => {
    // Same mechanic as retry: the deferred marker put `a` in recentlyAddressed.
    const d = gateDecision(
      input({ touched: ['a', 'b'], coverage: coverageOf({ a: comp({ state: 'fog' }), b: comp({ state: 'fog' }) }), recentlyAddressed: ['a', 'b'] }),
    );
    expect(d.action).toBe('allow');
    expect(d.reason).toMatch(/recently addressed/);
  });

  it('allows on a trivial diff below minChangedLines', () => {
    const d = gateDecision(input({ changedLines: 5 }));
    expect(d.action).toBe('allow');
    expect(d.reason).toMatch(/trivial diff/);
  });

  it('allows when the per-session budget is already spent', () => {
    const d = gateDecision(
      input({ session: freshSession({ interventionsThisSession: 2 }) }),
    );
    expect(d.action).toBe('allow');
    expect(d.reason).toMatch(/budget spent/);
  });

  it('allows within the cooldown window', () => {
    const d = gateDecision(
      input({
        session: freshSession({ lastInterventionAt: '2026-07-15T11:50:00.000Z' }), // 10 min < 15
      }),
    );
    expect(d.action).toBe('allow');
    expect(d.reason).toMatch(/cooldown/);
  });
});

describe('gateDecision — deny path', () => {
  it('denies on a fog component touched by a non-trivial diff with budget', () => {
    const d = gateDecision(input({ touched: ['a'], coverage: coverageOf({ a: comp({ state: 'fog' }) }) }));
    expect(d.action).toBe('deny');
    expect(d.component).toBe('a');
    expect(d.spendBudget).toBe(true);
    expect(d.reason).toMatch(/scale-tutor skill/);
    expect(d.reason).toMatch(/quiz comprehension check/); // default modality
    expect(d.reason).toMatch(/retry the commit/);
  });

  it('denies on a stale (rebellion) touched component', () => {
    const d = gateDecision(input({ touched: ['a'], coverage: coverageOf({ a: stale() }) }));
    expect(d.action).toBe('deny');
    expect(d.component).toBe('a');
  });

  it('denies on an explored-below-bar touched component', () => {
    const d = gateDecision(input({ touched: ['a'], coverage: coverageOf({ a: explored(0.4) }) }));
    expect(d.action).toBe('deny');
    expect(d.component).toBe('a');
  });

  it('uses the configured modality (socratic) in the reason', () => {
    const d = gateDecision(
      input({ config: cfg({ condition: { timing: 'inflow', modality: 'socratic' } }) }),
    );
    expect(d.action).toBe('deny');
    expect(d.reason).toMatch(/socratic comprehension check/);
  });

  it('cooldown does not block once enough time has elapsed', () => {
    const d = gateDecision(
      input({ session: freshSession({ lastInterventionAt: '2026-07-15T11:40:00.000Z' }) }), // 20 min > 15
    );
    expect(d.action).toBe('deny');
  });

  it('a touched id with no coverage record is treated as fog and denies', () => {
    const d = gateDecision(input({ touched: ['ghost'], coverage: coverageOf({}) }));
    expect(d.action).toBe('deny');
    expect(d.component).toBe('ghost');
  });
});

describe('gateDecision — candidate ranking', () => {
  it('ranks by importance × (1 − mean) when importance is provided', () => {
    const d = gateDecision(
      input({
        touched: ['low', 'high'],
        coverage: coverageOf({ low: explored(0.5), high: explored(0.5) }),
        importance: { low: 0.1, high: 0.9 },
      }),
    );
    expect(d.action).toBe('deny');
    expect(d.component).toBe('high'); // 0.9·0.5 > 0.1·0.5
  });

  it('without importance, ranks by lowest mean first', () => {
    const d = gateDecision(
      input({
        touched: ['warmer', 'colder'],
        coverage: coverageOf({ warmer: explored(0.5), colder: explored(0.1) }),
      }),
    );
    expect(d.action).toBe('deny');
    expect(d.component).toBe('colder');
  });

  it('without importance, ties broken fog > stale > explored', () => {
    const d = gateDecision(
      input({
        touched: ['e', 'f'],
        coverage: coverageOf({ e: explored(0), f: comp({ state: 'fog' }) }),
      }),
    );
    // both mean 0 → fog wins the tie
    expect(d.component).toBe('f');
  });

  it('recentlyAddressed short-circuits before ranking/budget', () => {
    // Even with a fresh fog candidate, if ANY candidate is addressed we allow.
    const d = gateDecision(
      input({
        touched: ['a', 'done'],
        coverage: coverageOf({ a: comp({ state: 'fog' }), done: comp({ state: 'fog' }) }),
        recentlyAddressed: ['done'],
      }),
    );
    expect(d.action).toBe('allow');
  });
});

describe('gateDenyReason — interaction language', () => {
  it('ko appends the Korean-delivery instruction (identifiers stay English)', () => {
    const r = gateDenyReason('a', 'quiz', 'ko');
    expect(r).toMatch(/interaction language is KOREAN/);
    expect(r).toMatch(/entirely in Korean/);
    expect(r).toMatch(/code identifiers and technical terms in English/);
    // The English agent-facing instruction is still fully present.
    expect(r).toMatch(/scale-tutor skill/);
    expect(r).toMatch(/retry the commit/);
  });

  it('en produces a pure-English reason without the Korean instruction', () => {
    expect(gateDenyReason('a', 'quiz', 'en')).not.toMatch(/KOREAN/);
  });

  it('language defaults to en (omitted arg unchanged)', () => {
    expect(gateDenyReason('a', 'quiz')).toBe(gateDenyReason('a', 'quiz', 'en'));
  });

  it('gateDecision threads config.language into the deny reason', () => {
    const d = gateDecision(input({ config: cfg({ language: 'ko' }) }));
    expect(d.action).toBe('deny');
    expect(d.reason).toMatch(/interaction language is KOREAN/);
  });
});
