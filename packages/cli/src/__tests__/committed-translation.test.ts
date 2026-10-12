/**
 * Committed renderings (`README.<lang>.md`): the lookup order inside
 * `translateDoc`, and the `scale doc translate` accounting.
 *
 * The lookup order is the contract both the viewer and `scale doc show` rely
 * on — committed beats the reader's cache beats the model, and a committed file
 * that renders an OLDER English doc is skipped, never served. As in
 * translate.test.ts no provider is ever called: `chatText` is stubbed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ScaleConfigSchema,
  loadScaleDir,
  docById,
  parseCommittedTranslation,
  type LoadedDoc,
} from '@scale/core';

const chatTextMock = vi.fn<(req: Record<string, unknown>) => Promise<string>>();

// MissingKeyError must stay the REAL class (translate.ts uses `instanceof`).
vi.mock('../llm.js', async (importActual) => {
  const actual = await importActual<typeof import('../llm.js')>();
  return { ...actual, chatText: (req: Record<string, unknown>) => chatTextMock(req) };
});

const {
  translateDoc,
  renderCommittedTranslations,
  readCommittedTranslation,
  writeCommittedTranslation,
  committedTranslationGaps,
  committedTranslationPath,
  sourceShaOf,
  provenanceLine,
} = await import('../translate.js');
const { MissingKeyError } = await import('../llm.js');
const { scanDocs } = await import('../state.js');

const config = ScaleConfigSchema.parse({ user: 'tester' });

let repo: string;
let dir: string;

function writeDoc(id: string, title = id): void {
  const d = path.join(repo, '.scale', 'prov', id);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(
    path.join(d, 'README.md'),
    [
      '---',
      `id: ${id}`,
      `title: ${title}`,
      'sources:',
      `  - src/${id}.ts`,
      'concepts:',
      '  - id: c1',
      '    name: The idea',
      'rationale:',
      '  - decision: Do it this way',
      '    why: Because',
      '    provenance: inferred',
      '---',
      '',
      `# ${title}`,
      '',
      'The English body.',
      '',
    ].join('\n'),
  );
}

function load(id: string): LoadedDoc {
  const found = docById(loadScaleDir(repo), id);
  if (!found) throw new Error(`fixture doc ${id} did not load`);
  return found;
}

function reply(title: string, body: string): string {
  return JSON.stringify({
    title,
    concepts: [{ id: 'c1', name: '아이디어' }],
    rationale: [{ decision: '이렇게', why: '왜냐하면' }],
    body,
  });
}

/** Commit a rendering of the doc's CURRENT English bytes, as `doc translate` would. */
function commit(doc: LoadedDoc, title: string, body: string, sha = sourceShaOf(doc)): void {
  writeCommittedTranslation(doc, 'ko', {
    frontmatter: {
      ...doc.frontmatter,
      title,
      concepts: [{ id: 'c1', name: '커밋된 아이디어' }],
      rationale: [{ decision: '커밋된 결정', why: '커밋된 이유', provenance: 'inferred' }],
    },
    body,
    model: 'committed-model',
    sourceSha: sha,
    translatedAt: '2026-10-11T00:00:00.000Z',
  });
}

beforeEach(() => {
  chatTextMock.mockReset();
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'scale-committed-repo-'));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scale-committed-state-'));
  writeDoc('alpha');
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the file on disk', () => {
  it('write → read round-trips through the real file, next to the English doc', () => {
    const doc = load('alpha');
    commit(doc, '알파', '\n# 알파\n\n본문.\n');
    const file = committedTranslationPath(doc, 'ko');
    expect(path.basename(file)).toBe('README.ko.md');
    expect(path.dirname(file)).toBe(doc.path);

    const hit = readCommittedTranslation(doc, 'ko');
    expect(hit.state).toBe('current');
    expect(hit.translation!.frontmatter.title).toBe('알파');
    expect(hit.translation!.body).toBe('\n# 알파\n\n본문.\n');
    expect(hit.translation!.meta).toMatchObject({
      lang: 'ko',
      sourceLang: 'en',
      sourceSha: sourceShaOf(doc),
      model: 'committed-model',
    });
    // No temp file left behind to be `git add`ed by accident.
    expect(fs.readdirSync(doc.path).sort()).toEqual(['README.ko.md', 'README.md']);
  });

  it('missing / stale are told apart', () => {
    const doc = load('alpha');
    expect(readCommittedTranslation(doc, 'ko').state).toBe('missing');
    commit(doc, '알파', '본문.');
    writeDoc('alpha', 'Alpha, revised'); // the English moves on
    expect(readCommittedTranslation(load('alpha'), 'ko').state).toBe('stale');
    fs.writeFileSync(committedTranslationPath(doc, 'ko'), 'not a rendering at all');
    expect(readCommittedTranslation(load('alpha'), 'ko').state).toBe('stale');
  });

  it("the CLI's own scanner (map index) ignores README.ko.md as well", () => {
    const before = scanDocs(path.join(repo, '.scale'));
    commit(load('alpha'), '알파', '본문.');
    expect(scanDocs(path.join(repo, '.scale'))).toEqual(before);
    expect(before).toEqual([{ id: 'alpha', sources: ['src/alpha.ts'] }]);
  });
});

