import type { JSX, MouseEvent } from 'react';
import { useStrings } from './i18n.js';
import { formatHash } from './route.js';
import type { DocLink } from './doclink.js';

/**
 * Deliberately minimal markdown renderer for the component doc bodies:
 * headings, paragraphs, lists, inline emphasis/`code`/links, and a mermaid
 * placeholder. Full markdown + real mermaid rendering is still a TODO (PLAN
 * §7.3 "rendered doc (markdown + mermaid)").
 *
 * Two things here are load-bearing rather than cosmetic.
 *
 * **Heading anchors.** Every h2/h3 gets an `id`, and those ids are what
 * `#/c/<component-id>/<section>` links point at. They are NOT derived from the
 * text this renderer is drawing: the doc on screen may be a per-user
 * translation, and a Korean heading has no stable English anchor. The panel
 * computes the slugs from the ENGLISH source once (core's `headingSlugs`) and
 * passes them down; this renderer assigns the k-th slug to the k-th heading.
 * Translation preserves markdown structure, so the positions line up — and when
 * they do not (a model that dropped or invented a heading), the count check
 * below falls back to per-heading slugs of whatever is on screen rather than
 * labelling sections with the wrong anchors.
 *
 * **Links.** A doc's "Related components" section is folder links between docs;
 * rendering them as text made the viewer unable to follow the graph it draws.
 * What a given href MEANS is not this renderer's decision though — it is
 * resolved by the caller (`resolveLink`, see doclink.ts), which is also where
 * the rule lives that nothing but http(s) and known component folders ever
 * becomes an anchor.
 */

type Block =
  | { kind: 'h2'; text: string }
  | { kind: 'h3'; text: string }
  | { kind: 'p'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'mermaid'; code: string }
  | { kind: 'code'; code: string };

const BULLET = /^[-*+]\s+(.*)$/;
const NUMBER = /^\d+[.)]\s+(.*)$/;

