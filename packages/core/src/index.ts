// @scale/core — shared schema types, coverage model, and state engine.

// Schemas + inferred types.
export * from './schema/paper.js';
export * from './schema/map.js';
export * from './schema/coverage.js';
export * from './schema/evidence.js';
export * from './schema/quest.js';
export * from './schema/config.js';

// Pure coverage model.
export * from './coverage-model.js';

// File→component index.
export * from './index-map.js';

// Coverage-memory (.scale/) loader.
export * from './paper-loader.js';
export * from './grounding.js';

// Deterministic frozen map layout.
export * from './layout.js';

// Higher-level state operations (Phase 3 fills the bodies).
export * from './state-engine.js';

// In-flow intervention gate (Phase 4 — pure pre-commit decision).
export * from './gate.js';

// Build-cost estimator (pure math over scanned source LOC).
export * from './estimate.js';
