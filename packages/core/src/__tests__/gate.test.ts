import { describe, it, expect } from 'vitest';
import {
  gateEditDecision,
  gateDenyReason,
  checkBrief,
  resolveConfig,
  explainConfig,
  isLead,
  policyLeads,
  PolicyFileSchema,
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

  it('a quiz deny carries the check shape, so the tutor needs no second call', () => {
    expect(gateDenyReason('auth', cfg())).toContain(
      'quiz: 2 item(s), focus auto, grounding balanced',
    );
    const tuned = gateDenyReason(
      'auth',
      cfg({ quiz: { items: 4, focus: 'rationale', grounding: 'diff' } }),
    );
    expect(tuned).toContain('quiz: 4 item(s), focus rationale, grounding diff');
    // …and it stays on its own line, so a line-wise reader finds it whole.
    expect(tuned.split('\n')).toContain('quiz: 4 item(s), focus rationale, grounding diff');
  });

  it('a socratic deny carries no item count — there is none to set', () => {
    expect(gateDenyReason('auth', cfg({ gate: { modality: 'socratic' } }))).not.toContain('quiz:');
  });
});

// A deny is the one moment SCALE takes the junior's attention by force. Telling
// them to go "open the map viewer" without saying WHERE is the terminal trip
// this surface exists to remove, so the link is part of the contract.
describe('gateDenyReason — where the junior goes next', () => {
  const link = 'http://localhost:4318/#/c/auth';

  it('ends with a clickable deep link plus the two chat commands', () => {
    const r = gateDenyReason('auth', cfg(), undefined, link);
    const last = r.split('\n').at(-1)!;
    expect(last).toBe(`Map viewer: ${link}  ·  or /scale-open auth  ·  or /scale-study auth`);
  });

  it('carries the link on an async deny too — that is where it is acted on', () => {
    const r = gateDenyReason('auth', cfg({ gate: { assessment: 'async' } }), undefined, link);
    expect(r.split('\n').at(-1)).toContain(link);
  });

  it('survives hard enforcement and a ko delivery instruction', () => {
    const r = gateDenyReason(
      'auth',
      cfg({ gate: { enforcement: 'hard' }, language: 'ko' }),
      undefined,
      link,
    );
    expect(r.split('\n').at(-1)).toContain(link);
    expect(r).toContain('KOREAN');
  });

  it('omits the line entirely when the caller does not know the viewer', () => {
    expect(gateDenyReason('auth', cfg())).not.toContain('Map viewer:');
  });
});

