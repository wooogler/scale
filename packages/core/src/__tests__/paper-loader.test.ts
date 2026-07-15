import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  loadScaleDir,
  paperById,
  componentSourcesIndex,
  buildFileComponentIndex,
} from '../index.js';

const here = dirname(fileURLToPath(import.meta.url));
const sampleRoot = join(here, '..', '..', 'fixtures', 'scale-sample');

describe('loadScaleDir', () => {
  const loaded = loadScaleDir(sampleRoot);

  it('parses 2 provinces with names from province READMEs', () => {
    expect(loaded.provinces.map((p) => p.id)).toEqual(['auth', 'docs']);
    expect(loaded.provinces.find((p) => p.id === 'auth')?.name).toBe('Authentication');
  });

  it('parses 6 component papers keyed by stable frontmatter id', () => {
    expect(loaded.papers).toHaveLength(6);
    const ids = loaded.papers.map((p) => p.id).sort();
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
    const sm = paperById(loaded, 'session-management');
    expect(sm?.province).toBe('auth');
    expect(sm?.frontmatter.title).toBe('Session Management');
  });

  it('builds 9 reference edges from Related Work links (deduped, cross-province)', () => {
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

  it('exposes the root paper', () => {
    expect(loaded.rootPaper?.id).toBe('realm-root');
  });

  it('componentSourcesIndex feeds buildFileComponentIndex', () => {
    const idx = componentSourcesIndex(loaded);
    expect(idx).toHaveLength(6);
    const fileIndex = buildFileComponentIndex(idx);
    expect(fileIndex['src/server/auth/sessions.ts']).toEqual(['session-management']);
  });

  it('returns empty results for a repo with no .scale/', () => {
    const empty = loadScaleDir(join(here, 'does-not-exist'));
    expect(empty.papers).toHaveLength(0);
    expect(empty.provinces).toHaveLength(0);
    expect(empty.edges).toHaveLength(0);
  });
});
