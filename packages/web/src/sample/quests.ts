import type { Quest } from '@scale/core/browser';

/**
 * Hand-seeded pending quests (PLAN §5 / §7.3) for standalone `vite dev` — when
 * no `scale serve` is up, loadQuests() falls back to these so quest badges and
 * the quest runner are exercisable without a backend. One quiz + one socratic,
 * targeting sample-map components that are still low-coverage.
 */
export const sampleQuests: Quest[] = [
  {
    id: 'sample-quiz-credential-store',
    componentId: 'credential-store',
    modality: 'quiz',
    origin: 'session',
    status: 'pending',
    items: [
      {
        prompt: 'How are user credentials stored so that a database leak does not expose passwords?',
        options: [
          'Salted, slow one-way hashes (e.g. bcrypt/argon2)',
          'Reversible AES encryption with a shared key',
          'Plaintext, protected only by database access controls',
          'Base64 encoding of the raw password',
        ],
        correctIndex: 0,
        answer: 'Salted, slow one-way hashes (e.g. bcrypt/argon2)',
        dim: 'concepts',
        explanation:
          'Passwords are never recoverable — only a salted, deliberately slow hash is stored, so a leak cannot be reversed and per-user salts defeat rainbow tables.',
      },
      {
        prompt: 'Why does the credential store live behind its own module rather than inline in the auth handlers?',
        options: [
          'To centralize the hashing policy so it can be upgraded in one place',
          'To make the login endpoint respond faster',
          'Because the framework forbids DB calls in handlers',
          'To avoid writing any tests for it',
        ],
        correctIndex: 0,
        answer: 'To centralize the hashing policy so it can be upgraded in one place',
        dim: 'rationale',
        explanation:
          'Isolating credential handling means the hash algorithm and work factor can be rotated centrally without touching every call site.',
      },
    ],
  },
  {
    id: 'sample-socratic-document-sharing',
    componentId: 'document-sharing',
    modality: 'socratic',
    origin: 'session',
    status: 'pending',
    items: [
      {
        prompt:
          'When a document is shared with another user, what has to be true about access checks for that to be safe? Walk me through what happens on the very next request they make.',
        dim: 'concepts',
        focus: 'authorization boundaries | revocation | least privilege',
      },
    ],
  },
];
