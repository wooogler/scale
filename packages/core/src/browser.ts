// @scale/core/browser — the browser-safe surface of @scale/core.
//
// Identical to the "." barrel MINUS `doc-loader`, which pulls in node:fs /
// node:path and must never be bundled into the web SPA. Everything re-exported
// here is pure and free of node builtins (verified: schemas use only zod;
// coverage-model / state-engine / layout / index-map import only sibling schemas
// and each other). The CLI keeps using the "." barrel for loadScaleDir.

// Schemas + inferred types.
export * from './schema/doc.js';
export * from './schema/sections.js';
export * from './schema/map.js';
export * from './schema/coverage.js';
export * from './schema/evidence.js';
export * from './schema/quest.js';
export * from './schema/config.js';
export * from './schema/telemetry.js';

// Pure coverage model.
export * from './coverage-model.js';

// Stable English anchor slugs for doc sections. On the browser surface because
// the viewer renders the heading ids and the CLI writes the links to them —
// one implementation, or `--section` and the DOM drift apart silently.
export * from './doc-slug.js';

// The edit-gate decision and its agent-facing text. Deliberately on the browser
// surface: `gateDenyReason` / `quizSpecLine` are pure string builders over the
// config, which lets the Settings modal PREVIEW the exact text the agent will
// receive — rendered by the same function that ships it, so the preview cannot
// drift from the product. gate.ts imports only sibling types and `meanDims`; a
// test pins that the whole browser surface stays free of node builtins.
export * from './gate.js';

// File→component index (pure).
export * from './index-map.js';

// Deterministic frozen map layout (pure).
export * from './layout.js';

// Higher-level state operations (pure).
// `DriftCause` is the coverage-record field type (schema/coverage.js); the
// state-engine's same-named alias is internal, so it is not re-exported.
export {
  applyEvidence,
  recomputeDrift,
  causeOfDrift,
  foldEvidence,
  materializeCoverage,
  finalizeCoverage,
  emptyComponentCoverage,
  type ComponentChurn,
  type DriftOpts,
  type ApplyContext,
  type MaterializeOpts,
} from './state-engine.js';
