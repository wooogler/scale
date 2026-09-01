#!/usr/bin/env node
/**
 * Distill a graphify AST graph into `.scale/deps.json` — the component-level
 * dependency edges the frozen map consumes as `depends_on` (PLAN-GRAPHIFY P1).
 *
 * WHY THIS EXISTS
 * `map.json`'s `importance` is the in-degree of its `reference` edges, and those
 * edges are the markdown links an LLM wrote in each paper's Related Work
 * section. The fidelity report measured them: of 207 linked component pairs,
 * only 51 have any code path behind them — 24.6% precision — and yet that graph
 * decides node size on the map, the gate's candidate ranking, and quest
 * selection. This script produces the measured half of that picture.
 *
 * WHAT IT IS NOT
 * It does not replace the LLM's links. Both edge kinds live in `map.json`
 * together, because the difference between them is itself the finding.
 *
 * SENIOR-SIDE ONLY. Run at build/sync time on a machine that has graphify; the
 * junior's hot path only ever reads the committed JSON this writes.
 *
 *   graphify extract . --code-only     # local, deterministic, no API key
 *   node scripts/distill-graph.mjs     # -> .scale/deps.json
 *   scale map layout                   # merges it as depends_on edges
 *
 * Flags: --graph <path>  (default graphify-out/graph.json)
 *        --out <path>    (default .scale/deps.json)
 *        --dry-run       print the summary, write nothing
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const TOOLCHAIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The repository being analysed. Defaults to this one; `--root <dir>` points the
 * distiller at any other checkout that has a `.scale/` (PLAN-GRAPHIFY §9.5 —
 * a second repo is what turns one precision number into a measurement).
 */
function rootArg() {
  const i = process.argv.indexOf('--root');
  const v = i >= 0 ? process.argv[i + 1] : null;
  return v && !v.startsWith('--') ? path.resolve(v) : TOOLCHAIN;
}
const ROOT = rootArg();
const SELF = 'distill-graph';

class DistillError extends Error {}

function die(msg, hint) {
  throw new DistillError(hint ? `${msg}\n  ${hint}` : msg);
}

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

