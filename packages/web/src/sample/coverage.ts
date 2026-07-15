import type { UserCoverage } from '@scale/core/browser';

/**
 * Hand-seeded per-user coverage (PLAN §5), one entry per node in the sample
 * map. Deliberately spans all four coverage states so every skin renders:
 * fog / explored / validated / stale.
 */
export const sampleCoverage: UserCoverage = {
  user: 'junior-01',
  updatedAt: '2026-07-14T10:00:00.000Z',
  components: {
    'session-management': {
      state: 'validated',
      dims: { structure: 0.72, concepts: 0.65, rationale: 0.6 },
      lastValidatedSha: 'abc1234',
      loyalty: 0.9,
    },
    'document-model': {
      state: 'validated',
      dims: { structure: 0.8, concepts: 0.7, rationale: 0.62 },
      lastValidatedSha: 'abc1234',
      loyalty: 0.85,
    },
    'signing-pipeline': {
      // previously validated, but sources drifted -> loyalty < 0.5 -> rebellion
      state: 'stale',
      dims: { structure: 0.6, concepts: 0.55, rationale: 0.5 },
      lastValidatedSha: '9f8e7d6',
      loyalty: 0.35,
    },
    'credential-store': {
      state: 'explored',
      dims: { structure: 0.3, concepts: 0.2, rationale: 0.05 },
      lastValidatedSha: null,
      loyalty: 1.0,
    },
    'document-sharing': {
      state: 'explored',
      dims: { structure: 0.25, concepts: 0.1, rationale: 0.0 },
      lastValidatedSha: null,
      loyalty: 1.0,
    },
    'templates': {
      state: 'explored',
      dims: { structure: 0.22, concepts: 0.15, rationale: 0.0 },
      lastValidatedSha: null,
      loyalty: 1.0,
    },
    'oauth-providers': {
      state: 'fog',
      dims: { structure: 0.0, concepts: 0.0, rationale: 0.0 },
      lastValidatedSha: null,
      loyalty: 1.0,
    },
    'team-access': {
      state: 'fog',
      dims: { structure: 0.0, concepts: 0.0, rationale: 0.0 },
      lastValidatedSha: null,
      loyalty: 1.0,
    },
    'webhooks': {
      state: 'fog',
      dims: { structure: 0.0, concepts: 0.0, rationale: 0.0 },
      lastValidatedSha: null,
      loyalty: 1.0,
    },
  },
};
