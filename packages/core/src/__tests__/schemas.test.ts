import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  DocFrontmatterSchema,
  canonicalSectionKey,
  SECTIONS,
  SECTION_HEADING,
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
  it('doc.frontmatter.json parses', () => {
    const parsed = DocFrontmatterSchema.parse(readJson('doc.frontmatter.json'));
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

  it('config.json (legacy fixture) migrates paperReadCap to docReadCap', () => {
    // An unknown key is STRIPPED at parse, not rejected, so without the mapping
    // the user's tuned cap would vanish into the default without a word.
    const parsed = ScaleConfigSchema.parse(readJson('config.json'));
    expect(parsed.thresholds.docReadCap).toBe(0.4);
    expect('paperReadCap' in parsed.thresholds).toBe(false);
  });

  it('an explicit docReadCap wins over a legacy paperReadCap', () => {
    const parsed = ScaleConfigSchema.parse({
      user: 'x',
      thresholds: { paperReadCap: 0.9, docReadCap: 0.2 },
    });
    expect(parsed.thresholds.docReadCap).toBe(0.2);
  });

  it('a legacy paperReadCap survives as the user set it, not as the default', () => {
    const parsed = ScaleConfigSchema.parse({ user: 'x', thresholds: { paperReadCap: 0.75 } });
    expect(parsed.thresholds.docReadCap).toBe(0.75);
    // The rest of thresholds still defaults — this is a migration, not a reset.
    expect(parsed.thresholds.validateDim).toBe(0.6);
  });

  it('config.json (legacy fixture) parses via migration', () => {
    // The fixture still speaks the pre-edit-gate vocabulary on purpose: real
    // deployed configs do too, and they must land as gate.* (PLAN-GATE §2.1).
    const parsed = ScaleConfigSchema.parse(readJson('config.json'));
    expect(parsed.gate.assessment).toBe('sync'); // condition.timing: inflow
    expect(parsed.gate.modality).toBe('quiz');
    expect(parsed.gate.enabled).toBe(true); // inflow.triggers had pre-commit
    expect(parsed.budgets.maxPerSession).toBe(2);
    // Dropped commit-era knobs are stripped, not fatal.
    expect('maxPerCommit' in parsed.budgets).toBe(false);
  });

  it('config schema applies defaults for a minimal object', () => {
    const parsed = ScaleConfigSchema.parse({ user: 'x' });
    expect(parsed.gate.modality).toBe('quiz');
    expect(parsed.gate.assessment).toBe('sync');
    expect(parsed.gate.enforcement).toBe('soft');
    expect(parsed.gate.enabled).toBe(true);
    expect(parsed.unlock.passBar).toBe(0.6);
    expect(parsed.unlock.checksRequired).toBe(1);
    expect(parsed.exempt.paths).toEqual([]);
    expect(parsed.thresholds.validateDim).toBe(0.6);
  });

  it('legacy condition/inflow migrate without clobbering explicit gate keys', () => {
    const parsed = ScaleConfigSchema.parse({
      user: 'x',
      condition: { timing: 'postsession', modality: 'socratic' },
      inflow: { triggers: [] },
      gate: { assessment: 'sync' }, // explicit new-style key wins
    });
    expect(parsed.gate.assessment).toBe('sync');
    expect(parsed.gate.modality).toBe('socratic');
    expect(parsed.gate.enabled).toBe(false); // pre-commit was switched off
  });

  it('legacy postsession users gain an async gate (intended behavior change)', () => {
    const parsed = ScaleConfigSchema.parse({
      user: 'x',
      condition: { timing: 'postsession', modality: 'quiz' },
    });
    expect(parsed.gate.assessment).toBe('async');
    expect(parsed.gate.enabled).toBe(true);
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

  it('quiz shape defaults to the behaviour that predates the setting', () => {
    const parsed = ScaleConfigSchema.parse({ user: 'x' });
    expect(parsed.quiz.items).toBe(2);
    expect(parsed.quiz.focus).toBe('auto');
    expect(parsed.quiz.grounding).toBe('balanced');
  });

  it('bounds quiz.items to 1..5 and rejects a non-integer', () => {
    // 0 items is not "off" — `gate.enabled` is off. A zero-item check would
    // deny the edit and then ask nothing, which is a lock with no way out.
    expect(() => ScaleConfigSchema.parse({ user: 'x', quiz: { items: 0 } })).toThrow();
    expect(() => ScaleConfigSchema.parse({ user: 'x', quiz: { items: 6 } })).toThrow();
    expect(() => ScaleConfigSchema.parse({ user: 'x', quiz: { items: 2.5 } })).toThrow();
    expect(ScaleConfigSchema.parse({ user: 'x', quiz: { items: 1 } }).quiz.items).toBe(1);
    expect(ScaleConfigSchema.parse({ user: 'x', quiz: { items: 5 } }).quiz.items).toBe(5);
  });

  it('quiz focus/grounding are closed enums', () => {
    expect(() => ScaleConfigSchema.parse({ user: 'x', quiz: { focus: 'vibes' } })).toThrow();
    expect(() => ScaleConfigSchema.parse({ user: 'x', quiz: { grounding: 'diff ' } })).toThrow();
    const parsed = ScaleConfigSchema.parse({
      user: 'x',
      quiz: { focus: 'rationale', grounding: 'diff' },
    });
    expect(parsed.quiz.focus).toBe('rationale');
    expect(parsed.quiz.grounding).toBe('diff');
    // A partial quiz block still defaults the rest.
    expect(parsed.quiz.items).toBe(2);
  });

  it('rejects a negative interruption budget', () => {
    expect(() =>
      ScaleConfigSchema.parse({ user: 'x', budgets: { maxPerSession: -1 } }),
    ).toThrow();
    // 0 is meaningful ("never deny"), so it must still parse.
    expect(
      ScaleConfigSchema.parse({ user: 'x', budgets: { maxPerSession: 0 } }).budgets.maxPerSession,
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

  it('doc_read parses, and so does the legacy paper_read literal', () => {
    // Append-only log: the old rows are still there and must keep validating.
    const base = { ts: '2026-07-14T00:00:00Z', user: 'junior', componentId: 'session-management' };
    expect(EvidenceEntrySchema.parse({ ...base, type: 'doc_read' }).type).toBe('doc_read');
    expect(EvidenceEntrySchema.parse({ ...base, type: 'paper_read' }).type).toBe('paper_read');
  });

  it('discriminated union rejects an unknown type', () => {
    expect(() => EvidenceEntrySchema.parse({ type: 'nope', ts: 'x', user: 'y' })).toThrow();
  });
});

/**
 * The section alias table. Docs were first written with the section names of an
 * academic paper; the headings are now developer-native and the old spellings
 * are aliases, because every `.scale/` tree built before the change is still on
 * disk and is never rewritten.
 */
describe('canonicalSectionKey', () => {
  it('resolves every canonical heading and every legacy alias', () => {
    for (const s of SECTIONS) {
      expect(canonicalSectionKey(s.heading)).toBe(s.key);
      for (const alias of s.aliases) expect(canonicalSectionKey(alias)).toBe(s.key);
    }
  });

  it('pins the six pairs the rest of the codebase keys off', () => {
    expect(canonicalSectionKey('Abstract')).toBe('summary');
    expect(canonicalSectionKey('Introduction')).toBe('what-it-does');
    expect(canonicalSectionKey('Related Work')).toBe('related-components');
    expect(canonicalSectionKey('Description')).toBe('how-it-works');
    expect(canonicalSectionKey('Rationale')).toBe('design-decisions');
    expect(canonicalSectionKey('Conclusion')).toBe('where-it-sits');
  });

  it('ignores case, surrounding space and trailing punctuation', () => {
    expect(canonicalSectionKey('  how it WORKS  ')).toBe('how-it-works');
    expect(canonicalSectionKey('Rationale:')).toBe('design-decisions');
    expect(canonicalSectionKey('Design decisions.')).toBe('design-decisions');
    expect(canonicalSectionKey('Related  Work')).toBe('related-components');
  });

  it('drops a trailing parenthetical gloss, and trailing punctuation with it', () => {
    // Writers gloss a heading in place. The gloss is an aside to the reader,
    // not a different section, and reading it as one would cost the doc a
    // section it actually has.
    expect(canonicalSectionKey('Related Work (siblings)')).toBe('related-components');
    expect(canonicalSectionKey('Summary:')).toBe('summary');
    expect(canonicalSectionKey('Related components (and why)')).toBe('related-components');
    // Punctuation OUTSIDE the parenthetical is why the two strips alternate.
    expect(canonicalSectionKey('Summary (tl;dr):')).toBe('summary');
    // …and a heading that is genuinely something else stays unrecognized.
    expect(canonicalSectionKey('Open questions (for review)')).toBeNull();
  });

  it('matches the FULL heading, never its first word', () => {
    // The keying this replaced took the first word, which was fine while
    // headings were single words and wrong the moment they became phrases:
    // `Where it sits` and `Where the bodies are buried` share their first word,
    // as do `What it does` and `What breaks`.
    expect(canonicalSectionKey('Where the bodies are buried')).toBeNull();
    expect(canonicalSectionKey('What breaks')).toBeNull();
    expect(canonicalSectionKey('Rationale and trade-offs')).toBeNull();
    expect(canonicalSectionKey('Notes')).toBeNull();
    expect(canonicalSectionKey('')).toBeNull();
  });

  it('SECTION_HEADING names every key, in SECTIONS order', () => {
    expect(Object.keys(SECTION_HEADING)).toEqual(SECTIONS.map((s) => s.key));
    expect(SECTION_HEADING['related-components']).toBe('Related components');
  });
});
