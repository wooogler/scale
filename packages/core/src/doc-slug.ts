/**
 * Stable, English anchor slugs for the parts of a component doc — the target
 * half of a `#/c/<component-id>/<section>` deep link.
 *
 * WHY THIS IS SHARED CODE. The viewer renders the heading ids, but the CLI is
 * what WRITES the links: `scale serve url --component gate-core --section
 * design-decisions`, a tutor's "read more" pointer, a gate denial. Two
 * implementations of "what is this heading's anchor" would drift the day a
 * heading gained a comma, and every link written before that day would land on
 * the top of the doc with no error to notice. So it lives here, browser-safe
 * (no node builtins, no zod), and both sides import it.
 *
 * WHY ENGLISH. A doc's source is English and its DISPLAY may be translated per
 * reader (see cli/translate.ts). A slug derived from what is on screen would
 * differ per language, and a link written by a Korean reader would not open for
 * an English one. Slugs are therefore always computed from the ENGLISH body;
 * the translated body inherits them positionally (translation preserves
 * markdown structure, so the k-th heading is the k-th heading in either
 * language) and the viewer falls back gracefully when the counts disagree.
 */

/**
 * The two panel sections that are NOT body headings: the concepts list and the
 * design-rationale list, both rendered from frontmatter rather than prose.
 *
 * They are reserved words in the slug space — {@link headingSlugs} will not
 * hand either of them to a body heading — so `#/c/<id>/concepts` means the same
 * thing in every doc, whatever that doc's headings happen to be called.
 */
export const PANEL_SECTION_IDS = ['concepts', 'decisions'] as const;
export type PanelSectionId = (typeof PANEL_SECTION_IDS)[number];

/**
 * Kebab-case anchor for a heading's text.
 *
 * ASCII-only on purpose. Markdown inline markers go first (a heading written
 * `## The \`gate\` decision` anchors as `the-gate-decision`, not
 * `the--gate--decision`), then everything that is not a letter or a digit
 * becomes a single `-`. Non-ASCII letters are dropped rather than transliterated
 * or percent-encoded: a Korean heading slugifies to `''`, which is the honest
 * answer — it has no stable English anchor — and callers substitute a
 * positional fallback instead of minting a slug nobody can type or link to.
 */
export function slugify(text: string): string {
  return text
    .replace(/[`*_~]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** True for a string shaped like a slug this module produces. */
export function isSlug(text: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(text);
}

/**
 * The h2/h3 headings of a markdown body, in document order, as text.
 *
 * Fence-aware for the same reason `splitSections` is: a `## ` line inside a
 * fenced block is a comment or a markdown example, and counting it would shift
 * every slug after it by one — which is exactly the kind of failure that
 * produces links that quietly open the wrong section.
 */
export function bodyHeadings(body: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#{2,3})\s+(.*\S)\s*$/.exec(line);
    if (m) out.push(m[2]!);
  }
  return out;
}

/**
 * Anchor slug for every h2/h3 of an ENGLISH doc body, in document order.
 *
 * The array is positional: index k is the anchor of the k-th heading, and the
 * viewer assigns it to the k-th heading of whatever body it is rendering. Every
 * entry is non-empty and unique across the returned list AND the reserved
 * {@link PANEL_SECTION_IDS}, because these become DOM `id`s: a duplicate id
 * makes `getElementById` a coin flip, and an empty one is not addressable at
 * all. Collisions and unslugifiable headings fall back to `-2`, `-3`… and
 * `section-<k>` respectively, which is ugly but linkable and stable.
 */
export function headingSlugs(body: string): string[] {
  const used = new Set<string>(PANEL_SECTION_IDS);
  return bodyHeadings(body).map((text, i) => {
    const base = slugify(text) || `section-${i + 1}`;
    let slug = base;
    for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`;
    used.add(slug);
    return slug;
  });
}
