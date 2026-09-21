/**
 * URL hash deep links for the viewer.
 *
 * Every other surface SCALE talks through — a hook's session message, `scale
 * serve url --component …`, the chat skill — wants to hand the user a link that
 * lands somewhere specific rather than on the map's front door. The hash is the
 * right carrier: `scale serve` off loopback already spends the query string on
 * `?token=…` (see data.ts `bootstrapToken`), and a fragment never reaches the
 * server, so a deep link can be pasted into chat without leaking the route to
 * anything but the browser.
 *
 * Grammar (the whole of it):
 *
 *   #/c/<component-id>             select that component and open its panel
 *   #/c/<component-id>/<section>   …scrolled to one section of its doc
 *   #/settings                     open Settings on the General tab
 *   #/settings/<tab>               open Settings on general | gate | checks | team
 *   anything else                  no route — the plain map
 *
 * `<section>` is an anchor inside the doc: `concepts`, `decisions`, or a
 * heading slug from core's `headingSlugs` (`summary`, `design-decisions`, …).
 * The slugs are derived from the ENGLISH source so a link written by a Korean
 * reader opens for an English one — see doc-slug.ts in core.
 *
 * THE ONE AMBIGUITY, STATED. A component id may itself contain slashes (the
 * frontmatter `id` is a free string), so `#/c/a/b` could be the id `a/b` or the
 * id `a` at section `b`. `formatHash` percent-encodes the id, so every link
 * SCALE writes is unambiguous (`#/c/a%2Fb/summary`); the ambiguity only exists
 * for a hand-written hash. We resolve it toward the section — a trailing
 * segment shaped like a slug (`^[a-z0-9]+(-[a-z0-9]+)*$`) is read as one —
 * because sectioned links are the common case and slashed ids are rare enough
 * that no id in this repo's own `.scale/` tree has ever had one. A reader whose
 * ids do contain slashes still gets exact links from the CLI and from the app's
 * own address-bar sync; only typing one by hand loses the last segment.
 *
 * Unknown input is never an error. A hash naming a component that this repo
 * does not have, a section that doc does not have, or a tab that does not
 * exist, degrades to "no route" / no scroll / General instead of a crash or a
 * toast: these links travel through chat logs and outlive the maps they were
 * written against.
 */

/** Settings tabs, mirrored from Settings.tsx's TAB_IDS. */
export const SETTINGS_TABS = ['general', 'gate', 'checks', 'team'] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

export type Route =
  | { kind: 'component'; id: string; section?: string }
  | { kind: 'settings'; tab: SettingsTab };

const COMPONENT_PREFIX = '#/c/';
const SETTINGS_PREFIX = '#/settings';

/**
 * The shape a section anchor has. Mirrors core's `isSlug` — duplicated as a
 * literal here rather than imported because it is a GRAMMAR decision about the
 * URL, and route.ts is deliberately dependency-free so the hash can be parsed
 * before anything else in the app has loaded.
 */
const SECTION_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function decode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    // A half-typed or truncated escape (`%`, `%E0`) — take the bytes as typed
    // rather than throwing on someone's hand-edited address bar.
    return raw;
  }
}

function asTab(raw: string): SettingsTab {
  const tab = decode(raw);
  return (SETTINGS_TABS as readonly string[]).includes(tab) ? (tab as SettingsTab) : 'general';
}

/**
 * Read a route out of a location hash (with or without the leading `#`).
 * Returns null for an empty hash or anything outside the grammar.
 */
export function parseHash(hash: string): Route | null {
  const h = hash.startsWith('#') ? hash : hash ? `#${hash}` : '';
  if (!h || h === '#' || h === '#/') return null;

  if (h.startsWith(COMPONENT_PREFIX)) {
    // Split on the RAW hash, before decoding: an id that had to be escaped
    // carries its slashes as `%2F`, which is exactly how it stays out of this
    // split and keeps `#/c/a%2Fb/summary` unambiguous.
    const rest = h.slice(COMPONENT_PREFIX.length).replace(/\/+$/, '');
    if (!rest) return null;
    const segments = rest.split('/');
    const last = segments.length > 1 ? decode(segments[segments.length - 1]!) : '';
    if (last && SECTION_RE.test(last)) {
      const id = decode(segments.slice(0, -1).join('/'));
      // A section with no id in front of it is not a route at all.
      return id ? { kind: 'component', id, section: last } : null;
    }
    const id = decode(rest);
    return id ? { kind: 'component', id } : null;
  }

  if (h === SETTINGS_PREFIX || h === `${SETTINGS_PREFIX}/`) {
    return { kind: 'settings', tab: 'general' };
  }
  if (h.startsWith(`${SETTINGS_PREFIX}/`)) {
    return { kind: 'settings', tab: asTab(h.slice(SETTINGS_PREFIX.length + 1).replace(/\/+$/, '')) };
  }

  return null;
}

/** The hash a route should be written as — `''` when there is no route. */
export function formatHash(route: Route | null): string {
  if (!route) return '';
  if (route.kind === 'component') {
    const id = `${COMPONENT_PREFIX}${encodeURIComponent(route.id)}`;
    return route.section ? `${id}/${encodeURIComponent(route.section)}` : id;
  }
  return `${SETTINGS_PREFIX}/${route.tab}`;
}

/** The route this page was opened on (or navigated to). */
export function currentRoute(): Route | null {
  try {
    return parseHash(window.location.hash);
  } catch {
    return null;
  }
}

/**
 * Write `route` into the address bar, leaving path and query untouched.
 *
 * replaceState by default, not pushState or `location.hash = …`: selecting
 * castles on a map is browsing, not navigation, and a pushState per click turns
 * the back button into an undo history nobody asked for. It also keeps
 * `?token=…` (and whatever else the query holds) intact, and — because neither
 * replaceState nor pushState fires `hashchange` — it cannot feed back into the
 * listener that reads the hash.
 *
 * `push: true` is the deliberate exception, and it is a different act: following
 * a link inside a doc to another doc is NAVIGATION between documents, the thing
 * the back button exists for. A reader who clicks three related components deep
 * and wants to return to where they started is asking for history, not for an
 * undo of a map click. The rule is therefore about the gesture, not the state
 * change: map clicks, panel closes and Settings replace; in-doc links and the
 * Docs index push.
 */
export function applyRoute(route: Route | null, opts: { push?: boolean } = {}): void {
  try {
    const { pathname, search, hash } = window.location;
    const next = formatHash(route);
    if (hash === next || (!hash && !next)) return;
    const url = `${pathname}${search}${next}`;
    if (opts.push) window.history.pushState(null, '', url);
    else window.history.replaceState(null, '', url);
  } catch {
    /* no history API (file://, embedded webview) — the app still works */
  }
}
