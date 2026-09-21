/**
 * What a markdown link inside a component doc MEANS to the viewer.
 *
 * The docs are written to be read on disk and on GitHub, so a "Related
 * components" entry is a relative folder path — `[Panel](../component-panel/)`.
 * In the viewer that path points at nothing: there is no filesystem, and the
 * app routes by the doc's STABLE frontmatter id, not by where its folder
 * happens to sit. This module is the translation between the two, and it is
 * pure so it can be tested without a DOM.
 *
 * The classification is deliberately narrow — three outcomes, and the third is
 * "not a link at all":
 *
 *   component  a path that resolves to a folder this repo has a doc for
 *   external   an explicit http(s) URL
 *   null       everything else — rendered as plain text, not as a dead link
 *
 * `null` is the important one. A doc's links are repository content, and a
 * renderer that turned any `[text](href)` into an anchor would hand that content
 * a `javascript:` URL and a click. Nothing but http/https ever becomes an
 * anchor, and a relative path that names no known doc renders as its text
 * rather than as a link that goes nowhere — which is also the honest picture
 * when a doc points at a component the map does not have (yet).
 */

export type DocLink =
  | { kind: 'component'; id: string }
  | { kind: 'external'; href: string };

/** Normalize a slash path: drop `.`, resolve `..`, collapse empties. */
function normalizeRel(p: string): string {
  const parts: string[] = [];
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

export interface DocLinkContext {
  /** Folder of the doc the link is written IN, relative to `.scale/`. */
  fromDir: string;
  /** Every known doc folder → its component id (from `GET /api/docs`). */
  idByDir: ReadonlyMap<string, string>;
}

/**
 * Resolve one markdown href against the doc that contains it.
 *
 * Returns `null` for anything that must not become an anchor — see the file
 * header. The path is resolved relative to `fromDir`, with a leading `/` read
 * as "from the root of `.scale/`", a trailing `README.md` (or `index.md`)
 * dropped, and any `?query`/`#fragment` ignored: `../beta/`, `../beta`,
 * `../beta/README.md` and `../beta/#summary` are all the same doc.
 */
export function resolveDocLink(href: string, ctx: DocLinkContext): DocLink | null {
  const raw = href.trim();
  if (!raw) return null;

  // Explicit web URLs are the only absolute form we hand to the browser.
  if (/^https?:\/\//i.test(raw)) return { kind: 'external', href: raw };
  // Any OTHER scheme — mailto:, file:, and above all javascript: — is text.
  // The test is for a scheme-shaped prefix, not for a blocklist, so a scheme
  // nobody has thought of yet is refused by default.
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;
  // Protocol-relative (`//host/…`) is a web URL wearing a disguise.
  if (raw.startsWith('//')) return null;
  // A bare fragment is an anchor within the page, not a document reference.
  if (raw.startsWith('#')) return null;

  const path = raw.split(/[?#]/)[0] ?? '';
  if (!path) return null;

  const base = path.startsWith('/') ? '' : ctx.fromDir;
  let rel = normalizeRel(`${base}/${path}`);
  rel = rel.replace(/\/?(README|index)\.mdx?$/i, '');
  if (!rel) return null;

  const id = ctx.idByDir.get(rel);
  return id ? { kind: 'component', id } : null;
}

/** Index a doc list by folder, the lookup `resolveDocLink` wants. */
export function idByDir(docs: readonly { id: string; dir: string }[]): Map<string, string> {
  return new Map(docs.map((d) => [d.dir, d.id]));
}