describe('gateEditDecision — the deny reason carries the component deep link', () => {
  it('threads viewerUrlFor through a fresh deny', () => {
    const d = gateEditDecision(
      input({ viewerUrlFor: (c: string) => `http://localhost:4318/#/c/${c}` }),
    );
    expect(d.action).toBe('deny');
    expect(d.reason).toContain(`http://localhost:4318/#/c/${d.component}`);
    expect(d.reason).toContain(`/scale-open ${d.component}`);
  });

  it('threads it through a re-deny of the still-pending component too', () => {
    const d = gateEditDecision(
      input({
        session: {
          interventionsThisSession: 1,
          lastInterventionAt: NOW,
          pendingComponent: 'a',
        },
        viewerUrlFor: (c: string) => `http://localhost:4318/#/c/${c}`,
      }),
    );
    expect(d.action).toBe('deny');
    expect(d.component).toBe('a');
    expect(d.spendBudget).toBeUndefined();
    expect(d.reason).toContain('http://localhost:4318/#/c/a');
  });

  it('without it the decision is unchanged — the link is cosmetic, never behavioral', () => {
    const withLink = gateEditDecision(input({ viewerUrlFor: (c: string) => `x/${c}` }));
    const without = gateEditDecision(input({}));
    expect(withLink.action).toBe(without.action);
    expect(withLink.component).toBe(without.component);
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

describe('gateEditDecision — drift notes reach the deny text', () => {
  it('a re-locked component denies with its rebellion wording', () => {
    const d = gateEditDecision(
      input({
        coverage: coverageOf({ a: comp({ state: 'stale', lastValidatedSha: 'abc' }) }),
        drifted: { a: { cause: 'foreign', authors: ['ada@example.com'] } },
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

  it('a team may default the check SHAPE, and a member may still override a leaf', () => {
    const policy = { quiz: { items: 1, focus: 'rationale', grounding: 'doc' } };
    const r = resolveConfig({ user: 'u', quiz: { items: 4 } }, policy);
    expect(r.policyApplied).toBe(true);
    expect(r.config.quiz.items).toBe(4); // user over policy
    expect(r.config.quiz.focus).toBe('rationale'); // policy over default
    expect(r.config.quiz.grounding).toBe('doc');
    // Per-leaf provenance, the same as every other policy section.
    const sources = explainConfig({ user: 'u', quiz: { items: 4 } }, policy);
    expect(sources['quiz.items']).toMatchObject({ source: 'user', value: 4, policyValue: 1 });
    expect(sources['quiz.focus']).toMatchObject({ source: 'policy', value: 'rationale' });
    expect(sources['quiz.grounding']).toMatchObject({ source: 'policy', value: 'doc' });
  });

  it('an out-of-range policy quiz.items is ignored whole, with the reason surfaced', () => {
    const r = resolveConfig({ user: 'u' }, { quiz: { items: 9 } });
    expect(r.policyApplied).toBe(false);
    expect(r.policyError).toContain('quiz.items');
    expect(r.config.quiz.items).toBe(2);
  });

  it('with no policy at all, every quiz leaf reads as a schema default', () => {
    const sources = explainConfig({ user: 'u' });
    expect(sources['quiz.items']).toMatchObject({ source: 'default', value: 2 });
    expect(sources['quiz.focus']).toMatchObject({ source: 'default', value: 'auto' });
    expect(sources['quiz.grounding']).toMatchObject({ source: 'default', value: 'balanced' });
  });

  it('no policy at all is the plain user parse', () => {
    const r = resolveConfig({ user: 'u' });
    expect(r.policyApplied).toBe(false);
    expect(r.policyError).toBeNull();
  });
});

describe('isLead — the bootstrap rule', () => {
  it('with no policy file at all, everyone is a lead', () => {
    expect(isLead(undefined, ['me@example.com'])).toBe(true);
    expect(isLead(null, [])).toBe(true);
  });

  it('with a policy that names no leads, everyone is still a lead', () => {
    expect(isLead({ gate: { enforcement: 'hard' } }, ['me@example.com'])).toBe(true);
    expect(isLead({ leads: [] }, ['me@example.com'])).toBe(true);
  });

  it('once someone is named, only the named are leads', () => {
    const policy = { leads: ['lead@example.com'] };
    expect(isLead(policy, ['lead@example.com'])).toBe(true);
    expect(isLead(policy, ['member@example.com'])).toBe(false);
    // No identity at all is not a lead — unlike drift attribution, failing
    // toward "yes" here would make the list mean nothing on a laptop with no
    // `git config user.email`.
    expect(isLead(policy, [])).toBe(false);
  });

  it('matches case-insensitively and ignores surrounding space', () => {
    const policy = { leads: ['  Lead@Example.COM  '] };
    expect(isLead(policy, ['lead@example.com'])).toBe(true);
    expect(isLead(policy, ['LEAD@EXAMPLE.COM'])).toBe(true);
  });

  it('any ONE of the reader’s addresses is enough', () => {
    const policy = { leads: ['work@corp.example'] };
    expect(isLead(policy, ['home@example.com', 'work@corp.example'])).toBe(true);
  });

  it('a malformed leads value reads as empty, which reopens rather than locks', () => {
    // A file nobody can parse must not be a file nobody can fix.
    expect(isLead({ leads: 'lead@example.com' }, ['x@y.z'])).toBe(true);
    expect(isLead({ leads: [1, null, ''] }, ['x@y.z'])).toBe(true);
    expect(isLead('not an object', ['x@y.z'])).toBe(true);
  });

  it('policyLeads normalizes, dedupes and preserves order', () => {
    expect(policyLeads({ leads: ['B@x.com', 'a@X.com', 'b@x.com', ' '] })).toEqual([
      'b@x.com',
      'a@x.com',
    ]);
    expect(policyLeads({})).toEqual([]);
  });
});

describe('PolicyFileSchema', () => {
  it('accepts leads alongside sparse sections', () => {
    const parsed = PolicyFileSchema.safeParse({
      leads: ['lead@example.com'],
      gate: { enforcement: 'hard' },
      quiz: { items: 3 },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a value the merge would later reject anyway', () => {
    expect(PolicyFileSchema.safeParse({ quiz: { items: 9 } }).success).toBe(false);
    expect(PolicyFileSchema.safeParse({ budgets: { maxPerSession: -1 } }).success).toBe(false);
    expect(PolicyFileSchema.safeParse({ leads: [''] }).success).toBe(false);
  });

  it('lets an inert key through instead of failing the whole file', () => {
    // `models` is personal — the merge already ignores it. A policy carrying
    // one is a no-op, not a broken file.
    expect(PolicyFileSchema.safeParse({ models: { provider: 'openai' } }).success).toBe(true);
  });

  it('leads never reaches anyone’s config, and never appears in provenance', () => {
    const policy = { leads: ['lead@example.com'], gate: { enforcement: 'hard' } };
    const r = resolveConfig({ user: 'u' }, policy);
    expect(r.policyApplied).toBe(true);
    expect(r.config.gate.enforcement).toBe('hard');
    expect('leads' in (r.config as object)).toBe(false);
    expect(Object.keys(explainConfig({ user: 'u' }, policy))).not.toContain('leads');
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

// ---------------------------------------------------------------------------
// checkBrief — process parity between the in-flow gate and the chat review
//
// The study manipulates ONE variable: WHEN the comprehension check happens. If
// the two paths' instructions could drift apart on wording or emphasis, the
// timing contrast would be confounded by a prose difference nobody tracked. So
// these tests are not style checks — they are the experiment's control, pinned
// in code.
// ---------------------------------------------------------------------------

/** The exact deny text the gate has always produced, byte for byte. */
const GATE_SYNC_QUIZ =
  "SCALE edit gate — the 'auth' territory is LOCKED for this user (comprehension " +
  'not yet demonstrated), and this edit reaches into it. This moment is for the ' +
  'JUNIOR, not for you to resolve.\n' +
  "Run the quiz comprehension check on 'auth' using the scale-tutor skill and put " +
  'it in front of them now. After they complete it (scale record), retry the edit ' +
  '— a passing check unlocks this territory durably.\n' +
  'quiz: 2 item(s), focus auto, grounding balanced\n' +
  'Do NOT skip on their behalf. If — and only if — the junior says to skip, run ' +
  '`scale gate defer auth` (this unlocks it for THIS SESSION only), then retry the ' +
  'edit. If you skip without asking (e.g. no junior is in the loop), you MUST run ' +
  '`scale gate defer auth --by agent` and say so in your reply.';

const REVIEW_SINCE = '2026-09-19T08:30:00.000Z';

describe('checkBrief — the gate text is frozen by the refactor', () => {
  it('gateDenyReason still emits exactly what it emitted before', () => {
    expect(gateDenyReason('auth', cfg())).toBe(GATE_SYNC_QUIZ);
  });

  it("gateDenyReason is checkBrief(cause:'gate') — same function, same bytes", () => {
    expect(checkBrief('auth', cfg(), { kind: 'gate' })).toBe(GATE_SYNC_QUIZ);
    const drift = { cause: 'foreign' as const, authors: ['ada@example.com'] };
    expect(checkBrief('auth', cfg(), { kind: 'gate', drift }, 'http://x/#/c/auth')).toBe(
      gateDenyReason('auth', cfg(), drift, 'http://x/#/c/auth'),
    );
  });
});

describe('checkBrief — a review differs ONLY in its head and its next step', () => {
  const review = (reason: 'owed' | 'touched', files: string[] = ['a.ts']): string =>
    checkBrief('auth', cfg(), { kind: 'review', reason, since: REVIEW_SINCE, files });

  it('owed: the head names the async debt and dates it', () => {
    const head = review('owed').split('\n')[0]!;
    expect(head).toBe(
      "SCALE review — the 'auth' territory is LOCKED and this user still owes its " +
        'check (denied under async assessment on 2026-09-19). This moment is for the ' +
        'JUNIOR, not for you to resolve.',
    );
  });

  it('touched: the head names the work and the bar, with the file count', () => {
    const head = review('touched', ['a.ts', 'b.ts']).split('\n')[0]!;
    expect(head).toBe(
      "SCALE review — the 'auth' territory is LOCKED and this user touched 'auth' " +
        '(2 file(s)) since 2026-09-19 and its comprehension is still below the bar. ' +
        'This moment is for the JUNIOR, not for you to resolve.',
    );
  });

  it('everything after the head is the sync check, with one clause swapped', () => {
    const tail = (s: string): string => s.split('\n').slice(1).join('\n');
    // The "what next" clause appears twice in a sync deny — after the check and
    // after a skip — and BOTH read "move on" in a review: there is no edit to
    // retry in either case.
    expect(tail(review('owed'))).toBe(
      tail(GATE_SYNC_QUIZ).replaceAll(
        'retry the edit',
        'move on to the next item in the review queue',
      ),
    );
    expect(tail(review('owed'))).not.toContain('retry the edit');
    // Both review reasons share that one body; only the head separates them.
    expect(tail(review('touched'))).toBe(tail(review('owed')));
  });

  it('the review body never tells the agent to retry an edit there is none of', () => {
    const body = review('owed').split('\n')[1]!;
    expect(body).not.toContain('retry the edit');
    expect(body).toContain('move on to the next item in the review queue');
    expect(body).toContain('unlocks this territory durably');
  });

  it('an ASYNC user gets the CHECK body in review, never the teach-only body', () => {
    // This is the whole point of the post-session path: the async deny taught
    // and deferred, so the review is where the owed check finally happens.
    const async = checkBrief('auth', cfg({ gate: { assessment: 'async' } }), {
      kind: 'review',
      reason: 'owed',
      since: REVIEW_SINCE,
      files: [],
    });
    expect(async).not.toContain('do NOT quiz them now');
    expect(async).toContain('Run the quiz comprehension check');
    expect(async).toContain('scale record');
  });

  it('carries the quiz spec, the skip paragraph, ko delivery and the access line', () => {
    const r = checkBrief(
      'auth',
      cfg({ language: 'ko', quiz: { items: 4, focus: 'rationale', grounding: 'diff' } }),
      { kind: 'review', reason: 'touched', since: REVIEW_SINCE, files: ['a.ts'] },
      'http://localhost:4318/#/c/auth',
    );
    expect(r.split('\n')).toContain('quiz: 4 item(s), focus rationale, grounding diff');
    expect(r).toContain('scale gate defer auth');
    expect(r).toContain('KOREAN');
    expect(r.split('\n').at(-1)).toBe(
      'Map viewer: http://localhost:4318/#/c/auth  ·  or /scale-open auth  ·  or /scale-study auth',
    );
  });

  it('hard enforcement removes the skip escape in review too', () => {
    const r = checkBrief('auth', cfg({ gate: { enforcement: 'hard' } }), {
      kind: 'review',
      reason: 'owed',
      since: REVIEW_SINCE,
      files: [],
    });
    expect(r).toContain('Skipping is disabled by team policy');
    expect(r).not.toContain('gate defer');
  });
});