describe('translateDoc — lookup order', () => {
  it('a current committed rendering beats the cache and the model, with NO key', async () => {
    // Prime the reader's cache first, so the committed file has something to beat.
    chatTextMock.mockResolvedValue(reply('캐시 알파', '캐시 본문.'));
    const primed = await translateDoc({ doc: load('alpha'), lang: 'ko', config, dir });
    expect(primed.translated && primed.source).toBe('llm');

    commit(load('alpha'), '커밋 알파', '\n커밋 본문.\n');
    chatTextMock.mockReset();
    chatTextMock.mockRejectedValue(new MissingKeyError('anthropic'));

    const r = await translateDoc({ doc: load('alpha'), lang: 'ko', config, dir });
    expect(r.translated).toBe(true);
    if (!r.translated) return;
    expect(r.source).toBe('committed');
    expect(r.cached).toBe(true);
    expect(r.model).toBe('committed-model');
    expect(r.frontmatter.title).toBe('커밋 알파');
    expect(r.frontmatter.concepts).toEqual([{ id: 'c1', name: '커밋된 아이디어' }]);
    expect(r.body).toBe('\n커밋 본문.\n');
    expect(chatTextMock).not.toHaveBeenCalled();
  });

  it('the cache beats the model', async () => {
    chatTextMock.mockResolvedValue(reply('캐시 알파', '캐시 본문.'));
    await translateDoc({ doc: load('alpha'), lang: 'ko', config, dir });
    const r = await translateDoc({ doc: load('alpha'), lang: 'ko', config, dir });
    expect(r.translated && r.source).toBe('cache');
    expect(chatTextMock).toHaveBeenCalledTimes(1);
  });

  it('a STALE committed rendering is skipped, never served', async () => {
    commit(load('alpha'), '옛 알파', '옛 본문.');
    writeDoc('alpha', 'Alpha, revised');
    chatTextMock.mockResolvedValue(reply('새 알파', '새 본문.'));
    const r = await translateDoc({ doc: load('alpha'), lang: 'ko', config, dir });
    expect(r.translated && r.source).toBe('llm');
    expect(r.frontmatter.title).toBe('새 알파');

    // …and with no key, a stale file still is not the fallback: English is.
    fs.rmSync(path.join(dir, 'translations'), { recursive: true, force: true });
    chatTextMock.mockRejectedValue(new MissingKeyError('anthropic'));
    const offline = await translateDoc({ doc: load('alpha'), lang: 'ko', config, dir });
    expect(offline.translated).toBe(false);
    expect(!offline.translated && offline.error?.code).toBe('missing-key');
    expect(offline.frontmatter.title).toBe('Alpha, revised');
  });

  it('refresh skips the committed rendering too', async () => {
    commit(load('alpha'), '커밋 알파', '커밋 본문.');
    chatTextMock.mockResolvedValue(reply('새 알파', '새 본문.'));
    const r = await translateDoc({ doc: load('alpha'), lang: 'ko', config, dir, refresh: true });
    expect(r.translated && r.source).toBe('llm');
    expect(chatTextMock).toHaveBeenCalledTimes(1);
  });

  it('machine fields come from the ENGLISH doc even if the committed file was edited', async () => {
    const doc = load('alpha');
    commit(doc, '알파', '본문.');
    const file = committedTranslationPath(doc, 'ko');
    // Hand-edit `sources` and a provenance in the committed file — the sha in it
    // still matches, so the file is served, but those fields are not read.
    const edited = fs
      .readFileSync(file, 'utf8')
      .replace('  - src/alpha.ts', '  - src/evil.ts')
      .replace('provenance: inferred', 'provenance: forged');
    fs.writeFileSync(file, edited);
    const r = await translateDoc({ doc: load('alpha'), lang: 'ko', config, dir });
    expect(r.translated && r.source).toBe('committed');
    expect(r.frontmatter.sources).toEqual(['src/alpha.ts']);
    expect(r.frontmatter.rationale[0]!.provenance).toBe('inferred');
  });
});

