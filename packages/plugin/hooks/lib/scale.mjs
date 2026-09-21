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
import { dirname, resolve, delimiter } from "node:path";
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
 * Is `cmd` runnable? A pure-fs PATH walk, because the only alternative —
 * spawning something to find out — costs a process on the hook path, and the
 * async answer arrives after the caller has already exited.
 * @param {string} cmd
 */
function existsOnPath(cmd) {
  if (cmd.includes("/") || cmd.includes("\\")) return existsSync(cmd);
  const dirs = (process.env.PATH || "").split(delimiter).filter(Boolean);
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      if (existsSync(resolve(dir, cmd + ext))) return true;
    }
  }
  return false;
}

/**
 * Like {@link resolveCli}, but for a spawn whose failure we will never hear
 * about: the caller exits immediately, so an ENOENT arriving on the next tick
 * has nobody left to retry it. Decide here, synchronously, instead.
 * @returns {{cmd: string, prefix: string[]}|null} null = no CLI anywhere → no-op
 */
function resolveCliSync() {
  if (process.env.SCALE_BIN) return { cmd: process.env.SCALE_BIN, prefix: [] };
  if (existsOnPath("scale")) return { cmd: "scale", prefix: [] };
  return devFallback();
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
 * Run the CLI and parse its stdout as JSON. Returns null for every failure
 * there is — missing CLI, non-zero exit, timeout, or output that is not JSON —
 * because every caller's next move is the same: carry on without it.
 * @param {string[]} args
 * @param {string}   input
 * @param {object}   [opts]
 * @returns {any|null}
 */
export function runScaleJson(args, input, opts = {}) {
  const r = runScaleSync(args, input, opts);
  if (!r.ok) return null;
  try {
    const parsed = JSON.parse(r.stdout.trim());
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Fire-and-forget: run the CLI fully detached so the parent hook can exit
 * immediately (used for SessionEnd → quest generate, which may call an LLM and
 * must never block session exit — PLAN §6.2). Fails open silently.
 *
 * `opts.marker === false` drops the `--detached` argv marker. Only the commands
 * that declare that flag (quest generate) may receive it; `serve ensure` would
 * reject it as an unknown option, and a detached process that dies on argv
 * parsing is indistinguishable from one that worked.
 * @param {string[]} args
 * @param {string}   input
 * @param {{marker?: boolean}} [opts]
 */
export function runScaleDetached(args, input, opts = {}) {
  const tail = opts.marker === false ? [] : ["--detached"];
  const launch = ({ cmd, prefix }) => {
    const child = spawn(cmd, [...prefix, ...args, ...tail], {
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
    // Resolved SYNCHRONOUSLY: the caller typically exits on the next line, so
    // an ENOENT handler would be killed before it could ever fall back. No CLI
    // found anywhere = no-op, which is what failing open means here.
    const cli = resolveCliSync();
    if (cli) launch(cli);
  } catch {
    /* fail open */
  }
}

/**
 * Drop a URL's query string, keeping any hash. String surgery, not `new URL()`:
 * the parser normalises (`http://h:p` → `http://h:p/`) and these URLs are
 * printed verbatim.
 * @param {string} url
 */
function stripQuery(url) {
  const q = url.indexOf("?");
  if (q === -1) return url;
  const hash = url.indexOf("#");
  return hash > q ? url.slice(0, q) + url.slice(hash) : url.slice(0, q);
}

/**
 * Build the SessionStart hook envelope — PURE, so the wording and the rules
 * about when the user is spoken to are unit-testable without spawning a CLI.
 *
 * Two audiences, one JSON object (Claude Code hook output format):
 *   - `hookSpecificOutput.additionalContext` → goes to CLAUDE.
 *   - `systemMessage`                        → is shown to the USER.
 * They are top-level peers; both may appear in the same object.
 *
 * The systemMessage is the one line a junior sees per session, so it is shown
 * only on `startup` and `resume`. A `clear` or `compact` is a mid-session
 * mechanic the user did not ask SCALE about, and repeating the banner there is
 * how a useful line becomes noise nobody reads.
 *
 * @param {object}  args
 * @param {string}  [args.source]  startup | resume | clear | compact
 * @param {string}  [args.context] stdout of `scale context`
 * @param {{url?: string}|null} [args.viewer] result of `scale serve ensure --json`
 * @param {object|null} [args.setup] result of `scale setup status --json`
 * @returns {object|null} the envelope to print, or null when there is nothing to say
 */
export function buildSessionStartEnvelope({ source, context, viewer, setup } = {}) {
  const raw =
    (viewer && typeof viewer.url === "string" && viewer.url) ||
    (setup && setup.viewer && typeof setup.viewer.url === "string" && setup.viewer.url) ||
    null;
  // Both audiences here are transcript: `additionalContext` goes to Claude,
  // `systemMessage` is shown and logged. `serve ensure --json` answers with the
  // URL a BROWSER needs, which off loopback carries `?token=` — an API bearer
  // credential for a server that writes config and holds API keys. Strip the
  // query (mirrors `publicViewerUrl` in packages/cli/src/serve-state.ts; done
  // here too so this holds whichever source supplied the URL).
  const url = raw ? stripQuery(raw) : null;

  // `scale context` already prints the viewer line when it can resolve one;
  // appending a second copy would make Claude quote the URL twice.
  let text = (context || "").trim();
  if (url && !text.includes(url)) {
    const line =
      `Map viewer: ${url} — /scale-open opens it, /scale-open <id> opens one component.`;
    text = text ? `${text}\n${line}` : line;
  }

  // Everything below is best-effort: an absent `setup` means we could not ask,
  // which must read as "assume it is fine" rather than as "not set up".
  const initialized = setup ? setup.initialized !== false : true;
  const hasMemory = setup && setup.memory ? setup.memory.present !== false : true;

  let systemMessage = null;
  if (url && (source === "startup" || source === "resume")) {
    if (!initialized) {
      systemMessage =
        `SCALE is not set up for this repo yet — run /scale-settings to set it ` +
        `up in chat (map viewer: ${url}).`;
    } else if (!hasMemory) {
      systemMessage =
        `SCALE · map viewer: ${url} · no coverage memory yet — /scale-map ` +
        `builds it (senior) · settings in chat: /scale-settings`;
    } else {
      systemMessage = `SCALE · map viewer: ${url} · settings in chat: /scale-settings`;
    }
  }

  if (!text && !systemMessage) return null;
  const envelope = {};
  if (text) {
    envelope.hookSpecificOutput = {
      hookEventName: "SessionStart",
      additionalContext: text,
    };
  }
  if (systemMessage) envelope.systemMessage = systemMessage;
  return envelope;
}
