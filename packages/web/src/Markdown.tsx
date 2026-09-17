import type { JSX } from 'react';
import { useStrings } from './i18n.js';

/**
 * Deliberately minimal markdown renderer for the skeleton — enough for the
 * component doc bodies (headings, paragraphs, inline emphasis/`code`) plus a
 * mermaid placeholder. Full markdown + real mermaid rendering is a TODO for a
 * later phase (PLAN §7.3 "rendered doc (markdown + mermaid)").
 */

type Block =
  | { kind: 'h2'; text: string }
  | { kind: 'h3'; text: string }
  | { kind: 'p'; text: string }
  | { kind: 'mermaid'; code: string }
  | { kind: 'code'; code: string };

function parse(md: string): Block[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];

  const flushPara = () => {
    if (para.length > 0) {
      blocks.push({ kind: 'p', text: para.join(' ').trim() });
      para = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      flushPara();
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
      flushPara();
      blocks.push({ kind: 'h3', text: line.slice(4).trim() });
      continue;
    }
    if (line.startsWith('## ')) {
      flushPara();
      blocks.push({ kind: 'h2', text: line.slice(3).trim() });
      continue;
    }
    if (line.trim() === '') {
      flushPara();
      continue;
    }
    para.push(line.trim());
  }
  flushPara();
  return blocks;
}

/** Render inline `code`, **bold**, and *italic* within a paragraph. */
function inline(text: string, keyPrefix: string): JSX.Element[] {
  const out: JSX.Element[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
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

export function Markdown({ source }: { source: string }): JSX.Element {
  // Doc content arrives already in whatever language the panel decided to show
  // (English source, or the per-user translation) — this renderer just draws the
  // string it is handed. The placeholder chrome below is the VIEWER speaking, so
  // it always follows the interaction language.
  const S = useStrings();
  const blocks = parse(source);
  return (
    <div className="md">
      {blocks.map((b, i) => {
        const key = `b${i}`;
        switch (b.kind) {
          case 'h2':
            return <h2 key={key}>{b.text}</h2>;
          case 'h3':
            return <h3 key={key}>{b.text}</h3>;
          case 'p':
            return <p key={key}>{inline(b.text, key)}</p>;
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
