#!/usr/bin/env node
// SessionStart hook  →  `scale context` + `scale serve ensure`  (PLAN §6.1, §7.2)
//
// CONTRACT (Claude Code hooks):
//   stdin  : JSON  { session_id, transcript_path, cwd, hook_event_name:"SessionStart",
//                    source: "startup"|"resume"|"clear"|"compact" }
//   stdout : one JSON envelope with two audiences:
//              { "hookSpecificOutput": { "hookEventName": "SessionStart",
//                                        "additionalContext": "<for CLAUDE>" },
//                "systemMessage": "<shown to the USER>" }
//            `systemMessage` is a TOP-LEVEL peer of `hookSpecificOutput`, not
//            nested inside it (Claude Code hooks, JSON Output Format).
//   exit 0 : success (any other code is surfaced to the user — we always exit 0).
//
// Behavior, in priority order:
//   1. `scale context`            — the coverage summary Claude reads (unchanged).
//   2. `scale serve ensure --json`— the map viewer is RUNNING by the time the
//      junior reads the banner, rather than being a command they must find.
//   3. `scale setup status --json`— decides which banner: first-run setup,
//      "no memory yet", or the plain one-liner.
//
// LATENCY. The hook timeout is 5 s (hooks.json) and three CLI spawns share it,
// so they share a single ~4.2 s deadline: each call gets what is LEFT, never a
// fixed slice, and a call with under 150 ms left is skipped rather than started.
// Everything fails open — whatever we have at the end is what we print, and the
// exit code is always 0.

import {
  readStdin,
  parseHookInput,
  runScaleSync,
  runScaleJson,
  runScaleDetached,
  buildSessionStartEnvelope,
} from "./lib/scale.mjs";

// Well under the 5 s hook timeout, leaving room for Node's own startup and for
// the process teardown after the last call returns.
const BUDGET_MS = 4000;
// Below this, a spawn cannot finish anyway; starting one only burns the budget.
const MIN_SLICE_MS = 150;

const startedAt = Date.now();
const remaining = () => BUDGET_MS - (Date.now() - startedAt);

/** Run within the shared deadline; returns null when there is no time left. */
function budgeted(run, maxMs) {
  const timeout = Math.min(maxMs, remaining());
  if (timeout < MIN_SLICE_MS) return null;
  return run(timeout);
}

const raw = await readStdin();
const source = parseHookInput(raw).source;

// 1. The viewer, FIRST — `scale context` prints the viewer's URL and whether it
//    is up, and it would print "not running yet" about a server we are about to
//    start one line later. `ensure` reuses a live server in milliseconds; only
//    a cold start costs seconds, and that is the case worth paying for once.
const viewer = budgeted(
  (timeout) => runScaleJson(["serve", "ensure", "--json"], "", { timeout }),
  2200,
);
if (!viewer) {
  // Timed out, failed, or never ran. Start one without waiting, so the NEXT
  // session (or a click a moment from now) finds it up; the URL for this
  // banner comes from `setup status` below.
  runScaleDetached(["serve", "ensure"], "", { marker: false });
}

// 2. The context summary — the pre-existing behavior, and the payload that
//    actually shapes the session, so it gets everything the viewer left.
const ctx = budgeted((timeout) => runScaleSync(["context"], raw, { timeout }), 1800);
const context = ctx && ctx.ok ? ctx.stdout : "";

// 3. Which banner to show. Also our fallback source for the URL.
const setup = budgeted(
  (timeout) => runScaleJson(["setup", "status", "--json"], "", { timeout }),
  900,
);

const envelope = buildSessionStartEnvelope({ source, context, viewer, setup });
// Exit only once the write has actually flushed: a large `scale context` can
// exceed the pipe buffer, and `process.exit()` right after `write()` would cut
// the envelope in half — which Claude Code reads as malformed JSON, i.e. as no
// context at all.
if (envelope) process.stdout.write(JSON.stringify(envelope), () => process.exit(0));
else process.exit(0);
