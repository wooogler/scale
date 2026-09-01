import { describe, it, expect } from 'vitest';
import {
  gateEditDecision,
  gateDenyReason,
  resolveConfig,
  deepMerge,
  pathMatchesAny,
  ScaleConfigSchema,
  emptyComponentCoverage,
  type GateEditInput,
  type GateSession,
  type ScaleConfig,
  type UserCoverage,
  type ComponentCoverage,
} from '../index.js';

const NOW = '2026-09-01T12:00:00.000Z';

/** Default sync/quiz/soft config with the shipped budget/threshold defaults. */
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

/** Assemble a GateEditInput with locked-fog defaults, overridden per test. */
function input(over: Partial<GateEditInput> = {}): GateEditInput {
  return {
    touched: ['a'],
    coverage: coverageOf({ a: comp({ state: 'fog' }) }),
    config: cfg(),
    session: freshSession(),
    unlocked: [],
    sessionSkips: [],
    recentlyAddressed: [],
    now: NOW,
    ...over,
  };
}

describe('gateEditDecision — lock model', () => {
  it('denies an edit into fog territory (the base case)', () => {
    const d = gateEditDecision(input());
    expect(d.action).toBe('deny');
    expect(d.component).toBe('a');
    expect(d.spendBudget).toBe(true);
    expect(d.reason).toContain("'a'");
  });

  it('a component with no coverage record at all is locked (treated as fog)', () => {
    const d = gateEditDecision(input({ coverage: coverageOf({}) }));
    expect(d.action).toBe('deny');
  });

  it('the durable ledger unlocks: an unlocked component never gates again', () => {
    const d = gateEditDecision(input({ unlocked: ['a'] }));
    expect(d.action).toBe('allow');
    expect(d.reason).toContain('no locked territory');
  });

  it('validated coverage is grandfathered as unlocked', () => {
    const d = gateEditDecision(input({ coverage: coverageOf({ a: validated() }) }));
    expect(d.action).toBe('allow');
  });

  it('explored-but-never-checked is STILL locked — passive touches do not unlock', () => {
    // This is the load-bearing difference from the old commit gate: under the
    // lock model only a passed check (or validated grandfathering) opens
    // territory; high passive means do not.
    const d = gateEditDecision(input({ coverage: coverageOf({ a: explored(0.9) }) }));
    expect(d.action).toBe('deny');
  });

  it('a session skip clears the component for the rest of the period', () => {
    const d = gateEditDecision(input({ sessionSkips: ['a'] }));
    expect(d.action).toBe('allow');
  });

  it('recentlyAddressed clears the retry right after a recorded check', () => {
    const d = gateEditDecision(input({ recentlyAddressed: ['a'] }));
    expect(d.action).toBe('allow');
  });

  it('gate.enabled=false switches the gate off entirely', () => {
    const d = gateEditDecision(input({ config: cfg({ gate: { enabled: false } }) }));
    expect(d.action).toBe('allow');
    expect(d.reason).toContain('disabled');
  });
});

describe('gateEditDecision — the pending component stays denied', () => {
  it('a bare retry of the denied component is denied again, without budget', () => {
    // The lock-model regression the E2E caught: deny → immediate retry used to
    // walk through on the cooldown allow-path, making the lock a one-shot nudge.
    const d = gateEditDecision(
      input({
        session: freshSession({
          interventionsThisSession: 1,
          lastInterventionAt: NOW,
          pendingComponent: 'a',
        }),
      }),
    );
    expect(d.action).toBe('deny');
    expect(d.component).toBe('a');
    expect(d.spendBudget).toBeUndefined();
  });

  it('re-denies even when the session budget is exhausted', () => {
    const d = gateEditDecision(
      input({
        session: freshSession({
          interventionsThisSession: 99,
          lastInterventionAt: NOW,
          pendingComponent: 'a',
        }),
      }),
    );
    expect(d.action).toBe('deny');
  });

  it('the pending component stops gating once addressed (record/defer path)', () => {
    const d = gateEditDecision(
      input({
        recentlyAddressed: ['a'],
        session: freshSession({ pendingComponent: 'a', lastInterventionAt: NOW, interventionsThisSession: 1 }),
      }),
    );
    expect(d.action).toBe('allow');
  });

  it('a different locked component still respects the cooldown', () => {
    const d = gateEditDecision(
      input({
        touched: ['b'],
        coverage: coverageOf({}),
        session: freshSession({
          interventionsThisSession: 1,
          lastInterventionAt: NOW,
          pendingComponent: 'a',
        }),
      }),
    );
    expect(d.action).toBe('allow');
    expect(d.reason).toContain('cooldown');
  });
});