function parse(md: string): Block[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushPara = () => {
    if (para.length > 0) {
      blocks.push({ kind: 'p', text: para.join(' ').trim() });
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      blocks.push({ kind: 'list', ordered: list.ordered, items: list.items });
      list = null;
    }
  };
  const flush = () => {
    flushPara();
    flushList();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      flush();
      const lang = fence[1] ?? '';
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? '')) {
        buf.push(lines[i] ?? '');
        i++;
      }
      const code = buf.join('\n');
      blocks.push(lang === 'mermaid' ? { kind: 'mermaid', code } : { kind: 'code', code });
      continue;
    }
    if (line.startsWith('### ')) {
      flush();
      blocks.push({ kind: 'h3', text: line.slice(4).trim() });
      continue;
    }
    if (line.startsWith('## ')) {
      flush();
      blocks.push({ kind: 'h2', text: line.slice(3).trim() });
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }

    const bullet = BULLET.exec(line.trim());
    const numbered = bullet ? null : NUMBER.exec(line.trim());
    const item = bullet?.[1] ?? numbered?.[1];
    if (item !== undefined) {
      flushPara();
      const ordered = numbered !== null;
      // A marker of the other kind starts a new list rather than joining this
      // one: `- a` followed by `1. b` is two lists, and merging them would
      // renumber content the author wrote as bullets.
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push(item.trim());
      continue;
    }
    if (list) {
      // A plain line under a list item is that item's continuation (docs wrap
      // long "Related components" entries), not a new paragraph.
      list.items[list.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return blocks;
}

/** Match order matters: `code` first, so a link inside backticks stays code. */
const INLINE = /(`[^`]+`|\[[^\]\n]+\]\([^)\s]*\)|\*\*[^*]+\*\*|\*[^*]+\*)/g;

interface LinkOpts {
  resolveLink?: (href: string) => DocLink | null;
  onNavigate?: (id: string) => void;
}

function anchor(
  raw: string,
  key: string,
  opts: LinkOpts,
): JSX.Element {
  const m = /^\[([^\]]+)\]\(([^)\s]*)\)$/.exec(raw);
  const text = m?.[1] ?? raw;
  const href = m?.[2] ?? '';
  const target = m ? (opts.resolveLink?.(href) ?? null) : null;

  // Unresolvable, or a scheme we refuse: the label as plain text. A dead
  // anchor would look clickable and teach the reader that doc links are broken.
  if (!target) return <span key={key}>{inline(text, `${key}-l`, opts)}</span>;

  if (target.kind === 'external') {
    return (
      <a
        key={key}
        className="md-link md-link-ext"
        href={target.href}
        target="_blank"
        rel="noopener noreferrer"
      >
        {inline(text, `${key}-l`, opts)}
      </a>
    );
  }

  const id = target.id;
  // A REAL href, not a bare click handler: middle-click, ⌘-click, "copy link
  // address" and the status bar all keep working, and the URL it shows is the
  // same deep link the CLI would have written. The handler only takes over the
  // plain left click, so the app can select the node on the map at the same
  // time as it changes the route.
  return (
    <a
      key={key}
      className="md-link md-link-doc"
      href={formatHash({ kind: 'component', id })}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        if (e.defaultPrevented || e.button !== 0) return;
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        opts.onNavigate?.(id);
      }}
    >
      {inline(text, `${key}-l`, opts)}
    </a>
  );
}

/** Render inline `code`, **bold**, *italic* and [links](…) within a run of text. */
function inline(text: string, keyPrefix: string, opts: LinkOpts = {}): JSX.Element[] {
  const out: JSX.Element[] = [];
  const re = new RegExp(INLINE.source, 'g');
  let last = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      out.push(<span key={`${keyPrefix}-t${n++}`}>{text.slice(last, m.index)}</span>);
    }
    const tok = m[0];
    if (tok.startsWith('`')) {
      out.push(<code key={`${keyPrefix}-c${n++}`}>{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith('[')) {
      out.push(anchor(tok, `${keyPrefix}-a${n++}`, opts));
    } else if (tok.startsWith('**')) {
      out.push(<strong key={`${keyPrefix}-b${n++}`}>{tok.slice(2, -2)}</strong>);
    } else {
      out.push(<em key={`${keyPrefix}-i${n++}`}>{tok.slice(1, -1)}</em>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) {
    out.push(<span key={`${keyPrefix}-t${n++}`}>{text.slice(last)}</span>);
  }
  return out;
}

export interface MarkdownProps {
  source: string;
  /**
   * Anchor ids for the h2/h3 headings, in document order, computed from the
   * ENGLISH source (core's `headingSlugs`). Used only when its length matches
   * the number of headings actually rendered — see the file header.
   */
  headingIds?: string[];
  /** What an href means; `null` renders the label as plain text. */
  resolveLink?: (href: string) => DocLink | null;
  /** Follow a link to another component doc, in-app. */
  onNavigate?: (id: string) => void;
}

export function Markdown({
  source,
  headingIds,
  resolveLink,
  onNavigate,
}: MarkdownProps): JSX.Element {
  // Doc content arrives already in whatever language the panel decided to show
  // (English source, or the per-user translation) — this renderer just draws the
  // string it is handed. The placeholder chrome below is the VIEWER speaking, so
  // it always follows the interaction language.
  const S = useStrings();
  const opts: LinkOpts = { resolveLink, onNavigate };
  const blocks = parse(source);
  const headingCount = blocks.filter((b) => b.kind === 'h2' || b.kind === 'h3').length;
  // The positional mapping is only valid if the body on screen has the same
  // headings as the English one it was derived from. When it does not, drop the
  // ids entirely rather than anchoring `design-decisions` onto some other
  // section: a link that lands at the top of the doc is a disappointment, one
  // that lands on the wrong section is a lie.
  const ids = headingIds && headingIds.length === headingCount ? headingIds : null;
  let headingIndex = 0;

  return (
    <div className="md">
      {blocks.map((b, i) => {
        const key = `b${i}`;
        switch (b.kind) {
          case 'h2':
            return (
              <h2 key={key} id={ids?.[headingIndex++]}>
                {b.text}
              </h2>
            );
          case 'h3':
            return (
              <h3 key={key} id={ids?.[headingIndex++]}>
                {b.text}
              </h3>
            );
          case 'p':
            return <p key={key}>{inline(b.text, key, opts)}</p>;
          case 'list': {
            const items = b.items.map((it, j) => (
              <li key={`${key}-i${j}`}>{inline(it, `${key}-i${j}`, opts)}</li>
            ));
            return b.ordered ? (
              <ol key={key} className="md-list">
                {items}
              </ol>
            ) : (
              <ul key={key} className="md-list">
                {items}
              </ul>
            );
          }
          case 'mermaid':
            return (
              <figure key={key} className="mermaid-placeholder">
                <div className="mermaid-badge">{S.mermaidBadge}</div>
                <pre>{b.code}</pre>
                <figcaption>{S.mermaidTodo}</figcaption>
              </figure>
            );
          case 'code':
            return (
              <pre key={key} className="code-block">
                <code>{b.code}</code>
              </pre>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}
