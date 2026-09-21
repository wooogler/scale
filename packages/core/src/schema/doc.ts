import { z } from 'zod';

/**
 * Provenance of a rationale entry.
 *
 * Modeled as a free string because the value space is open-ended, but the
 * intended forms are:
 *   - 'inferred'          — derived by the Mode B builder, no human source
 *   - 'prompt:<ref>'      — extracted from a captured prompt/interaction
 *   - 'interview:<ref>'   — captured from a senior rationale interview (deferred)
 */
export const ProvenanceSchema = z.string();
export type Provenance = z.infer<typeof ProvenanceSchema>;

/** A named, quizzable concept unit within a component doc. */
export const ConceptSchema = z.object({
  /** Stable slug for the concept. */
  id: z.string(),
  /** Human-readable name / one-line description. */
  name: z.string(),
});
export type Concept = z.infer<typeof ConceptSchema>;

/** A single design-rationale entry (frontmatter form). */
export const RationaleEntrySchema = z.object({
  decision: z.string(),
  why: z.string().optional(),
  alternatives: z.string().optional(),
  provenance: ProvenanceSchema,
});
export type RationaleEntry = z.infer<typeof RationaleEntrySchema>;

/**
 * Frontmatter of a component doc (`.scale/<province>/<component>/README.md`).
 * Extends cluedoc's `title`/`sources` with `concepts` and `rationale`.
 */
export const DocFrontmatterSchema = z.object({
  /**
   * STABLE slug — the coverage key. Never renamed once assigned; renaming
   * would orphan a user's coverage for this component.
   */
  id: z.string(),
  title: z.string(),
  /** File-granularity code anchors. */
  sources: z.array(z.string()),
  concepts: z.array(ConceptSchema),
  rationale: z.array(RationaleEntrySchema),
});
export type DocFrontmatter = z.infer<typeof DocFrontmatterSchema>;

/**
 * One row of the viewer's doc index (`GET /api/docs`).
 *
 * `dir` is the doc's folder RELATIVE to `.scale/`, slash-separated
 * (`viewer/component-panel`). It exists because a doc's "Related components"
 * links are written as relative folder paths (`[Panel](../component-panel/)`) —
 * the form that works when the tree is read on disk or on GitHub — and the
 * viewer has to turn one back into the STABLE frontmatter id that its routes,
 * coverage and quests are all keyed by. Folder path is the only thing the two
 * representations share, so the index has to carry it.
 */
export const DocIndexEntrySchema = z.object({
  id: z.string(),
  title: z.string(),
  province: z.string(),
  /** Folder path relative to `.scale/`, `/`-separated, no trailing slash. */
  dir: z.string(),
});
export type DocIndexEntry = z.infer<typeof DocIndexEntrySchema>;

/** The whole `GET /api/docs` body: every component doc this repo has. */
export const DocIndexSchema = z.array(DocIndexEntrySchema);
export type DocIndex = z.infer<typeof DocIndexSchema>;
