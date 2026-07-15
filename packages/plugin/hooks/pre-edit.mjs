#!/usr/bin/env node
// PreToolUse(Edit|Write|MultiEdit) hook  →  `scale log review` (propose phase)
// (PLAN §5 evidence `diff_review`, §7.2 "PreToolUse timestamp pairing for
//  review latency")
//
// CONTRACT (Claude Code hooks):
//   stdin  : JSON  { session_id, cwd, hook_event_name:"PreToolUse",
//                    tool_name:"Edit"|"Write"|"MultiEdit", tool_input:{...} }
//   stdout : a PreToolUse hook MAY return a permission decision, e.g.
//              { "hookSpecificOutput": { "hookEventName":"PreToolUse",
//                  "permissionDecision":"allow"|"deny"|"ask",
//                  "permissionDecisionReason":"..." } }
//            We NEVER gate edits — we only record a "proposal" timestamp so the
//            paired PostToolUse hook can compute review latency. So we print
//            nothing and let the edit proceed normally.
//   exit 0 : success (fail open).
//
// The CLI stores a pending propose-timestamp keyed by session + target file(s);
// post-edit.mjs closes the pair into a `diff_review` evidence row. Logged only,
// not modeled in coverage v1 (PLAN §5.1).

import { readStdin, runScaleSync } from "./lib/scale.mjs";

const raw = await readStdin();
runScaleSync(["log", "review"], raw); // hook_event_name=PreToolUse → propose phase
process.exit(0);
