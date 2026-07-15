#!/usr/bin/env node
// SessionStart hook  →  `scale context`  (PLAN §6.1, §7.2)
//
// CONTRACT (Claude Code hooks):
//   stdin  : JSON  { session_id, transcript_path, cwd, hook_event_name:"SessionStart",
//                    source: "startup"|"resume"|"clear"|"compact" }
//   stdout : to inject text into the agent's context, print a JSON envelope:
//              { "hookSpecificOutput": { "hookEventName": "SessionStart",
//                                        "additionalContext": "<text>" } }
//            (Plain stdout is also treated as added context by Claude Code, but
//             the JSON envelope is explicit and version-stable.)
//   exit 0 : success (any other code is surfaced to the user — we always exit 0).
//
// Behavior: ask the CLI for the 3-line coverage summary (PLAN §6.1 "SessionStart
// injects a 3-line coverage context") and a possible silent drift refresh. This
// is a pure file read in the CLI; if it's unavailable we inject nothing.

import { readStdin, runScaleSync, emitAdditionalContext } from "./lib/scale.mjs";

const raw = await readStdin();
const res = runScaleSync(["context"], raw);
if (res.ok) emitAdditionalContext("SessionStart", res.stdout);
process.exit(0);
