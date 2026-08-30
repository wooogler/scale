/**
 * Claude Code hook payload plumbing — the CLI side of the hook contract.
 *
 * Every SCALE hook script pipes its raw hook JSON to the CLI on stdin
 * (`packages/plugin/hooks/*.mjs` → `runScaleSync(args, raw)`). The hook-path
 * commands (`log prompt`, `log touch`, `log review`, `context`) take the same
 * information on argv when a human runs them, so these helpers are consulted
 * ONLY when argv came up empty: an explicit invocation never touches stdin.
 *
 * Latency contract (PLAN §7.1): the hook path stays < 200 ms. The read is
 * skipped outright for a TTY (interactive use) and backstopped by a short timer,
 * so a stdin that is never closed can stall a hook by at most STDIN_TIMEOUT_MS
 * instead of hanging the junior's editor.
 */

/** The subset of a Claude Code hook payload SCALE reads. */
export interface HookPayload {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  /** SessionStart only: "startup" | "resume" | "clear" | "compact". */
  source?: string;
  /** UserPromptSubmit only. */
  prompt?: string;
  tool_name?: string;
  tool_input?: unknown;
  [key: string]: unknown;
}

/** Backstop for a stdin that is never closed (ms). */
const STDIN_TIMEOUT_MS = 150;

/**
 * Read all of stdin as UTF-8. Resolves '' immediately on a TTY, and resolves
 * with whatever arrived so far if the stream stays open past the backstop.
 */
export function readStdinRaw(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let data = '';
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      // Stop flowing AND drop stdin from the event loop's ref count. `pause()`
      // alone is not enough: a producer that never closes the pipe would keep
      // the handle referenced and the process alive long after the backstop
      // fired, burning the hook's entire timeout for nothing.
      process.stdin.pause();
      (process.stdin as NodeJS.ReadStream & { unref?: () => void }).unref?.();
      resolve(data);
    };
    const timer = setTimeout(finish, STDIN_TIMEOUT_MS);
    timer.unref?.();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      finish();
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      finish();
    });
  });
}

/** Read + parse the hook payload. Any absence or garbage yields `{}`. */
export async function readHookPayload(): Promise<HookPayload> {
  const raw = await readStdinRaw();
  if (!raw.trim()) return {};
  return parseHookPayload(raw);
}

/** Parse hook JSON, tolerating garbage and non-object roots. */
export function parseHookPayload(raw: string): HookPayload {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as HookPayload;
    }
    return {};
  } catch {
    return {};
  }
}

/** The junior's prompt text from a UserPromptSubmit payload ('' when absent). */
export function promptTextOf(payload: HookPayload): string {
  return typeof payload.prompt === 'string' ? payload.prompt : '';
}

/**
 * File paths a Pre/PostToolUse payload targets, in first-seen order.
 *
 * Covers the shapes the plugin's `Edit|Write|MultiEdit` matcher can deliver —
 * `file_path` (Edit/Write), `notebook_path` (NotebookEdit), and a per-edit list
 * (MultiEdit). An unrecognized `tool_input` yields [] rather than a guess: a
 * wrong path would credit comprehension for code the junior never touched.
 */
export function editedFilesOf(payload: HookPayload): string[] {
  const input = payload.tool_input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [];
  const record = input as Record<string, unknown>;

  const files: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (trimmed && !files.includes(trimmed)) files.push(trimmed);
  };

  push(record.file_path);
  push(record.notebook_path);
  push(record.path);

  const edits = record.edits;
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      if (edit && typeof edit === 'object' && !Array.isArray(edit)) {
        push((edit as Record<string, unknown>).file_path);
      }
    }
  }

  return files;
}

/** Session id from any payload ('' when absent). */
export function sessionIdOf(payload: HookPayload): string {
  return typeof payload.session_id === 'string' ? payload.session_id : '';
}

/** Hook event name ('' when absent). */
export function hookEventOf(payload: HookPayload): string {
  return typeof payload.hook_event_name === 'string' ? payload.hook_event_name : '';
}
