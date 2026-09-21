import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type { DocIndexEntry, MapJson } from '@scale/core/browser';
import { useStrings } from './i18n.js';

/**
 * The doc browser: every component doc in the repo, grouped by province.
 *
 * WHY IT EXISTS. The map is a good picture and a bad table of contents. To read
 * a doc you first have to find its castle, which means already knowing roughly
 * where it is — fine for the component you were just denied an edit on, useless
 * for "what is in this codebase". A doc's own "Related components" links now
 * carry a reader sideways, but only along edges the doc's author wrote. This is
 * the index those two do not give: an alphabet of the whole repo, one click
 * from any screen.
 *
 * It is a pure browse surface — no coverage, no quests, no state of its own
 * beyond a filter box. Everything it knows comes from `GET /api/docs`, which
 * the shell loads once; province NAMES come from the map, because the index
 * carries province slugs and the map is where their titles live.
 */

interface Props {
  docs: DocIndexEntry[];
  map: MapJson | null;
  /** The doc currently open, marked in the list. */
  selectedId: string | null;
  /** Follow one — a document navigation, so the caller pushes history. */
  onSelect: (id: string) => void;
  onClose: () => void;
}

export function DocsIndex({ docs, map, selectedId, onSelect, onClose }: Props): JSX.Element {
  const S = useStrings();
  const [filter, setFilter] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Opening a list whose first act is usually "find the one I mean" should put
  // the caret where that happens.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const provinceName = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of map?.provinces ?? []) m.set(p.id, p.name);
    return m;
  }, [map]);

  // Grouped, filtered, and ordered the way the index arrives (the server sorts
  // by province then title) so the list does not reshuffle as you type.
  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const out = new Map<string, DocIndexEntry[]>();
    for (const d of docs) {
      if (q && !d.title.toLowerCase().includes(q) && !d.id.toLowerCase().includes(q)) continue;
      const arr = out.get(d.province) ?? [];
      arr.push(d);
      out.set(d.province, arr);
    }
    return [...out.entries()];
  }, [docs, filter]);

  const empty = docs.length === 0;

  return (
    <div className="qr-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="qr-modal docs-modal" onClick={(e) => e.stopPropagation()}>
        <div className="qr-head">
          <div>
            <div className="qr-kicker">
              <span className="qr-kicker-badge docs-badge">📖</span>
              {S.docsIndexTitle}
            </div>
            <div className="qr-id">{S.docsIndexBlurb}</div>
          </div>
          <button
            type="button"
            className="panel-close"
            onClick={onClose}
            aria-label={S.closeDocsIndex}
          >
            ×
          </button>
        </div>

        {empty ? (
          <p className="state-blurb">{S.docsIndexEmpty}</p>
        ) : (
          <>
            <input
              ref={inputRef}
              type="search"
              className="docs-filter"
              placeholder={S.docsIndexFilter}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <div className="docs-body">
              {groups.length === 0 && <p className="state-blurb">{S.docsIndexNoMatch}</p>}
              {groups.map(([province, entries]) => (
                <section key={province} className="docs-group">
                  <h4 className="docs-province">{provinceName.get(province) ?? province}</h4>
                  <ul className="docs-list">
                    {entries.map((d) => (
                      <li key={d.id}>
                        <button
                          type="button"
                          className={`docs-entry${d.id === selectedId ? ' docs-entry-active' : ''}`}
                          onClick={() => onSelect(d.id)}
                        >
                          <span className="docs-entry-title">{d.title}</span>
                          <span className="docs-entry-id">{d.id}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
