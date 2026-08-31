/**
 * Paper → prompt grounding: the single rendering of a component paper handed to
 * a model that generates or runs a comprehension check.
 *
 * It lives here, in core, because there were two of these and they had already
 * drifted. Quest generation passed `alternatives`; the web Socratic proxy did
 * not — while the rationale rubric's top band asks the junior to "explain the
 * decision, the rejected alternatives, and the failure mode if reversed". The
 * grader was being asked to score a thing it had never been shown.
 *
 * Both callers now share this, so a future addition reaches every check at once.
 */
import type { LoadedPaper } from './paper-loader.js';
import type { MapJson } from './schema/map.js';

/**
 * Cap on the prose passed through. Bodies here run ~12k characters, so the
 * default clears a typical paper whole; the cap exists so one unusually long
 * paper cannot quietly dominate an intervention-tier request.
 */
export const DEFAULT_MAX_BODY_CHARS = 16_000;

/**
 * Strip the Related Work section from a paper body.
 *
 * It is a list of links to sibling papers — the map's edge data in prose form.
 * It carries no explanation of THIS component, and handing a model a list of
 * neighbour names is exactly the material for "which component does this relate
 * to" lookup items, which test recall rather than understanding.
 */
function withoutRelatedWork(body: string): string {
  return body.replace(/^##\s*Related Work\b[\s\S]*?(?=^##\s|\Z)/gim, '').trim();
}


/** A component's measured dependencies, both directions. */
export interface ComponentNeighbours {
  /** Components this one's code reaches into. */
  dependsOn: string[];
  /** Components whose code reaches into this one. */
  dependedOnBy: string[];
}

/**
 * Index a frozen map's `depends_on` edges by component.
 *
 * `depends_on` ONLY. The `reference` edges are the LLM's Related Work links and
 * sit at ~24% graph density here — nearly everything is a "neighbour" under
 * them, which is no signal at all, and only a quarter of them have any code path
 * behind them. A map with no `depends_on` (no graphify extraction distilled)
 * yields an empty index, and every caller then behaves exactly as before.
 */
export function neighbourIndex(map: MapJson): Map<string, ComponentNeighbours> {
  const index = new Map<string, ComponentNeighbours>();
  const entry = (id: string): ComponentNeighbours => {
    let e = index.get(id);
    if (!e) {
      e = { dependsOn: [], dependedOnBy: [] };
      index.set(id, e);
    }
    return e;
  };
  for (const edge of map.edges) {
    if (edge.kind !== 'depends_on' || edge.from === edge.to) continue;
    const from = entry(edge.from);
    const to = entry(edge.to);
    if (!from.dependsOn.includes(edge.to)) from.dependsOn.push(edge.to);
    if (!to.dependedOnBy.includes(edge.from)) to.dependedOnBy.push(edge.from);
  }
  // Sorted so grounding text is stable across runs.
  for (const e of index.values()) {
    e.dependsOn.sort();
    e.dependedOnBy.sort();
  }
  return index;
}

export interface GroundingOptions {
  /** Include the paper's prose body, not just its frontmatter. Default true. */
  includeBody?: boolean;
  maxBodyChars?: number;
  /** Measured dependencies for THIS component, from {@link neighbourIndex}. */
  neighbours?: ComponentNeighbours;
}

/**
 * Render `paper` as grounding for an item generator or a dialogue grader.
 *
 * The body matters and used to be discarded. `LoadedPaper` carries it already —
 * the seven prose sections, including the hero diagram and the Description that
 * explains the mechanism — and the generator was handed only the frontmatter
 * while being asked to tag items `structure` ("how the component is built").
 * There was no structural material in the prompt at all, so structure items
 * could only ever be guessed from concept names.
 */
export function paperGrounding(paper: LoadedPaper, opts: GroundingOptions = {}): string {
  const { includeBody = true, maxBodyChars = DEFAULT_MAX_BODY_CHARS, neighbours } = opts;
  const fm = paper.frontmatter;

  const concepts =
    fm.concepts.map((c) => `- ${c.name} (id: ${c.id})`).join('\n') || '- (none)';

  const rationale =
    fm.rationale
      .map((r) => {
        const bits = [`decision: ${r.decision}`];
        if (r.why) bits.push(`why: ${r.why}`);
        // Load-bearing for the rationale dimension — see the file header.
        if (r.alternatives) bits.push(`alternatives: ${r.alternatives}`);
        return `- ${bits.join(' | ')}`;
      })
      .join('\n') || '- (none)';

  const parts = [
    `Component: ${fm.title} (id: ${fm.id})`,
    `\nConcepts:\n${concepts}`,
    `\nRationale:\n${rationale}`,
  ];

  if (includeBody) {
    const prose = withoutRelatedWork(paper.body);
    if (prose) {
      const clipped =
        prose.length > maxBodyChars
          ? `${prose.slice(0, maxBodyChars)}\n\n[paper truncated]`
          : prose;
      parts.push(`\nPaper (prose — how it works and why):\n${clipped}`);
    }
  }

  // The dependency block is CONTEXT, not a fact sheet to quiz from. Naming
  // neighbours makes "which component does this use" the cheapest item a model
  // could write, and that scores recall while reading as comprehension — hence
  // the framing here and the explicit prohibition in the callers' prompts.
  if (neighbours && (neighbours.dependsOn.length > 0 || neighbours.dependedOnBy.length > 0)) {
    const lines = ['\nMeasured dependencies (from the code, not from this paper):'];
    if (neighbours.dependsOn.length > 0) {
      lines.push(`  this component's code reaches into: ${neighbours.dependsOn.join(', ')}`);
    }
    if (neighbours.dependedOnBy.length > 0) {
      lines.push(`  code that reaches into it: ${neighbours.dependedOnBy.join(', ')}`);
    }
    lines.push(
      '  Use this to ask what BREAKS if this component changed, or what a caller' +
        ' would observe — never to ask which name is connected to which.',
    );
    parts.push(lines.join('\n'));
  }

  return parts.join('\n');
}
