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

/**
 * Frontmatter of a COMMITTED rendering of a component doc
 * (`.scale/<province>/<component>/README.<lang>.md`, written by
 * `scale doc translate`).
 *
 * It is the English frontmatter's own shape — so the file reads as a normal doc
 * in an editor and on GitHub — with the human-readable fields (`title`, concept
 * `name`s, rationale prose) translated and the machine fields (`id`, `sources`,
 * concept ids, `provenance`) carried over verbatim, plus five keys that say
 * what it is a rendering OF:
 *
 *  - `source_sha` is the sha256 (hex) of the English README's raw bytes at the
 *    moment of rendering. It is the whole staleness rule: a rendering whose sha
 *    is not the current English file's is stale, never served, and reported by
 *    `scale map check`. No timestamps are compared and nothing is trusted from
 *    the file's own claims about freshness.
 *  - `source_lang` is a literal: English is the source of truth by design, and
 *    a rendering of a rendering is not a thing this format can express.
 *  - `model` / `translated_at` are provenance for the human reviewing the PR.
 *
 * snake_case, unlike the rest of SCALE's JSON, because these are YAML keys a
 * person reads in a doc header, next to `id` and `title`.
 */
export const TranslatedDocFrontmatterSchema = DocFrontmatterSchema.extend({
  lang: z.string().min(1),
  source_lang: z.literal('en'),
  source_sha: z.string().regex(/^[0-9a-f]{64}$/, 'must be a sha256 hex digest'),
  model: z.string(),
  translated_at: z.string(),
});
export type TranslatedDocFrontmatter = z.infer<typeof TranslatedDocFrontmatterSchema>;
