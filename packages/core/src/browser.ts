// @scale/core/browser — the browser-safe surface of @scale/core.
//
// Identical to the "." barrel MINUS `paper-loader`, which pulls in node:fs /
// node:path and must never be bundled into the web SPA. Everything re-exported
// here is pure and free of node builtins (verified: schemas use only zod;
// coverage-model / state-engine / layout / index-map import only sibling schemas
// and each other). The CLI keeps using the "." barrel for loadScaleDir.

// Schemas + inferred types.
export * from './schema/paper.js';
export * from './schema/map.js';
export * from './schema/coverage.js';
export * from './schema/evidence.js';
export * from './schema/quest.js';
export * from './schema/config.js';

// Pure coverage model.
export * from './coverage-model.js';

// File→component index (pure).
export * from './index-map.js';

// Deterministic frozen map layout (pure).
export * from './layout.js';

// Higher-level state operations (pure).
export * from './state-engine.js';