describe('renderCommittedTranslations — `scale doc translate` accounting', () => {
  beforeEach(() => {
    writeDoc('beta');
    writeDoc('gamma');
  });

  it('up-to-date costs nothing; missing and stale are written; a failure is reported and the run continues', async () => {
    commit(load('alpha'), '알파', '본문.'); // current
    commit(load('beta'), '베타', '본문.');
    writeDoc('beta', 'Beta, revised'); // → stale
    // gamma: missing

    // beta succeeds, gamma's reply is garbage.
    chatTextMock.mockImplementation(async (req) => {
      const text = JSON.stringify(req);
      return text.includes('Beta, revised') ? reply('베타 개정', '새 본문.') : 'not json at all';
    });

    const lines: string[] = [];
    const docs = loadScaleDir(repo).docs.sort((a, b) => a.id.localeCompare(b.id));
    const report = await renderCommittedTranslations({
      docs,
      lang: 'ko',
      config,
      dir,
      onOutcome: (o) => lines.push(`${o.id} ${o.status}`),
      now: () => new Date('2026-10-11T12:00:00.000Z'),
    });

    expect(report).toEqual({
      lang: 'ko',
      written: ['beta'],
      upToDate: ['alpha'],
      failed: [{ id: 'gamma', error: expect.stringContaining('not JSON') }],
    });
    expect(lines).toEqual(['alpha up-to-date', 'beta written', 'gamma failed']);
    expect(chatTextMock).toHaveBeenCalledTimes(2); // beta + gamma, never alpha

    // What was written is a current rendering of the NEW English bytes.
    const beta = load('beta');
    const written = parseCommittedTranslation(
      fs.readFileSync(committedTranslationPath(beta, 'ko'), 'utf8'),
    )!;
    expect(written.meta.sourceSha).toBe(sourceShaOf(beta));
    expect(written.meta.translatedAt).toBe('2026-10-11T12:00:00.000Z');
    expect(written.frontmatter.title).toBe('베타 개정');
    expect(readCommittedTranslation(beta, 'ko').state).toBe('current');
    // A failed doc leaves no file behind.
    expect(fs.existsSync(committedTranslationPath(load('gamma'), 'ko'))).toBe(false);

    expect(committedTranslationGaps(loadScaleDir(repo).docs, 'ko')).toEqual({
      missing: ['gamma'],
      stale: [],
    });
  });

  it("reuses the lead's per-user cache: a doc already read in Korean is written with no call", async () => {
    chatTextMock.mockResolvedValue(reply('알파', '본문.'));
    await translateDoc({ doc: load('alpha'), lang: 'ko', config, dir });
    chatTextMock.mockReset();
    const report = await renderCommittedTranslations({ docs: [load('alpha')], lang: 'ko', config, dir });
    expect(report.written).toEqual(['alpha']);
    expect(chatTextMock).not.toHaveBeenCalled();
  });

  it('--refresh re-renders an up-to-date file and bypasses the cache', async () => {
    commit(load('alpha'), '옛 알파', '본문.');
    chatTextMock.mockResolvedValue(reply('새 알파', '새 본문.'));
    const report = await renderCommittedTranslations({
      docs: [load('alpha')],
      lang: 'ko',
      config,
      dir,
      refresh: true,
    });
    expect(report.written).toEqual(['alpha']);
    expect(chatTextMock).toHaveBeenCalledTimes(1);
    expect(readCommittedTranslation(load('alpha'), 'ko').translation!.frontmatter.title).toBe('새 알파');
  });

  it('no key → every doc fails with the reason, nothing is written', async () => {
    chatTextMock.mockRejectedValue(new MissingKeyError('anthropic'));
    const report = await renderCommittedTranslations({
      docs: loadScaleDir(repo).docs,
      lang: 'ko',
      config,
      dir,
    });
    expect(report.written).toEqual([]);
    expect(report.failed.map((f) => f.id).sort()).toEqual(['alpha', 'beta', 'gamma']);
    expect(committedTranslationGaps(loadScaleDir(repo).docs, 'ko').missing).toHaveLength(3);
  });
});

describe('provenanceLine (`scale doc show`)', () => {
  it('names each source, and the fallback reason', () => {
    const fm = { id: 'a', title: 'A', sources: [], concepts: [], rationale: [] };
    const ok = (source: 'committed' | 'cache' | 'llm') =>
      provenanceLine(
        { translated: true, cached: source !== 'llm', source, model: 'm', frontmatter: fm, body: '' },
        'ko',
      );
    expect(ok('committed')).toBe('(ko · committed README.ko.md · m)');
    expect(ok('cache')).toBe('(ko · your cached translation · m)');
    expect(ok('llm')).toBe('(ko · freshly translated · m)');
    expect(
      provenanceLine(
        {
          translated: false,
          error: { code: 'missing-key', message: 'no key' },
          frontmatter: fm,
          body: '',
        },
        'ko',
      ),
    ).toBe('(English source — no key)');
    expect(provenanceLine({ translated: false, frontmatter: fm, body: '' }, 'en')).toBe(
      '(English source)',
    );
  });
});
