import { describe, expect, it } from 'vitest';
import { formatHash, parseHash, SETTINGS_TABS, type Route } from '../route.js';

describe('parseHash', () => {
  it('reads component links', () => {
    expect(parseHash('#/c/session-management')).toEqual({
      kind: 'component',
      id: 'session-management',
    });
    expect(parseHash('/c/session-management')).toEqual({
      kind: 'component',
      id: 'session-management',
    });
  });

  it('reads a section anchor off the end', () => {
    expect(parseHash('#/c/session-management/design-decisions')).toEqual({
      kind: 'component',
      id: 'session-management',
      section: 'design-decisions',
    });
    // The two reserved panel sections are ordinary section slugs on the wire.
    expect(parseHash('#/c/gate-core/concepts')).toEqual({
      kind: 'component',
      id: 'gate-core',
      section: 'concepts',
    });
    expect(parseHash('#/c/gate-core/decisions/')).toEqual({
      kind: 'component',
      id: 'gate-core',
      section: 'decisions',
    });
  });

  it('decodes ids that had to be escaped', () => {
    expect(parseHash('#/c/packages%2Fcore%2Fgate')).toEqual({
      kind: 'component',
      id: 'packages/core/gate',
    });
    // …including one carrying a section: the `%2F`s never reach the split.
    expect(parseHash('#/c/packages%2Fcore%2Fgate/summary')).toEqual({
      kind: 'component',
      id: 'packages/core/gate',
      section: 'summary',
    });
  });

  it('resolves a hand-written slashed id toward the section (the documented ambiguity)', () => {
    // `#/c/a/b` cannot be both the id `a/b` and the id `a` at section `b`.
    // Sectioned links are the common case, so the trailing slug wins; links
    // SCALE writes itself escape the id and are never ambiguous (above).
    expect(parseHash('#/c/packages/core/gate')).toEqual({
      kind: 'component',
      id: 'packages/core',
      section: 'gate',
    });
    // A trailing segment that is NOT slug-shaped stays part of the id.
    expect(parseHash('#/c/packages/core/Gate')).toEqual({
      kind: 'component',
      id: 'packages/core/Gate',
    });
    expect(parseHash('#/c/packages/core/a b')).toEqual({
      kind: 'component',
      id: 'packages/core/a b',
    });
  });

  it('reads settings links, defaulting the tab', () => {
    expect(parseHash('#/settings')).toEqual({ kind: 'settings', tab: 'general' });
    expect(parseHash('#/settings/')).toEqual({ kind: 'settings', tab: 'general' });
    for (const tab of SETTINGS_TABS) {
      expect(parseHash(`#/settings/${tab}`)).toEqual({ kind: 'settings', tab });
    }
  });

  it('degrades unknown input instead of throwing', () => {
    expect(parseHash('#/settings/nope')).toEqual({ kind: 'settings', tab: 'general' });
    expect(parseHash('')).toBeNull();
    expect(parseHash('#')).toBeNull();
    expect(parseHash('#/')).toBeNull();
    expect(parseHash('#/c/')).toBeNull();
    expect(parseHash('#/c//summary')).toBeNull();
    expect(parseHash('#/nonsense')).toBeNull();
    expect(parseHash('#/c/%E0%A4%A')).toEqual({ kind: 'component', id: '%E0%A4%A' });
  });

  it('keeps an unknown section on the route — the panel, not the parser, decides', () => {
    // A section this doc does not have is not an error here: the Panel simply
    // finds no element with that id and shows the doc from the top.
    expect(parseHash('#/c/gate-core/no-such-heading')).toEqual({
      kind: 'component',
      id: 'gate-core',
      section: 'no-such-heading',
    });
  });
});

describe('formatHash', () => {
  it('round-trips every route', () => {
    const routes: Route[] = [
      { kind: 'component', id: 'session-management' },
      { kind: 'component', id: 'session-management', section: 'how-it-works' },
      { kind: 'component', id: 'packages/core/gate' },
      { kind: 'component', id: 'packages/core/gate', section: 'concepts' },
      ...SETTINGS_TABS.map((tab): Route => ({ kind: 'settings', tab })),
    ];
    for (const route of routes) {
      expect(parseHash(formatHash(route))).toEqual(route);
    }
  });

  it('writes the section as a trailing segment', () => {
    expect(formatHash({ kind: 'component', id: 'gate-core', section: 'design-decisions' })).toBe(
      '#/c/gate-core/design-decisions',
    );
    expect(formatHash({ kind: 'component', id: 'gate-core' })).toBe('#/c/gate-core');
  });

  it('writes nothing for no route', () => {
    expect(formatHash(null)).toBe('');
  });
});
