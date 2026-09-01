import { describe, it, expect } from 'vitest';
import {
  TelemetryRowSchema,
  overrideDirection,
  flattenLeaves,
  configChangeRows,
  explainConfig,
  unsetPath,
  resolveConfig,
} from '../index.js';

describe('overrideDirection — the operational definition of loosening', () => {
  it('classifies the gate knobs', () => {
    expect(overrideDirection('gate.enabled', true, false)).toBe('loosen');
    expect(overrideDirection('gate.enabled', false, true)).toBe('tighten');
    expect(overrideDirection('gate.enforcement', 'hard', 'soft')).toBe('loosen');
    expect(overrideDirection('gate.enforcement', 'advisory', 'hard')).toBe('tighten');
    expect(overrideDirection('gate.enforcement', 'soft', 'soft')).toBe('neutral');
    expect(overrideDirection('gate.assessment', 'sync', 'async')).toBe('neutral');
  });
  it('knows which way each number runs', () => {
    expect(overrideDirection('budgets.maxPerSession', 3, 1)).toBe('loosen');
    expect(overrideDirection('budgets.cooldownMinutes', 10, 30)).toBe('loosen');
    expect(overrideDirection('unlock.passBar', 0.6, 0.8)).toBe('tighten');
    expect(overrideDirection('unlock.checksRequired', 1, 2)).toBe('tighten');
    expect(overrideDirection('drift.foreignRatio', 0.25, 0.5)).toBe('loosen');
    expect(overrideDirection('thresholds.validateDim', 0.7, 0.5)).toBe('loosen');
  });
  it('treats an exempt list growing as loosening, and unknown paths as unclassified', () => {
    expect(overrideDirection('exempt.paths', ['a'], ['a', 'b'])).toBe('loosen');
    expect(overrideDirection('drift.trigger', 'any-foreign-commit', 'ratio')).toBe('loosen');
    expect(overrideDirection('models.provider', 'anthropic', 'openai')).toBe('neutral');
    expect(overrideDirection('nope.what', 1, 2)).toBeNull();
    expect(overrideDirection('gate.enforcement', 'bogus', 'soft')).toBeNull();
  });
});

describe('configChangeRows — one row per changed leaf, with the team value alongside', () => {
  const before = resolveConfig({ user: 'u' }, { gate: { enforcement: 'hard' } }).config;
  const after = resolveConfig({ user: 'u', gate: { enforcement: 'soft' }, budgets: { maxPerSession: 1 } }, { gate: { enforcement: 'hard' } }).config;
  const policyLeaves = flattenLeaves(before);
  const rows = configChangeRows(before, after, policyLeaves, new Set(['gate.enforcement']), {
    ts: 't', user: 'u', sessionId: 's', source: 'web', reset: false,
  });

  it('emits exactly the changed leaves', () => {
    expect(rows.map((r) => r.path).sort()).toEqual(['budgets.maxPerSession', 'gate.enforcement']);
  });
  it('records the policy value only where the policy speaks', () => {
    const enf = rows.find((r) => r.path === 'gate.enforcement')!;
    expect(enf).toMatchObject({ from: 'hard', to: 'soft', policyValue: 'hard', direction: 'loosen' });
    const bud = rows.find((r) => r.path === 'budgets.maxPerSession')!;
    expect(bud.policyValue).toBeNull();
    expect(bud.direction).toBe('loosen');
  });
  it('rows validate against the shipped schema', () => {
    for (const r of rows) expect(TelemetryRowSchema.safeParse(r).success).toBe(true);
  });
  it('the schema refuses a row that names a collaborator', () => {
    const r = TelemetryRowSchema.safeParse({
      v: 1, type: 'relock', ts: 't', user: 'u', sessionId: null, component: 'c', cause: 'foreign',
      foreignAuthors: ['bob@example.com'],
    });
    expect(r.success).toBe(false);
  });
});

describe('explainConfig — where each effective leaf came from', () => {
  const policy = { gate: { enforcement: 'hard', assessment: 'async' }, budgets: { maxPerSession: 5 } };

  it('default / policy / user, leaf by leaf', () => {
    const ex = explainConfig({ user: 'u', gate: { enforcement: 'soft' } }, policy);
    expect(ex['gate.enforcement']).toMatchObject({ value: 'soft', source: 'user', policyValue: 'hard' });
    expect(ex['gate.assessment']).toMatchObject({ value: 'async', source: 'policy', policyValue: 'async' });
    expect(ex['gate.modality']).toMatchObject({ source: 'default' });
    expect(ex['gate.modality']!.policyValue).toBeUndefined();
    expect(ex['budgets.maxPerSession']).toMatchObject({ value: 5, source: 'policy' });
  });
  it('a user value EQUAL to the team value is still "user" — it is pinned', () => {
    const ex = explainConfig({ user: 'u', gate: { enforcement: 'hard' } }, policy);
    expect(ex['gate.enforcement']!.source).toBe('user');
  });
  it('a broken policy contributes nothing', () => {
    const ex = explainConfig({ user: 'u' }, { gate: { enforcement: 'bogus' } });
    expect(ex['gate.enforcement']).toMatchObject({ source: 'default' });
    expect(ex['gate.enforcement']!.policyValue).toBeUndefined();
  });
  it('legacy user keys are read through the migration', () => {
    const ex = explainConfig({ user: 'u', condition: { modality: 'socratic' } }, undefined);
    expect(ex['gate.modality']).toMatchObject({ value: 'socratic', source: 'user' });
  });
});

describe('unsetPath — keeps the sparse file sparse', () => {
  it('removes the leaf and prunes empty parents', () => {
    expect(unsetPath({ user: 'u', gate: { enforcement: 'soft' } }, 'gate.enforcement')).toEqual({ user: 'u' });
    expect(unsetPath({ user: 'u', gate: { enforcement: 'soft', modality: 'quiz' } }, 'gate.enforcement'))
      .toEqual({ user: 'u', gate: { modality: 'quiz' } });
  });
  it('is a no-op for absent paths and never removes the identity', () => {
    const raw = { user: 'u', gate: { modality: 'quiz' } };
    expect(unsetPath(raw, 'gate.enforcement')).toBe(raw);
    expect(unsetPath(raw, 'budgets.maxPerSession')).toBe(raw);
    expect(unsetPath(raw, 'user')).toBe(raw);
  });
});
