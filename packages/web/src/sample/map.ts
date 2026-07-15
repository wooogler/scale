import type { MapJson } from '@scale/core/browser';

/**
 * Hand-seeded FROZEN layout for the skeleton demo (PLAN §4.2).
 * Coordinates are the frozen normalized (x,y) — the viewer never re-runs
 * a force layout (§1: spatial stability = survey knowledge). Shaped after a
 * Documenso-like pilot: authentication / documents / sharing.
 */
export const sampleMap: MapJson = {
  version: 1,
  builtFromSha: 'abc1234',
  provinces: [
    { id: 'auth', name: 'Authentication' },
    { id: 'documents', name: 'Documents' },
    { id: 'sharing', name: 'Sharing & Collaboration' },
  ],
  nodes: [
    // auth
    { id: 'session-management', province: 'auth', x: 0.66, y: 0.24, importance: 0.8 },
    { id: 'credential-store', province: 'auth', x: 0.78, y: 0.14, importance: 0.5 },
    { id: 'oauth-providers', province: 'auth', x: 0.84, y: 0.34, importance: 0.4 },
    // documents
    { id: 'document-model', province: 'documents', x: 0.26, y: 0.22, importance: 0.9 },
    { id: 'signing-pipeline', province: 'documents', x: 0.16, y: 0.42, importance: 0.7 },
    { id: 'templates', province: 'documents', x: 0.34, y: 0.44, importance: 0.5 },
    // sharing
    { id: 'document-sharing', province: 'sharing', x: 0.55, y: 0.66, importance: 0.6 },
    { id: 'team-access', province: 'sharing', x: 0.4, y: 0.78, importance: 0.5 },
    { id: 'webhooks', province: 'sharing', x: 0.7, y: 0.82, importance: 0.3 },
  ],
  edges: [
    // hierarchy (province -> component); rendered only for node<->node pairs
    { from: 'auth', to: 'session-management', kind: 'hierarchy' },
    // reference cross-links (the graph, §4.1 Related Work)
    { from: 'session-management', to: 'document-sharing', kind: 'reference' },
    { from: 'session-management', to: 'credential-store', kind: 'reference' },
    { from: 'oauth-providers', to: 'credential-store', kind: 'reference' },
    { from: 'document-model', to: 'signing-pipeline', kind: 'depends_on' },
    { from: 'document-model', to: 'templates', kind: 'reference' },
    { from: 'document-sharing', to: 'document-model', kind: 'reference' },
    { from: 'document-sharing', to: 'team-access', kind: 'reference' },
    { from: 'document-sharing', to: 'webhooks', kind: 'reference' },
    { from: 'signing-pipeline', to: 'session-management', kind: 'reference' },
  ],
};
