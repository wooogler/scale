#!/usr/bin/env node
// PostToolUse(Edit|Write|MultiEdit) hook  →  `scale log touch`
// (PLAN §5 evidence `touch`, §7.2)
//
// CONTRACT (Claude Code hooks):
//   stdin  : JSON  { session_id, cwd, hook_event_name:"PostToolUse",
//                    tool_name:"Edit"|"Write"|"MultiEdit",
//                    tool_input:{...}, tool_response:{...} }
//   stdout : a PostToolUse hook may return { "decision":"block", "reason":... }
//            to feed the agent a note. We never block — this is silent capture.
//   exit 0 : success (fail open).
//
// Behavior: forward to the CLI, which maps edited files → components via the
// reverse index (index.json) and appends a `touch` evidence row (fog→explored,
// small structure credit capped at 0.3 — PLAN §5.1). The CLI also closes any
// pending propose-timestamp from pre-edit.mjs into a `diff_review` row. Pure
// file work; no LLM. Not awaited beyond the fast backstop timeout.

import { readStdin, runScaleSync } from "./lib/scale.mjs";

const raw = await readStdin();
runScaleSync(["log", "touch"], raw); // hook_event_name=PostToolUse → execute phase + touch
process.exit(0);