/** Forward slashes, no leading './', no trailing '/' — the index's key shape. */
function normalizePath(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

/**
 * graphify's `source_file` spelling depends on the directory it was invoked
 * from, and nothing pins it. An absolute path matches no repo-relative index
 * key, so without this the entire graph silently evaporates into "unattributed"
 * and the output would be an empty — but confidently written — deps.json.
 */
function toRepoRelative(sourceFile) {
  const raw = String(sourceFile);
  if (!path.isAbsolute(raw)) return normalizePath(raw);
  const rel = path.relative(ROOT, path.resolve(raw));
  return rel && !rel.startsWith('..') ? normalizePath(rel) : normalizePath(raw);
}

// ---------------------------------------------------------------------------
// inputs
// ---------------------------------------------------------------------------

function loadCore() {
  const entry = path.join(TOOLCHAIN, 'packages', 'core', 'dist', 'index.js');
  if (!fs.existsSync(entry)) {
    die(
      'cannot import @scale/core (packages/core/dist is missing).',
      'Run `npm install && npm run build`, then retry.',
    );
  }
  return import(entry);
}

/**
 * graphify writes NetworkX node-link JSON: the edge array is `links`, not
 * `edges`. Both are accepted because the key has moved before.
 */
function readGraph(graphPath) {
  let raw;
  try {
    raw = fs.readFileSync(graphPath, 'utf8');
  } catch {
    die(
      `no graph at ${path.relative(ROOT, graphPath)}.`,
      'Run `graphify extract . --code-only` first (local, no API key needed).',
    );
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    die(`${path.relative(ROOT, graphPath)} is not valid JSON — ${err.message}`);
  }
  const nodes = Array.isArray(data?.nodes) ? data.nodes : null;
  const links = Array.isArray(data?.links)
    ? data.links
    : Array.isArray(data?.edges)
      ? data.edges
      : null;
  if (!nodes || !links) {
    die(
      `${path.relative(ROOT, graphPath)} has no { nodes, links } arrays.`,
      'Expected graphify node-link JSON.',
    );
  }
  return { nodes, links, builtAtCommit: typeof data.built_at_commit === 'string' ? data.built_at_commit : null };
}

function graphifyVersion() {
  try {
    return execFileSync('graphify', ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null; // not installed here; the graph may have come from elsewhere
  }
}

// ---------------------------------------------------------------------------
// distillation
// ---------------------------------------------------------------------------

async function distill(graphPath) {
  const { loadScaleDir, componentSourcesIndex, buildFileComponentIndex } = await loadCore();

  const loaded = loadScaleDir(ROOT);
  if (loaded.papers.length === 0) {
    die('no coverage memory at .scale/ — nothing to attribute edges to.');
  }
  // EXACT matching only. `componentsForFile`'s nearest-directory fallback maps a
  // single unclaimed file onto 6-11 components here, which would manufacture
  // dependencies that exist in no code — the opposite of this script's purpose.
  const index = buildFileComponentIndex(componentSourcesIndex(loaded));
  const ownersOf = (file) => index[file] ?? [];

  const { nodes, links, builtAtCommit } = readGraph(graphPath);

  // node id -> owning component ids
  const nodeOwners = new Map();
  const unattributed = new Set();
  let nodesWithSource = 0;
  for (const n of nodes) {
    if (!n || n.id === undefined || n.id === null) continue;
    // source_file is the only reliable path: node ids are lossy slugs and must
    // never be reversed into one.
    if (!n.source_file) continue;
    nodesWithSource++;
    const file = toRepoRelative(n.source_file);
    const owners = ownersOf(file);
    if (owners.length === 0) {
      unattributed.add(file);
      continue;
    }
    nodeOwners.set(n.id, owners);
  }

  if (nodesWithSource > 0 && nodeOwners.size === 0) {
    die(
      'not one graph node maps to a component.',
      'The graph was probably extracted from a different directory, or .scale/ ' +
        'anchors paths in a different spelling. Refusing to write an empty deps.json.',
    );
  }

  // Directed component pairs. `depends_on` means "this component's code reaches
  // into that one", and `importance` is in-degree, so direction is load-bearing
  // and must survive — unlike the fidelity report, which compares against
  // undirected Related Work links.
  const pairs = new Map(); // "from\u0000to" -> {count, extracted, inferred, ambiguous}
  let linksTotal = 0;
  let linksSkipped = 0;
  let linksIntra = 0;

  for (const link of links) {
    if (!link) continue;
    linksTotal++;
    if (link.source === link.target) {
      linksSkipped++;
      continue;
    }
    const from = nodeOwners.get(link.source);
    const to = nodeOwners.get(link.target);
    if (!from || !to) {
      linksSkipped++;
      continue;
    }
    // A non-empty intersection does NOT make the edge purely internal: it only
    // means some component contains both ends. Every component on one side that
    // is absent from the other still has a real crossing, so the differences are
    // what count. Identical owner sets yield two empty differences and therefore
    // no edges, which is what keeps a file-internal call inside a six-component
    // file from inventing dependencies.
    const onlyFrom = from.filter((c) => !to.includes(c));
    const onlyTo = to.filter((c) => !from.includes(c));
    if (onlyFrom.length === 0 || onlyTo.length === 0) {
      linksIntra++;
      continue;
    }
    const confidence = String(link.confidence ?? 'unknown');
    for (const a of onlyFrom) {
      for (const b of onlyTo) {
        const key = `${a}\u0000${b}`;
        const agg = pairs.get(key) ?? { count: 0, extracted: 0, inferred: 0, ambiguous: 0 };
        agg.count++;
        if (confidence === 'EXTRACTED') agg.extracted++;
        else if (confidence === 'INFERRED') agg.inferred++;
        else if (confidence === 'AMBIGUOUS') agg.ambiguous++;
        pairs.set(key, agg);
      }
    }
  }

  // Deterministic: same graph + same papers -> byte-identical file.
  const edges = [...pairs.entries()]
    .map(([key, agg]) => {
      const [from, to] = key.split('\u0000');
      return { from, to, ...agg };
    })
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0));

  return {
    deps: {
      // Provenance, so a stale deps.json is recognizable rather than silently
      // authoritative. `graphifyVersion` is null when graphify is not installed
      // on the machine doing the distillation.
      builtFromSha: builtAtCommit,
      graphifyVersion: graphifyVersion(),
      distilledFrom: normalizePath(path.relative(ROOT, graphPath)),
      edges,
    },
    stats: {
      components: loaded.papers.length,
      nodes: nodes.length,
      nodesWithSource,
      nodesAttributed: nodeOwners.size,
      unattributedFiles: unattributed.size,
      linksTotal,
      linksSkipped,
      linksIntra,
      pairs: edges.length,
    },
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  if (!v || v.startsWith('--')) die(`--${name} needs a value.`);
  return v;
}

async function main() {
  const graphPath = path.resolve(ROOT, arg('graph', 'graphify-out/graph.json'));
  const outPath = path.resolve(ROOT, arg('out', '.scale/deps.json'));
  const dryRun = process.argv.includes('--dry-run');

  const { deps, stats } = await distill(graphPath);

  const pad = (n) => String(n).padStart(6);
  console.log(`${SELF} — component dependencies from ${deps.distilledFrom}`);
  console.log(`  components        ${pad(stats.components)}`);
  console.log(`  graph nodes       ${pad(stats.nodes)}  (${stats.nodesWithSource} with a source file, ${stats.nodesAttributed} attributed)`);
  console.log(`  graph edges       ${pad(stats.linksTotal)}  (${stats.linksIntra} internal, ${stats.linksSkipped} skipped)`);
  console.log(`  depends_on pairs  ${pad(stats.pairs)}`);
  if (stats.unattributedFiles > 0) {
    console.log(
      `  note: ${stats.unattributedFiles} source file(s) belong to no component — ` +
        'their edges are dropped. `npm run check:map` lists them.',
    );
  }

  if (dryRun) {
    console.log('  --dry-run: nothing written.');
    return;
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(deps, null, 2) + '\n');
  console.log(`  wrote ${normalizePath(path.relative(ROOT, outPath))}`);
  console.log('  next: `scale map layout` to merge these as depends_on edges.');
}

main().catch((err) => {
  if (err instanceof DistillError) {
    console.error(`${SELF} — error: ${err.message}`);
  } else {
    console.error(`${SELF} — unexpected failure: ${err?.stack ?? err}`);
  }
  process.exitCode = 1;
});
