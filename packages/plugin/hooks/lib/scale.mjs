// Shared helper for SCALE hook scripts.
//
// Design goals (PLAN §2 "Minimal interruption", §7.1 latency budget):
//   - The junior's Claude Code flow is sacred. Hooks MUST fail OPEN: if the
//     `scale` CLI is missing, slow, or errors, we never block the user and never
//     print noise. A broken SCALE install degrades to a no-op, not a wall.
//   - Hook-path work is pure file read/append in the CLI, targeted < 200 ms.
//     We enforce a hard timeout here as a backstop and never run an LLM inline.
//
// Resolution order for the CLI (first that works wins):
//   1. $SCALE_BIN            — explicit override (absolute path or command name)
//   2. `scale`               — assumed on PATH (normal install)
//   3. `npx tsx <cli>/src/index.ts` — dev fallback when the CLI isn't linked
//
// The dev fallback path is resolved relative to this plugin (../../cli).

import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url)); // .../plugin/hooks/lib
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT
  ? resolve(process.env.CLAUDE_PLUGIN_ROOT)
  : resolve(HERE, "..", ".."); // .../plugin

// Dev fallback entrypoint for the CLI (TypeScript, run via tsx).
const CLI_TS_ENTRY = resolve(PLUGIN_ROOT, "..", "cli", "src", "index.ts");

// Default backstop timeout for synchronous hook calls (ms). Generous relative to
// the < 200 ms target so a cold Node start doesn't spuriously fire the timeout,
// but bounded so a hung CLI can never freeze the editor.
const DEFAULT_TIMEOUT_MS = Number(process.env.SCALE_HOOK_TIMEOUT_MS || 1500);

/**
 * Read all of stdin as a UTF-8 string. Returns "" if stdin is empty/closed.
 * @returns {Promise<string>}
 */
export function readStdin() {
  return new Promise((res) => {
    let data = "";
    if (process.stdin.isTTY) return res("");
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => res(data));
    process.stdin.on("error", () => res(data));
  });
}

/** Parse hook stdin JSON, tolerating garbage. Returns {} on failure. */
export function parseHookInput(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

/**
 * Build the [command, prefixArgs] pair for invoking the CLI, honoring the
 * resolution order above. Never throws.
 * @returns {{cmd: string, prefix: string[]}}
 */
function resolveCli() {
  if (process.env.SCALE_BIN) {
    return { cmd: process.env.SCALE_BIN, prefix: [] };
  }
  // We optimistically assume `scale` is on PATH. spawnSync surfaces ENOENT,
  // which runScaleSync catches and retries with the dev fallback.
  return { cmd: "scale", prefix: [] };
}

function devFallback() {
  if (existsSync(CLI_TS_ENTRY)) {
    return { cmd: "npx", prefix: ["--yes", "tsx", CLI_TS_ENTRY] };
  }
  return null;
}

/**
 * Run the CLI synchronously, piping `input` to its stdin. Fails open.
 * @param {string[]} args    CLI args, e.g. ["context"] or ["log","prompt"].
 * @param {string}   input   Raw JSON to pass on stdin (the hook payload).
 * @param {object}   [opts]
 * @returns {{ok: boolean, code: number|null, stdout: string, stderr: string}}
 */
export function runScaleSync(args, input, opts = {}) {
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT_MS;
  const attempt = ({ cmd, prefix }) =>
    spawnSync(cmd, [...prefix, ...args], {
      input: input ?? "",
      encoding: "utf8",
      timeout,
      // Never let CLI stderr leak into the user's terminal; we own reporting.
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

  let r = attempt(resolveCli());
  if (r.error && r.error.code === "ENOENT") {
    const fb = devFallback();
    if (fb) r = attempt(fb);
  }
  if (!r || r.error) {
    return { ok: false, code: null, stdout: "", stderr: r?.error?.message || "spawn failed" };
  }
  return {
    ok: r.status === 0,
    code: r.status,
    stdout: r.stdout || "",
    stderr: r.stderr || "",
  };
}

/**
 * Fire-and-forget: run the CLI fully detached so the parent hook can exit
 * immediately (used for SessionEnd → quest generate, which may call an LLM and
 * must never block session exit — PLAN §6.2). Fails open silently.
 * @param {string[]} args
 * @param {string}   input
 */
export function runScaleDetached(args, input) {
  const launch = ({ cmd, prefix }) => {
    const child = spawn(cmd, [...prefix, ...args, "--detached"], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
      env: { ...process.env },
    });
    // Hand the payload to the child, then sever ties so we can exit.
    try {
      child.stdin.write(input ?? "");
      child.stdin.end();
    } catch {
      /* ignore */
    }
    child.on("error", () => {}); // swallow ENOENT etc.
    child.unref();
    return child;
  };

  try {
    const child = launch(resolveCli());
    child.on("error", (e) => {
      if (e && e.code === "ENOENT") {
        const fb = devFallback();
        if (fb) launch(fb);
      }
    });
  } catch {
    /* fail open */
  }
}

/** Emit a SessionStart/UserPromptSubmit additionalContext envelope, if any. */
export function emitAdditionalContext(hookEventName, text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName, additionalContext: trimmed },
    })
  );
}