describe('gateEditDecision — budget and cooldown', () => {
  it('allows once the session deny budget is spent (fails open)', () => {
    const d = gateEditDecision(
      input({ session: freshSession({ interventionsThisSession: 2 }) }),
    );
    expect(d.action).toBe('allow');
    expect(d.reason).toContain('budget');
  });

  it('allows within the cooldown window', () => {
    const fiveMinAgo = new Date(Date.parse(NOW) - 5 * 60_000).toISOString();
    const d = gateEditDecision(
      input({ session: freshSession({ interventionsThisSession: 1, lastInterventionAt: fiveMinAgo }) }),
    );
    expect(d.action).toBe('allow');
    expect(d.reason).toContain('cooldown');
  });

  it('fires again after the cooldown has passed', () => {
    const longAgo = new Date(Date.parse(NOW) - 60 * 60_000).toISOString();
    const d = gateEditDecision(
      input({ session: freshSession({ interventionsThisSession: 1, lastInterventionAt: longAgo }) }),
    );
    expect(d.action).toBe('deny');
  });
});

describe('gateEditDecision — enforcement and targeting', () => {
  it('advisory enforcement allows but flags the locked component', () => {
    const d = gateEditDecision(input({ config: cfg({ gate: { enforcement: 'advisory' } }) }));
    expect(d.action).toBe('allow');
    expect(d.advisory).toBe(true);
    expect(d.component).toBe('a');
    expect(d.spendBudget).toBeUndefined();
  });

  it('targets the top importance × (1 − mean) candidate', () => {
    const d = gateEditDecision(
      input({
        touched: ['big', 'small'],
        coverage: coverageOf({ big: explored(0.2), small: explored(0.1) }),
        importance: { big: 1.0, small: 0.1 },
      }),
    );
    expect(d.action).toBe('deny');
    expect(d.component).toBe('big');
  });

  it('one deny targets one component even when several are locked', () => {
    const d = gateEditDecision(
      input({
        touched: ['a', 'b', 'c'],
        coverage: coverageOf({}),
      }),
    );
    expect(d.action).toBe('deny');
    expect(typeof d.component).toBe('string');
  });
});

describe('gateDenyReason — the agent instruction', () => {
  it('sync: run the check now, unlock durably, session-scoped skip', () => {
    const r = gateDenyReason('auth', cfg());
    expect(r).toContain('LOCKED');
    expect(r).toContain('quiz comprehension check');
    expect(r).toContain('scale-tutor');
    expect(r).toContain('retry the edit');
    expect(r).toContain('unlocks this territory durably');
    expect(r).toContain('scale gate defer auth');
    expect(r).toContain('THIS SESSION only');
    expect(r).toContain('--by agent');
  });

  it('async: teach, do not quiz, point at the later unlock surfaces', () => {
    const r = gateDenyReason('auth', cfg({ gate: { assessment: 'async' } }));
    expect(r).toContain('do NOT quiz them now');
    expect(r).toContain('TEACH');
    expect(r).toContain('/scale-study auth');
    expect(r).not.toContain('scale record'); // no sync recording instruction
  });

  it('hard enforcement removes the skip escape', () => {
    const r = gateDenyReason('auth', cfg({ gate: { enforcement: 'hard' } }));
    expect(r).toContain('Skipping is disabled by team policy');
    expect(r).not.toContain('gate defer');
  });

  it('ko adds the delivery-language instruction, in English, for the agent', () => {
    const r = gateDenyReason('auth', cfg({ language: 'ko' }));
    expect(r).toContain('KOREAN');
    expect(r).toContain('code identifiers');
  });

  it('modality socratic names the socratic check', () => {
    const r = gateDenyReason('auth', cfg({ gate: { modality: 'socratic' } }));
    expect(r).toContain('socratic comprehension check');
  });
});

describe('gateDenyReason — a rebellion is not a failure', () => {
  it('names the collaborator and says the junior DID demonstrate it', () => {
    const r = gateDenyReason('auth', cfg(), {
      cause: 'foreign',
      authors: ['ada@example.com'],
    });
    expect(r).toContain('REBELLED');
    expect(r).toContain('DID demonstrate');
    expect(r).toContain('ada@example.com');
    expect(r).toContain('not a failure on their part');
    // The whole point: it must NOT accuse them of never having understood it.
    expect(r).not.toContain('comprehension not yet demonstrated');
  });

  it('a self rebellion says so, without naming anyone', () => {
    const r = gateDenyReason('auth', cfg(), { cause: 'self', authors: [] });
    expect(r).toContain('their own work');
    expect(r).toContain('DID demonstrate');
    expect(r).not.toContain('REBELLED');
  });

  it('steers the check at what changed, not a re-ask', () => {
    const r = gateDenyReason('auth', cfg(), { cause: 'foreign', authors: ['x@y.z'] });
    expect(r).toContain('WHAT CHANGED');
    expect(r).toContain('rather than re-asking');
  });

  it('with no rebellion note it is the plain never-demonstrated wording', () => {
    const r = gateDenyReason('auth', cfg());
    expect(r).toContain('comprehension not yet demonstrated');
    expect(r).not.toContain('DID demonstrate');
  });

  it('an unnamed foreign author still reads sensibly', () => {
    const r = gateDenyReason('auth', cfg(), { cause: 'foreign', authors: [] });
    expect(r).toContain('someone else');
  });
});

