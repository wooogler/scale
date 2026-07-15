import type { PaperFrontmatter } from '@scale/core/browser';

/**
 * Hand-seeded papers (PLAN §4.1) keyed by the STABLE component id, which is
 * also the coverage key. `frontmatter` carries the quizzable concepts +
 * rationale; `body` is the cluedoc-style prose (no code symbols in the body).
 * The web panel renders `body` as lightweight markdown; mermaid fences are
 * shown as a placeholder (full mermaid render is a TODO for a later phase).
 */
export interface SamplePaper {
  frontmatter: PaperFrontmatter;
  body: string;
}

export const samplePapers: Record<string, SamplePaper> = {
  'session-management': {
    frontmatter: {
      id: 'session-management',
      title: 'Session Management',
      sources: ['src/server/auth/sessions.ts', 'src/server/middleware/session.ts'],
      concepts: [
        { id: 'server-side-sessions', name: 'Server-side session store, cookie carries only the id' },
        { id: 'session-rotation', name: 'Rotation on privilege change' },
      ],
      rationale: [
        {
          decision: 'Sessions are server-side; the cookie is an opaque id',
          why: 'Revocation must be immediate for shared-document access control',
          alternatives: 'JWT-in-cookie (rejected — revocation complexity)',
          provenance: 'inferred',
        },
      ],
    },
    body: `\`\`\`mermaid
flowchart LR
    Browser -->|opaque cookie id| Middleware
    Middleware -->|lookup| Store[(Session Store)]
    Store -->|identity + privileges| Middleware
\`\`\`

## Abstract

Session Management is how the system remembers who a visitor is between
requests. It keeps the authoritative record of every active session on the
server and hands the browser only an unguessable identifier.

## Description

A session is created when a person authenticates and is stored server-side
with its identity, its privileges, and an expiry. The browser receives only
the identifier. On each request the middleware looks the identifier up, and on
a hit it refreshes the session and attaches the identity.

## Rationale

Sessions are kept server-side and the cookie carries only an opaque identifier
because revocation has to be immediate: shared-document access control depends
on being able to cut off a session at once.`,
  },
  'credential-store': {
    frontmatter: {
      id: 'credential-store',
      title: 'Credential Store',
      sources: ['src/server/auth/credentials.ts'],
      concepts: [
        { id: 'password-hashing', name: 'Passwords stored only as salted one-way hashes' },
        { id: 'constant-time-compare', name: 'Verification uses constant-time comparison' },
      ],
      rationale: [
        {
          decision: 'Never store a recoverable form of a password',
          why: 'A store breach must not yield usable credentials',
          alternatives: 'Reversible encryption (rejected — key compromise leaks everything)',
          provenance: 'inferred',
        },
      ],
    },
    body: `## Abstract

The Credential Store owns the secrets that prove a person is who they claim to
be. It accepts a password at registration, keeps only a one-way hash, and later
answers a single question: does this presented password match?

## Description

At registration the password is salted and hashed and only the hash is kept.
At sign-in the presented password is hashed the same way and compared in
constant time, so timing never leaks how much of a guess was correct.`,
  },
  'oauth-providers': {
    frontmatter: {
      id: 'oauth-providers',
      title: 'OAuth Providers',
      sources: ['src/server/auth/oauth/'],
      concepts: [
        { id: 'delegated-identity', name: 'Identity delegated to an external provider' },
        { id: 'account-linking', name: 'External identities linked to a local account' },
      ],
      rationale: [
        {
          decision: 'Link external identities to a single local account',
          why: 'One person may sign in through several providers over time',
          alternatives: 'One account per provider (rejected — fragments history)',
          provenance: 'inferred',
        },
      ],
    },
    body: `## Abstract

OAuth Providers let a person sign in through an external identity they already
trust rather than a password held here.

## Description

The provider vouches for the person; the returned external identity is matched
to a local account, creating one on first use and linking it thereafter.`,
  },
  'document-model': {
    frontmatter: {
      id: 'document-model',
      title: 'Document Model',
      sources: ['src/server/documents/model.ts', 'src/server/documents/store.ts'],
      concepts: [
        { id: 'document-lifecycle', name: 'Draft → sent → completed lifecycle' },
        { id: 'immutable-audit', name: 'Every state change appended to an audit trail' },
      ],
      rationale: [
        {
          decision: 'A completed document is immutable',
          why: 'Signatures must attest to a fixed artifact',
          alternatives: 'Editable completed docs (rejected — breaks the attestation)',
          provenance: 'inferred',
        },
      ],
    },
    body: `## Abstract

The Document Model is the spine of the realm: the record every other feature
attaches to. It defines what a document is, the states it moves through, and
the trail it leaves behind.

## Description

A document begins as a draft, is sent for signature, and reaches completion
once all parties have signed. Each transition is appended to an audit trail
that is never rewritten.`,
  },
  'signing-pipeline': {
    frontmatter: {
      id: 'signing-pipeline',
      title: 'Signing Pipeline',
      sources: ['src/server/documents/signing/pipeline.ts'],
      concepts: [
        { id: 'ordered-recipients', name: 'Recipients sign in a defined order' },
        { id: 'field-binding', name: 'Each signature binds to a specific field and page' },
      ],
      rationale: [
        {
          decision: 'Freeze the document hash before the first signature',
          why: 'Every signer must attest to the exact same bytes',
          alternatives: 'Hash per signer (rejected — signers could attest to different content)',
          provenance: 'inferred',
        },
      ],
    },
    body: `## Abstract

The Signing Pipeline drives a document from "sent" to "completed", collecting
each recipient's signature in turn and binding it to the page and field it
belongs to.

## Description

Recipients are notified in order. Each places a signature bound to a specific
field, and only when the last recipient signs does the document complete.`,
  },
  'templates': {
    frontmatter: {
      id: 'templates',
      title: 'Templates',
      sources: ['src/server/documents/templates.ts'],
      concepts: [
        { id: 'reusable-layout', name: 'A reusable field layout applied to new documents' },
        { id: 'placeholder-recipients', name: 'Recipient roles resolved at instantiation' },
      ],
      rationale: [
        {
          decision: 'Templates store roles, not people',
          why: 'The same template serves many different recipients',
          alternatives: 'Bake in recipients (rejected — not reusable)',
          provenance: 'inferred',
        },
      ],
    },
    body: `## Abstract

Templates capture a document's field layout and recipient roles once so the
same shape can be reused for many signings.

## Description

A template names roles rather than people. When instantiated, concrete
recipients are bound to those roles and a fresh document is produced.`,
  },
  'document-sharing': {
    frontmatter: {
      id: 'document-sharing',
      title: 'Document Sharing',
      sources: ['src/server/sharing/links.ts', 'src/server/sharing/permissions.ts'],
      concepts: [
        { id: 'share-links', name: 'Opaque share links grant scoped access' },
        { id: 'server-side-checks', name: 'Permissions checked server-side on every request' },
      ],
      rationale: [
        {
          decision: 'Check permissions server-side on every request',
          why: 'Client-cached grants can be replayed after revocation',
          alternatives: 'Trust a signed client token (rejected — revocation lag)',
          provenance: 'inferred',
        },
      ],
    },
    body: `## Abstract

Document Sharing decides who, beyond the owner, may reach a document and what
they may do with it.

## Description

A share link carries an opaque token that maps to a scoped grant. Every request
re-checks the grant server-side, so revoking a link takes effect immediately.`,
  },
  'team-access': {
    frontmatter: {
      id: 'team-access',
      title: 'Team Access',
      sources: ['src/server/teams/membership.ts'],
      concepts: [
        { id: 'role-based-access', name: 'Access derived from team role' },
        { id: 'inherited-permissions', name: 'Documents inherit team-level permissions' },
      ],
      rationale: [
        {
          decision: 'Derive document access from team membership',
          why: 'Managing people once per team beats per-document grants',
          alternatives: 'Per-document ACLs only (rejected — unmanageable at scale)',
          provenance: 'inferred',
        },
      ],
    },
    body: `## Abstract

Team Access lets a group of people share a body of documents through their
membership rather than one grant at a time.

## Description

Each member holds a role, and roles map to what they may do. A document owned
by a team inherits the team's permissions.`,
  },
  'webhooks': {
    frontmatter: {
      id: 'webhooks',
      title: 'Webhooks',
      sources: ['src/server/webhooks/dispatch.ts'],
      concepts: [
        { id: 'event-fanout', name: 'Domain events delivered to subscriber URLs' },
        { id: 'delivery-retry', name: 'Failed deliveries retried with backoff' },
      ],
      rationale: [
        {
          decision: 'Deliver webhooks asynchronously with retries',
          why: 'A slow or failing subscriber must not block the core flow',
          alternatives: 'Synchronous delivery (rejected — couples us to subscriber uptime)',
          provenance: 'inferred',
        },
      ],
    },
    body: `## Abstract

Webhooks let external systems react to what happens here by receiving events
as they occur.

## Description

When a domain event fires, it is queued and delivered to each subscribed URL.
Failed deliveries are retried with backoff so a temporary outage is tolerated.`,
  },
};
