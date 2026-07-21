import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  PaperFrontmatterSchema,
  MapJsonSchema,
  UserCoverageSchema,
  EvidenceEntrySchema,
  QuestSchema,
  ScaleConfigSchema,
  resolveInterventionModel,
} from '../index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', '..', 'fixtures');

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(join(fixtures, name), 'utf8'));
}

describe('schema fixtures', () => {
  it('paper.frontmatter.json parses', () => {
    const parsed = PaperFrontmatterSchema.parse(readJson('paper.frontmatter.json'));
    expect(parsed.id).toBe('session-management');
    expect(parsed.concepts.length).toBe(2);
  });

  it('map.json parses', () => {
    const parsed = MapJsonSchema.parse(readJson('map.json'));
    expect(parsed.version).toBe(1);
    expect(parsed.nodes.length).toBe(2);
  });

  it('user-coverage.json parses', () => {
    const parsed = UserCoverageSchema.parse(readJson('user-coverage.json'));
    expect(parsed.components['session-management']?.state).toBe('validated');
  });

  it('quests.json parses (array of quests)', () => {
    const arr = readJson('quests.json') as unknown[];
    const parsed = arr.map((q) => QuestSchema.parse(q));
    expect(parsed[0]?.origin).toBe('session');
    expect(parsed[0]?.items.length).toBe(2);
  });

  it('config.json parses', () => {
    const parsed = ScaleConfigSchema.parse(readJson('config.json'));
    expect(parsed.condition.timing).toBe('inflow');
    expect(parsed.budgets.maxPerCommit).toBe(1);
  });

  it('config schema applies defaults for a minimal object', () => {
    const parsed = ScaleConfigSchema.parse({ user: 'x' });
    expect(parsed.condition.modality).toBe('quiz');
    expect(parsed.inflow.triggers).toEqual(['pre-commit']);
    expect(parsed.thresholds.validateDim).toBe(0.6);
  });

  // The intervention tier is one token across providers, and older configs on
  // disk must migrate rather than fail — a config that fails to parse is
  // silently replaced by defaults everywhere, discarding the junior's condition
  // assignment mid-study.
  it('intervention tier resolves per provider', () => {
    const model = (provider: string, intervention: string): string =>
      resolveInterventionModel(
        ScaleConfigSchema.parse({ user: 'x', models: { provider, intervention } }).models,
      );
    expect(model('anthropic', 'sonnet')).toBe('claude-sonnet-5');
    expect(model('anthropic', 'opus')).toBe('claude-opus-4-8');
    expect(model('openai', 'sonnet')).toBe('gpt-5.6-terra');
    expect(model('openai', 'opus')).toBe('gpt-5.6-sol');
  });

  it('an explicit openaiModel overrides the tier mapping', () => {
    const parsed = ScaleConfigSchema.parse({
      user: 'x',
      models: { provider: 'openai', intervention: 'opus', openaiModel: 'gpt-custom' },
    });
    expect(resolveInterventionModel(parsed.models)).toBe('gpt-custom');
  });

  it('migrates a legacy config instead of discarding it', () => {
    const parsed = ScaleConfigSchema.parse({
      user: 'x',
      budgets: { maxPerSession: 7 },
      // Both fields as an older SCALE wrote them.
      models: { intervention: 'haiku', provider: 'openai', openaiModel: 'gpt-4o-mini' },
    });
    expect(parsed.models.intervention).toBe('sonnet');
    // The old persisted DEFAULT must not survive as a pinned override.
    expect(parsed.models.openaiModel).toBeUndefined();
    expect(resolveInterventionModel(parsed.models)).toBe('gpt-5.6-terra');
    // Everything else survives — this is a migration, not a reset.
    expect(parsed.budgets.maxPerSession).toBe(7);
  });

  it('rejects a negative interruption budget', () => {
    expect(() =>
      ScaleConfigSchema.parse({ user: 'x', budgets: { maxPerSession: -1 } }),
    ).toThrow();
    // 0 is meaningful ("never interrupt on commit"), so it must still parse.
    expect(
      ScaleConfigSchema.parse({ user: 'x', budgets: { maxPerCommit: 0 } }).budgets.maxPerCommit,
    ).toBe(0);
  });

  it('evidence.jsonl parses line-by-line, one per type', () => {
    const raw = readFileSync(join(fixtures, 'evidence.jsonl'), 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    const parsed = lines.map((l) => EvidenceEntrySchema.parse(JSON.parse(l)));
    expect(parsed.length).toBe(4);
    expect(parsed.map((p) => p.type)).toEqual(['prompt', 'touch', 'quiz_result', 'intervention']);
  });

  it('quiz_result parses with and without origin', () => {
    const base = {
      type: 'quiz_result',
      ts: '2026-07-14T00:00:00Z',
      user: 'junior',
      componentId: 'session-management',
      dim: 'rationale',
      score: 0.8,
    };
    // Backward compat: old evidence without origin still parses.
    const without = EvidenceEntrySchema.parse(base);
    expect(without.type).toBe('quiz_result');
    expect((without as { origin?: string }).origin).toBeUndefined();
    // Voluntary conquest (PLAN §6.3) records origin.
    const withOrigin = EvidenceEntrySchema.parse({ ...base, origin: 'voluntary' });
    expect((withOrigin as { origin?: string }).origin).toBe('voluntary');
    // Enum is enforced.
    expect(() => EvidenceEntrySchema.parse({ ...base, origin: 'nope' })).toThrow();
  });

  it('socratic_result parses with origin', () => {
    const parsed = EvidenceEntrySchema.parse({
      type: 'socratic_result',
      ts: '2026-07-14T00:00:00Z',
      user: 'junior',
      componentId: 'session-management',
      dims: { structure: 0.65, concepts: 0.6, rationale: 0.4 },
      origin: 'session',
    });
    expect((parsed as { origin?: string }).origin).toBe('session');
  });

  it('discriminated union rejects an unknown type', () => {
    expect(() => EvidenceEntrySchema.parse({ type: 'nope', ts: 'x', user: 'y' })).toThrow();
  });
});
