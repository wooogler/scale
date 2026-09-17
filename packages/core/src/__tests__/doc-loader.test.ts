import { describe, it, expect, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  loadScaleDir,
  docById,
  componentSourcesIndex,
  buildFileComponentIndex,
} from '../index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', '..', 'fixtures');
const sampleRoot = join(fixtures, 'scale-sample');

describe('loadScaleDir', () => {
  const loaded = loadScaleDir(sampleRoot);

  it('parses 2 provinces with names from province READMEs', () => {
    expect(loaded.provinces.map((p) => p.id)).toEqual(['auth', 'docs']);
    expect(loaded.provinces.find((p) => p.id === 'auth')?.name).toBe('Authentication');
  });

  it('parses 6 component docs keyed by stable frontmatter id', () => {
    expect(loaded.docs).toHaveLength(6);
    const ids = loaded.docs.map((d) => d.id).sort();
    expect(ids).toEqual([
      'comments',
      'document-model',
      'oauth-login',
      'password-hashing',
      'session-management',
      'sharing',
    ]);
  });

  it('assigns each component to its province via folder nesting', () => {
    const sm = docById(loaded, 'session-management');
    expect(sm?.province).toBe('auth');
    expect(sm?.frontmatter.title).toBe('Session Management');
  });

  it('builds 9 reference edges from related-component links (deduped, cross-province)', () => {
    expect(loaded.edges).toHaveLength(9);
    expect(loaded.edges.every((e) => e.kind === 'reference')).toBe(true);
    expect(loaded.edges).toContainEqual({
      from: 'sharing',
      to: 'session-management',
      kind: 'reference',
    });
    expect(loaded.edges).toContainEqual({
      from: 'session-management',
      to: 'sharing',
      kind: 'reference',
    });
  });

  it('exposes the root doc', () => {
    expect(loaded.rootDoc?.id).toBe('realm-root');
  });

  it('componentSourcesIndex feeds buildFileComponentIndex', () => {
    const idx = componentSourcesIndex(loaded);
    expect(idx).toHaveLength(6);
    const fileIndex = buildFileComponentIndex(idx);
    expect(fileIndex['src/server/auth/sessions.ts']).toEqual(['session-management']);
  });

  it('returns empty results for a repo with no .scale/', () => {
    const empty = loadScaleDir(join(here, 'does-not-exist'));
    expect(empty.docs).toHaveLength(0);
    expect(empty.provinces).toHaveLength(0);
    expect(empty.edges).toHaveLength(0);
  });
});

/**
 * The same component doc under both heading vocabularies.
 *
 * `.scale/` trees built before the rename are still on disk, in repos this code
 * does not control, and they are never rewritten. A doc that stops parsing is
 * not a cosmetic regression: the component drops out of the map, out of the
 * file→component index, and out of the gate. So the legacy academic headings
 * are not deprecated — they are aliases, and these two fixtures are the same
 * doc written each way.
 */
describe('loadScaleDir — legacy and current headings load identically', () => {
  const temps: string[] = [];

  /** Build a throwaway `.scale/` tree whose session-management doc is `body`. */
  const repoFrom = (docFile: string): string => {
    const root = mkdtempSync(join(tmpdir(), 'scale-doc-'));
    temps.push(root);
    const auth = join(root, '.scale', 'auth');
    mkdirSync(join(auth, 'session-management'), { recursive: true });
    mkdirSync(join(auth, 'sharing'), { recursive: true });
    mkdirSync(join(auth, 'password-hashing'), { recursive: true });
    writeFileSync(
      join(auth, 'session-management', 'README.md'),
      readFileSync(join(fixtures, docFile), 'utf8'),
    );
    const stub = (id: string, title: string): string =>
      `---\nid: ${id}\ntitle: ${title}\nsources: []\nconcepts: []\nrationale: []\n---\n\nstub\n`;
    writeFileSync(join(auth, 'sharing', 'README.md'), stub('sharing', 'Document Sharing'));
    writeFileSync(
      join(auth, 'password-hashing', 'README.md'),
      stub('password-hashing', 'Password Hashing'),
    );
    return root;
  };

  afterAll(() => {
    for (const t of temps) rmSync(t, { recursive: true, force: true });
  });

  const current = loadScaleDir(repoFrom('sample-doc.md'));
  const legacy = loadScaleDir(repoFrom('legacy-doc.md'));

  it('`## Related components` yields the reference edges the old heading did', () => {
    expect(current.edges).toContainEqual({
      from: 'session-management',
      to: 'sharing',
      kind: 'reference',
    });
    expect(current.edges).toContainEqual({
      from: 'session-management',
      to: 'password-hashing',
      kind: 'reference',
    });
  });

  it('produces the same provinces, ids and edges from either spelling', () => {
    expect(legacy.edges).toEqual(current.edges);
    expect(legacy.provinces).toEqual(current.provinces);
    expect(legacy.docs.map((d) => d.id)).toEqual(current.docs.map((d) => d.id));
  });
});
