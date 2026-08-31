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

export interface GroundingOptions {
  /** Include the paper's prose body, not just its frontmatter. Default true. */
  includeBody?: boolean;
  maxBodyChars?: number;
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
  const { includeBody = true, maxBodyChars = DEFAULT_MAX_BODY_CHARS } = opts;
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

  return parts.join('\n');
}
