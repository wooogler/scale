/**
 * The committed-rendering FILE FORMAT: `README.<lang>.md` next to an English
 * component doc. Pure text in, text out — the CLI owns the filesystem.
 *
 * Why a markdown file with frontmatter rather than a JSON blob: the point of
 * committing a rendering is that people READ it — in the viewer, but also in an
 * editor, in a PR diff, on GitHub. A file that looks exactly like the English
 * doc beside it is reviewable by the same people in the same way.
 *
 * Why the loaders never see it: both doc scanners (core's `loadScaleDir` and the
 * CLI's `scanDocs`) match the file name `readme.md` EXACTLY (case-insensitively),
 * so `README.ko.md` is not a component doc to them. That is load-bearing: a
 * rendering carries the same `id` and `sources` as its English doc, and were it
 * scanned it would register a second component under the same coverage key.
 */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import {
  TranslatedDocFrontmatterSchema,
  type DocFrontmatter,
  type TranslatedDocFrontmatter,
} from './schema/doc.js';

/** The rendering's file name for a language: `README.ko.md`. */
export function translationFileName(lang: string): string {
  return `README.${lang}.md`;
}

/** True for `README.<lang>.md` (any case) — a rendering, never a component doc. */
export function isTranslationFileName(name: string): boolean {
  return /^readme\.[a-z]{2,3}(?:-[a-z0-9]+)?\.md$/i.test(name);
}

export interface CommittedTranslation {
  /** Translation metadata — the five keys the English frontmatter does not have. */
  meta: {
    lang: string;
    sourceLang: 'en';
    sourceSha: string;
    model: string;
    translatedAt: string;
  };
  /** The translated frontmatter in the English doc's own shape. */
  frontmatter: DocFrontmatter;
  /** Markdown body after the frontmatter block. */
  body: string;
}

/**
 * Serialize a rendering. The doc's own keys come first, in the English file's
 * order, so a side-by-side diff of the two lines up; the translation keys
 * follow. `lineWidth: 0` keeps every value on one line — folding a Korean
 * sentence at 80 columns makes a reviewer's diff noisy for no reader's benefit.
 *
 * The body gets a blank line after the closing `---` for an editor's sake; a
 * body that already starts with one is written as-is, so a parse of the result
 * returns it byte for byte.
 */
export function renderCommittedTranslation(t: CommittedTranslation): string {
  const fm = t.frontmatter;
  const record: TranslatedDocFrontmatter = {
    id: fm.id,
    title: fm.title,
    sources: fm.sources,
    concepts: fm.concepts.map((c) => ({ id: c.id, name: c.name })),
    rationale: fm.rationale.map((r) => ({
      decision: r.decision,
      ...(r.why !== undefined ? { why: r.why } : {}),
      ...(r.alternatives !== undefined ? { alternatives: r.alternatives } : {}),
      provenance: r.provenance,
    })),
    lang: t.meta.lang,
    source_lang: t.meta.sourceLang,
    source_sha: t.meta.sourceSha,
    model: t.meta.model,
    translated_at: t.meta.translatedAt,
  };
  const yaml = stringifyYaml(record, { lineWidth: 0 });
  const body = t.body.startsWith('\n') || t.body.startsWith('\r\n') ? t.body : `\n${t.body}`;
  return `---\n${yaml}---\n${body}`;
}

/**
 * Parse a rendering, or null when it is not one. Never throws — a hand-mangled
 * file is a file to ignore (and re-render), not an error to show a reader.
 * The frontmatter split is the doc loader's own, so a rendering parses exactly
 * the way its English doc does.
 */
export function parseCommittedTranslation(text: string): CommittedTranslation | null {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return null;
  try {
    const fm = TranslatedDocFrontmatterSchema.parse(parseYaml(m[1] ?? ''));
    return {
      meta: {
        lang: fm.lang,
        sourceLang: fm.source_lang,
        sourceSha: fm.source_sha,
        model: fm.model,
        translatedAt: fm.translated_at,
      },
      frontmatter: {
        id: fm.id,
        title: fm.title,
        sources: fm.sources,
        concepts: fm.concepts,
        rationale: fm.rationale,
      },
      body: m[2] ?? '',
    };
  } catch {
    return null;
  }
}

/** Why a committed rendering cannot be served for the current English doc. */
export type CommittedTranslationState =
  /** No `README.<lang>.md` at all. */
  | 'missing'
  /**
   * Present but not a rendering of THIS English text: its `source_sha` differs,
   * or it does not parse, or it disagrees with the English doc on a machine
   * field (id, concept ids, entry counts). All of these mean the same thing to a
   * reader and to `map check` — re-render it.
   */
  | 'stale'
  | 'current';

/**
 * Judge a parsed rendering against the English doc it claims to render.
 *
 * The sha is the rule; the structural checks are there for a file someone
 * hand-edited after rendering. A rendering whose concept ids no longer line up
 * with the English ones would put a translated name on the wrong coverage key,
 * which is precisely the kind of wrong that reads fluently.
 */
export function committedTranslationState(
  parsed: CommittedTranslation | null,
  english: DocFrontmatter,
  lang: string,
  sourceSha: string,
): Exclude<CommittedTranslationState, 'missing'> {
  if (!parsed) return 'stale';
  if (parsed.meta.lang !== lang || parsed.meta.sourceSha !== sourceSha) return 'stale';
  const fm = parsed.frontmatter;
  if (fm.id !== english.id) return 'stale';
  if (fm.concepts.length !== english.concepts.length) return 'stale';
  if (fm.rationale.length !== english.rationale.length) return 'stale';
  if (fm.concepts.some((c, i) => c.id !== english.concepts[i]!.id)) return 'stale';
  return 'current';
}
