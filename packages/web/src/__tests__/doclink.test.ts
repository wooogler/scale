import { describe, expect, it } from 'vitest';
import { idByDir, resolveDocLink } from '../doclink.js';

const index = idByDir([
  { id: 'app-shell', dir: 'viewer/app-shell' },
  { id: 'component-panel', dir: 'viewer/component-panel' },
  { id: 'gate-enforcement', dir: 'interventions/gate-enforcement' },
]);
const from = (dir: string) => ({ fromDir: dir, idByDir: index });

describe('resolveDocLink — folder path → component id', () => {
  it('follows a sibling link the way the docs write them', () => {
    for (const href of [
      '../component-panel/',
      '../component-panel',
      '../component-panel/README.md',
      '../component-panel/#how-it-works',
      './../component-panel/',
    ]) {
      expect(resolveDocLink(href, from('viewer/app-shell'))).toEqual({
        kind: 'component',
        id: 'component-panel',
      });
    }
  });

  it('crosses provinces', () => {
    expect(
      resolveDocLink('../../interventions/gate-enforcement/', from('viewer/app-shell')),
    ).toEqual({ kind: 'component', id: 'gate-enforcement' });
  });

  it("reads a leading slash as the root of `.scale/`", () => {
    expect(resolveDocLink('/viewer/app-shell/', from('interventions/gate-enforcement'))).toEqual({
      kind: 'component',
      id: 'app-shell',
    });
  });

  it('is plain text for a folder no doc lives in', () => {
    expect(resolveDocLink('../ghost/', from('viewer/app-shell'))).toBeNull();
    expect(resolveDocLink('../../../escape/', from('viewer/app-shell'))).toBeNull();
  });
});

describe('resolveDocLink — what may become an anchor', () => {
  it('passes http(s) through as external', () => {
    expect(resolveDocLink('https://example.com/x', from('viewer/app-shell'))).toEqual({
      kind: 'external',
      href: 'https://example.com/x',
    });
    expect(resolveDocLink('  http://localhost:4318/  ', from('viewer/app-shell'))).toEqual({
      kind: 'external',
      href: 'http://localhost:4318/',
    });
  });

  it('refuses every other scheme rather than blocklisting a few', () => {
    for (const href of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,<script>',
      'mailto:someone@example.com',
      'file:///etc/passwd',
      'vbscript:msgbox',
      '//evil.example.com/x',
    ]) {
      expect(resolveDocLink(href, from('viewer/app-shell'))).toBeNull();
    }
  });

  it('is plain text for a bare fragment or an empty href', () => {
    expect(resolveDocLink('#summary', from('viewer/app-shell'))).toBeNull();
    expect(resolveDocLink('', from('viewer/app-shell'))).toBeNull();
    expect(resolveDocLink('   ', from('viewer/app-shell'))).toBeNull();
  });
});