describe('gateEditDecision — rebellion notes reach the deny text', () => {
  it('a re-locked component denies with its rebellion wording', () => {
    const d = gateEditDecision(
      input({
        coverage: coverageOf({ a: comp({ state: 'stale', lastValidatedSha: 'abc' }) }),
        rebellions: { a: { cause: 'foreign', authors: ['ada@example.com'] } },
      }),
    );
    expect(d.action).toBe('deny');
    expect(d.reason).toContain('ada@example.com');
  });
});

describe('resolveConfig — the policy layer', () => {
  it('precedence: schema defaults < policy < user', () => {
    const policy = { budgets: { maxPerSession: 5 }, gate: { modality: 'socratic' } };
    const user = { user: 'u', gate: { modality: 'quiz' } };
    const r = resolveConfig(user, policy);
    expect(r.policyApplied).toBe(true);
    expect(r.config.budgets.maxPerSession).toBe(5); // policy over default (2)
    expect(r.config.gate.modality).toBe('quiz'); // user over policy
    expect(r.config.budgets.cooldownMinutes).toBe(15); // untouched default
  });

  it('policy cannot set personal keys (user, language, models)', () => {
    const policy = {
      language: 'ko',
      models: { provider: 'openai' },
      user: 'evil',
      gate: { enforcement: 'hard' },
    };
    const r = resolveConfig({ user: 'me' }, policy);
    expect(r.config.user).toBe('me');
    expect(r.config.language).toBe('en');
    expect(r.config.models.provider).toBe('anthropic');
    expect(r.config.gate.enforcement).toBe('hard'); // allowed section applied
  });

  it('an invalid policy is ignored whole, with the reason surfaced', () => {
    const r = resolveConfig({ user: 'u' }, { budgets: { maxPerSession: -3 } });
    expect(r.policyApplied).toBe(false);
    expect(r.policyError).toContain('budgets.maxPerSession');
    expect(r.config.budgets.maxPerSession).toBe(2); // back to defaults
  });

  it('a legacy user file participates in layering after migration', () => {
    const policy = { gate: { enforcement: 'hard' } };
    const user = { user: 'u', condition: { timing: 'postsession', modality: 'socratic' } };
    const r = resolveConfig(user, policy);
    expect(r.config.gate.assessment).toBe('async'); // migrated user choice wins
    expect(r.config.gate.modality).toBe('socratic');
    expect(r.config.gate.enforcement).toBe('hard'); // policy fills the rest
  });

  it('no policy at all is the plain user parse', () => {
    const r = resolveConfig({ user: 'u' });
    expect(r.policyApplied).toBe(false);
    expect(r.policyError).toBeNull();
  });
});

describe('deepMerge', () => {
  it('merges objects recursively and replaces scalars/arrays', () => {
    const out = deepMerge(
      { a: { x: 1, y: 2 }, list: [1, 2], keep: 'base' },
      { a: { y: 9 }, list: [3] },
    ) as Record<string, unknown>;
    expect(out.a).toEqual({ x: 1, y: 9 });
    expect(out.list).toEqual([3]);
    expect(out.keep).toBe('base');
  });
});

describe('pathMatchesAny — exempt globs', () => {
  it('bare *.md matches any markdown file, anywhere', () => {
    expect(pathMatchesAny('README.md', ['*.md'])).toBe(true);
    expect(pathMatchesAny('docs/deep/notes.md', ['*.md'])).toBe(true);
    expect(pathMatchesAny('src/index.ts', ['*.md'])).toBe(false);
  });

  it('** crosses directories; * does not', () => {
    expect(pathMatchesAny('packages/cli/src/x.ts', ['packages/**'])).toBe(true);
    expect(pathMatchesAny('packages/cli/src/x.ts', ['packages/*'])).toBe(false);
    expect(pathMatchesAny('packages/cli.ts', ['packages/*'])).toBe(true);
  });

  it('**/*.md also matches a top-level file (zero directories)', () => {
    expect(pathMatchesAny('README.md', ['**/*.md'])).toBe(true);
    expect(pathMatchesAny('a/b/README.md', ['**/*.md'])).toBe(true);
  });

  it('empty pattern list matches nothing; regex metachars are literal', () => {
    expect(pathMatchesAny('anything', [])).toBe(false);
    expect(pathMatchesAny('axb.ts', ['a.b.ts'])).toBe(false);
    expect(pathMatchesAny('a.b.ts', ['a.b.ts'])).toBe(true);
  });
});
