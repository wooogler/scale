/**
 * Loader for a repo's `.scale/` coverage-memory tree (the artifact the
 * `scale-map` skill produces). Repo-agnostic: given any repo root it walks
 * `<repoRoot>/.scale/`, parses each component paper's YAML frontmatter, and
 * derives the province clustering and the edge graph used by layout + serve.
 *
 * Tree shape (PLAN §4.1, SKILL.md):
 *   .scale/README.md                        → root paper       (depth 0)
 *   .scale/<province>/README.md             → province paper   (depth 1)
 *   .scale/<province>/<component>/README.md → component paper  (depth ≥ 2) → node
 *
 * Only component papers (depth ≥ 2) become map nodes; their frontmatter `id`
 * is the STABLE node key (never the folder slug). Provinces are the first path
 * segment under `.scale/`. Papers with invalid frontmatter are skipped + warned.
 */
import fs from 'node:fs';
import path from 'node:path';

import { parse as parseYaml } from 'yaml';

import {
  PaperFrontmatterSchema,
  type PaperFrontmatter,
} from './schema/paper.js';
import { type Province, type MapEdge } from './schema/map.js';

export interface LoadedPaper {
  /** Stable frontmatter id — the coverage key and map node id. */
  id: string;
  /** Absolute path to the paper's folder. */
  path: string;
  /** Province slug (first path segment under `.scale/`). */
  province: string;
  /** Frontmatter id of the paper in the immediate parent folder, or null. */
  parentId: string | null;
  frontmatter: PaperFrontmatter;
  /** Markdown body after the frontmatter block. */
  body: string;
}

export interface LoadedScale {
  papers: LoadedPaper[];
  provinces: Province[];
  edges: MapEdge[];
  rootPaper?: LoadedPaper;
}

/** Split a README into { frontmatter yaml string | null, body }. */
function splitFrontmatter(text: string): { yaml: string | null; body: string } {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { yaml: null, body: text };
  return { yaml: m[1] ?? '', body: m[2] ?? '' };
}

interface RawReadme {
  absDir: string;
  segments: string[]; // folder path relative to .scale, split
  depth: number;
  yaml: string | null;
  body: string;
}

/** Recursively collect every folder containing a README.md under `.scale/`. */
function collectReadmes(scaleDir: string): RawReadme[] {
  const out: RawReadme[] = [];

  const walk = (dir: string, segments: string[]): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const readme = entries.find(
      (e) => e.isFile() && e.name.toLowerCase() === 'readme.md',
    );
    if (readme) {
      let text = '';
      try {
        text = fs.readFileSync(path.join(dir, readme.name), 'utf8');
      } catch {
        text = '';
      }
      const { yaml, body } = splitFrontmatter(text);
      out.push({ absDir: dir, segments, depth: segments.length, yaml, body });
    }
    for (const e of entries) {
      if (e.isDirectory()) walk(path.join(dir, e.name), [...segments, e.name]);
    }
  };

  walk(scaleDir, []);
  return out;
}

function titleize(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Lenient frontmatter read for province/root orientation papers. */
function lenientTitle(yaml: string | null): string | undefined {
  if (!yaml) return undefined;
  try {
    const obj = parseYaml(yaml) as { title?: unknown } | null;
    if (obj && typeof obj.title === 'string') return obj.title;
  } catch {
    /* ignore */
  }
  return undefined;
}

/** Normalize a slash path: strip `./`, collapse, resolve `..`, drop trailing `/`. */
function normalizeRel(p: string): string {
  const parts: string[] = [];
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/**
 * Extract the markdown links inside a paper's "Related Work" section. Returns
 * the raw link targets (hrefs). Falls back to scanning the whole body if no
 * Related Work heading is found.
 */
function relatedWorkLinks(body: string): string[] {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{1,6}\s+related work\b/i.test(l));
  let scope = body;
  if (start >= 0) {
    const startLevel = /^(#{1,6})/.exec(lines[start] ?? '')?.[1]?.length ?? 2;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      const h = /^(#{1,6})\s+/.exec(lines[i] ?? '');
      if (h && (h[1]?.length ?? 6) <= startLevel) {
        end = i;
        break;
      }
    }
    scope = lines.slice(start + 1, end).join('\n');
  }
  const links: string[] = [];
  const re = /\[[^\]]*\]\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(scope)) !== null) {
    const href = (m[1] ?? '').trim().split(/\s+/)[0];
    if (href) links.push(href);
  }
  return links;
}

/**
 * Load a repo's `.scale/` tree. Repo-agnostic — pass any repo root.
 * Missing `.scale/` yields empty results (no throw).
 */
