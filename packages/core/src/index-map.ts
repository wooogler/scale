/**
 * File → component reverse index (regenerated on demand; gitignored as
 * `.scale/index.json`). Built from every component doc's `sources`.
 */

export type FileComponentIndex = Record<string, string[]>;

/** Build the reverse index: source file path → componentIds that anchor it. */
export function buildFileComponentIndex(
  docs: { id: string; sources: string[] }[],
): FileComponentIndex {
  const index: FileComponentIndex = {};
  for (const doc of docs) {
    for (const source of doc.sources) {
      const key = normalizePath(source);
      const bucket = index[key];
      if (bucket) {
        if (!bucket.includes(doc.id)) bucket.push(doc.id);
      } else {
        index[key] = [doc.id];
      }
    }
  }
  return index;
}

/**
 * Resolve the components for a file path.
 *  1. Exact match on the indexed path.
 *  2. Fallback (§10): nearest ancestor directory that any indexed source lives
 *     in — covers new files that no `sources` list yet mentions.
 * Returns [] when nothing matches.
 */
export function componentsForFile(index: FileComponentIndex, filePath: string): string[] {
  const target = normalizePath(filePath);

  const exact = index[target];
  if (exact) return exact;

  // Nearest-directory fallback: find the indexed source sharing the longest
  // directory prefix with the target.
  const targetDir = dirOf(target);
  let bestLen = -1;
  const best: string[] = [];
  for (const [source, ids] of Object.entries(index)) {
    const sourceDir = dirOf(source);
    const shared = sharedPrefixLength(targetDir, sourceDir);
    if (shared > bestLen) {
      bestLen = shared;
      best.length = 0;
      for (const id of ids) if (!best.includes(id)) best.push(id);
    } else if (shared === bestLen && shared >= 0) {
      for (const id of ids) if (!best.includes(id)) best.push(id);
    }
  }
  // Require at least a shared top-level directory segment to avoid matching
  // completely unrelated trees.
  return bestLen > 0 ? best : [];
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function dirOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

/** Length (in path segments) of the shared leading directory prefix. */
function sharedPrefixLength(a: string, b: string): number {
  if (a === '' || b === '') return 0;
  const as = a.split('/');
  const bs = b.split('/');
  let n = 0;
  const max = Math.min(as.length, bs.length);
  while (n < max && as[n] === bs[n]) n++;
  return n;
}
