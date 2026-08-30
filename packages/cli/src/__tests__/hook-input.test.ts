/**
 * Hook-payload plumbing (PLAN §5 evidence, §7.2).
 *
 * These extractors are the seam where a Claude Code hook payload becomes
 * evidence. When they return nothing, every passive signal is silently recorded
 * empty and the whole comprehension model starves — so the shapes Claude Code
 * actually sends are pinned here.
 */
import { describe, it, expect } from 'vitest';
import {
  parseHookPayload,
  promptTextOf,
  editedFilesOf,
  sessionIdOf,
  hookEventOf,
} from '../hook-input.js';

describe('parseHookPayload', () => {
  it('parses a real payload', () => {
    const p = parseHookPayload('{"session_id":"s1","hook_event_name":"PreToolUse"}');
    expect(sessionIdOf(p)).toBe('s1');
    expect(hookEventOf(p)).toBe('PreToolUse');
  });

  it('yields {} for garbage, empty, and non-object roots', () => {
    expect(parseHookPayload('not json')).toEqual({});
    expect(parseHookPayload('')).toEqual({});
    expect(parseHookPayload('[1,2]')).toEqual({});
    expect(parseHookPayload('null')).toEqual({});
  });

  it('reports absent fields as empty strings, never undefined', () => {
    const p = parseHookPayload('{}');
    expect(sessionIdOf(p)).toBe('');
    expect(hookEventOf(p)).toBe('');
    expect(promptTextOf(p)).toBe('');
  });
});

describe('promptTextOf', () => {
  it('extracts the UserPromptSubmit prompt', () => {
    const p = parseHookPayload(
      JSON.stringify({
        session_id: 's1',
        hook_event_name: 'UserPromptSubmit',
        prompt: 'fix the commit gate',
      }),
    );
    expect(promptTextOf(p)).toBe('fix the commit gate');
  });

  it('ignores a non-string prompt', () => {
    expect(promptTextOf(parseHookPayload('{"prompt":42}'))).toBe('');
  });
});

describe('editedFilesOf', () => {
  const payload = (toolName: string, toolInput: unknown) =>
    parseHookPayload(
      JSON.stringify({
        session_id: 's1',
        hook_event_name: 'PostToolUse',
        tool_name: toolName,
        tool_input: toolInput,
      }),
    );

  it('reads Edit / Write file_path', () => {
    expect(
      editedFilesOf(payload('Edit', { file_path: '/repo/src/a.ts', old_string: 'x' })),
    ).toEqual(['/repo/src/a.ts']);
    expect(editedFilesOf(payload('Write', { file_path: '/repo/b.ts', content: 'y' }))).toEqual([
      '/repo/b.ts',
    ]);
  });

  it('reads NotebookEdit notebook_path', () => {
    expect(editedFilesOf(payload('NotebookEdit', { notebook_path: '/repo/n.ipynb' }))).toEqual([
      '/repo/n.ipynb',
    ]);
  });

  it('reads a MultiEdit per-edit list and de-duplicates', () => {
    const files = editedFilesOf(
      payload('MultiEdit', {
        file_path: '/repo/a.ts',
        edits: [{ file_path: '/repo/a.ts' }, { file_path: '/repo/c.ts' }],
      }),
    );
    expect(files).toEqual(['/repo/a.ts', '/repo/c.ts']);
  });

  it('returns [] rather than guessing on an unknown tool_input', () => {
    expect(editedFilesOf(payload('Bash', { command: 'git commit -m x' }))).toEqual([]);
    expect(editedFilesOf(payload('Edit', null))).toEqual([]);
    expect(editedFilesOf(payload('Edit', ['a.ts']))).toEqual([]);
    expect(editedFilesOf(parseHookPayload('{}'))).toEqual([]);
  });

  it('skips blank paths', () => {
    expect(editedFilesOf(payload('Edit', { file_path: '   ' }))).toEqual([]);
  });
});
