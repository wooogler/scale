/**
 * The canonical section vocabulary of a component doc, and the one place that
 * maps a heading line to it.
 *
 * Component docs were first written with the section names of an academic
 * paper — Abstract, Introduction, Related Work, Description, Rationale,
 * Conclusion. That vocabulary told a developer nothing about what belonged
 * under each heading, so the headings are now developer-native. The academic
 * spellings stay in this table as ALIASES rather than being deleted: every
 * `.scale/` tree built before the change is on disk, unmodified, in repos this
 * code does not control, and a doc that stops parsing is a component that
 * silently drops out of the map.
 *
 * Pure — no IO, no zod. Both the node barrel and the browser barrel export it,
 * because the loader (node) and the viewer (browser) must agree on what a
 * heading means.
 */

export type SectionKey =
  | 'summary'
  | 'what-it-does'
  | 'related-components'
  | 'how-it-works'
  | 'design-decisions'
  | 'where-it-sits';

/** One canonical section: its key, its heading text, and what else parses as it. */
export interface SectionSpec {
  key: SectionKey;
  /** Canonical English heading text, WITHOUT the leading `## `. */
  heading: string;
  /** Legacy heading texts that still resolve to this section. */
  aliases: string[];
}

/**
 * The six sections, in the order a doc is written.
 *
 * Order is part of the contract: a reader (and {@link SECTION_HEADING}) keys
 * off it, and the doc template emits it.
 */
export const SECTIONS: readonly SectionSpec[] = [
  { key: 'summary', heading: 'Summary', aliases: ['Abstract'] },
  { key: 'what-it-does', heading: 'What it does', aliases: ['Introduction'] },
  { key: 'related-components', heading: 'Related components', aliases: ['Related Work'] },
  { key: 'how-it-works', heading: 'How it works', aliases: ['Description'] },
  { key: 'design-decisions', heading: 'Design decisions', aliases: ['Rationale'] },
  { key: 'where-it-sits', heading: 'Where it sits', aliases: ['Conclusion'] },
];

/** Canonical heading text for each section key. */
export const SECTION_HEADING: Record<SectionKey, string> = Object.fromEntries(
  SECTIONS.map((s) => [s.key, s.heading]),
) as Record<SectionKey, string>;

/**
 * Normalize a heading for lookup: trimmed, case-folded, inner whitespace
 * collapsed, a trailing parenthetical dropped, and trailing punctuation dropped.
 *
 * `## Rationale:` and `## RATIONALE` are the same section under a different
 * pen. Only TRAILING punctuation goes — stripping it everywhere would fold
 * `## What it does` and `## What-it-does` together with headings that merely
 * share letters, and the match below is on the FULL heading for a reason.
 *
 * A trailing `(…)` goes for the same reason the aliases exist. Writers gloss a
 * heading in place — `## Related Work (siblings)`, `## Summary (tl;dr)` — and
 * the gloss is an aside to the reader, not a different section; reading it as
 * one costs the doc a section it actually has. Only a BALANCED, innermost
 * parenthetical at the very end is removed, so a heading whose words merely
 * contain a bracket keeps them.
 */
function normalizeHeading(headingText: string): string {
  let text = headingText.trim().replace(/[\s\u00a0\u2007\u202f]+/g, ' ');
  // The two strips alternate until neither fires: `## Summary (short):` carries
  // punctuation OUTSIDE the parenthetical, and one pass of each would leave it.
  for (;;) {
    const next = text
      .replace(/[\s.:;,!?*_~`\-—–]+$/u, '')
      .replace(/\([^()]*\)$/u, '')
      .trimEnd();
    if (next === text) break;
    text = next;
  }
  return text.toLowerCase();
}

/** heading (normalized) → key, canonical spellings and aliases alike. */
const BY_HEADING: ReadonlyMap<string, SectionKey> = new Map(
  SECTIONS.flatMap((s) =>
    [s.heading, ...s.aliases].map(
      (h) => [normalizeHeading(h), s.key] as [string, SectionKey],
    ),
  ),
);

/**
 * Resolve a heading line's TEXT (no `## `) to its section key, or null when it
 * names no section this vocabulary knows.
 *
 * Matching is on the WHOLE heading, deliberately. The previous keying took the
 * first word, so `## Rationale and trade-offs` ranked as the rationale section —
 * cheap while headings were single words, and wrong the moment they became
 * phrases: `## Where it sits` and `## Where the bodies are buried` share their
 * first word, and `## What it does` and `## How it works` share theirs. An
 * unrecognized heading is not an error; callers keep their own behaviour for it.
 */
export function canonicalSectionKey(headingText: string): SectionKey | null {
  return BY_HEADING.get(normalizeHeading(headingText)) ?? null;
}