export function loadScaleDir(repoRoot: string): LoadedScale {
  const scaleDir = path.join(repoRoot, '.scale');
  const readmes = collectReadmes(scaleDir);

  // Index folders by their relative path so both component-parent lookups and
  // Related Work link resolution can map a folder → its frontmatter id.
  const relOfDir = (absDir: string): string =>
    normalizeRel(path.relative(scaleDir, absDir));

  const papers: LoadedPaper[] = [];
  const folderPathToId = new Map<string, string>(); // rel folder → node id
  let rootPaper: LoadedPaper | undefined;

  // First pass: parse component papers (depth ≥ 2) and the root paper.
  for (const r of readmes) {
    if (r.depth === 0) {
      // Root orientation paper — set rootPaper only if it fully validates.
      if (r.yaml) {
        try {
          const fm = PaperFrontmatterSchema.parse(parseYaml(r.yaml));
          rootPaper = {
            id: fm.id,
            path: r.absDir,
            province: '',
            parentId: null,
            frontmatter: fm,
            body: r.body,
          };
        } catch {
          /* root need not validate; ignore */
        }
      }
      continue;
    }
    if (r.depth === 1) continue; // province orientation paper — handled below

    // Component paper.
    if (!r.yaml) {
      console.warn(
        `scale: skipping ${path.join(r.absDir, 'README.md')} — no frontmatter`,
      );
      continue;
    }
    let fm: PaperFrontmatter;
    try {
      fm = PaperFrontmatterSchema.parse(parseYaml(r.yaml));
    } catch (err) {
      console.warn(
        `scale: skipping ${path.join(r.absDir, 'README.md')} — invalid frontmatter: ${
          (err as Error).message.split('\n')[0]
        }`,
      );
      continue;
    }
    const province = r.segments[0] ?? '';
    papers.push({
      id: fm.id,
      path: r.absDir,
      province,
      parentId: null, // resolved in second pass
      frontmatter: fm,
      body: r.body,
    });
    folderPathToId.set(relOfDir(r.absDir), fm.id);
  }

  const nodeIds = new Set(papers.map((p) => p.id));

  // Resolve parentId from folder nesting (parent folder's node id, if any).
  for (const p of papers) {
    const parentRel = normalizeRel(relOfDir(p.path).split('/').slice(0, -1).join('/'));
    p.parentId = folderPathToId.get(parentRel) ?? null;
  }

  // Provinces: one per distinct first path segment, sorted for stability.
  const provinceTitles = new Map<string, string>();
  for (const r of readmes) {
    if (r.depth === 1) {
      const slug = r.segments[0]!;
      provinceTitles.set(slug, lenientTitle(r.yaml) ?? titleize(slug));
    }
  }
  const provinceSlugs = new Set<string>(papers.map((p) => p.province));
  for (const slug of provinceTitles.keys()) provinceSlugs.add(slug);
  const provinces: Province[] = [...provinceSlugs]
    .filter(Boolean)
    .sort()
    .map((slug) => ({ id: slug, name: provinceTitles.get(slug) ?? titleize(slug) }));

  // Edges.
  const edgeKey = (e: MapEdge): string => `${e.from}|${e.to}|${e.kind}`;
  const seen = new Set<string>();
  const edges: MapEdge[] = [];
  const pushEdge = (e: MapEdge): void => {
    if (e.from === e.to) return;
    const k = edgeKey(e);
    if (seen.has(k)) return;
    seen.add(k);
    edges.push(e);
  };

  // Hierarchy edges: parent/child between nested component nodes.
  for (const p of papers) {
    if (p.parentId && nodeIds.has(p.parentId)) {
      pushEdge({ from: p.parentId, to: p.id, kind: 'hierarchy' });
    }
  }

  // Reference edges: Related Work links resolving to another node's folder.
  for (const p of papers) {
    for (const href of relatedWorkLinks(p.body)) {
      const targetRel = normalizeRel(
        path.posix.join(relOfDir(p.path), href.replace(/#.*$/, '')),
      );
      const targetId = folderPathToId.get(targetRel);
      if (targetId && targetId !== p.id) {
        pushEdge({ from: p.id, to: targetId, kind: 'reference' });
      }
    }
  }

  return { papers, provinces, edges, rootPaper };
}

/** Find a loaded paper (component or root) by its stable id. */
export function paperById(loaded: LoadedScale, id: string): LoadedPaper | undefined {
  if (loaded.rootPaper?.id === id) return loaded.rootPaper;
  return loaded.papers.find((p) => p.id === id);
}

/**
 * Project component papers into the `{ id, sources }[]` shape that
 * `buildFileComponentIndex` consumes.
 */
export function componentSourcesIndex(
  loaded: LoadedScale,
): { id: string; sources: string[] }[] {
  return loaded.papers.map((p) => ({
    id: p.frontmatter.id,
    sources: p.frontmatter.sources,
  }));
}
