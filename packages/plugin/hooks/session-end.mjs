#!/usr/bin/env node
// SessionEnd hook  →  `scale quest generate` (DETACHED)  (PLAN §6.2, §7.2)
//
// CONTRACT (Claude Code hooks):
//   stdin  : JSON  { session_id, cwd, hook_event_name:"SessionEnd",
//                    reason: "clear"|"logout"|"prompt_input_exit"|"other" }
//   stdout : ignored for SessionEnd (the session is ending); nothing to emit.
//   exit 0 : success — and we MUST exit fast. Quest generation may call the
//            Claude API (cheap model) and must NEVER block session exit.
//
// Behavior: hand the payload to a fully detached `scale quest generate` process
// and return immediately. The CLI decides internally whether to do anything:
//   - post-session conditions → pick top-K touched × low-coverage × importance
//     components and generate quests into quests.json.
//   - in-flow conditions      → no-op (no quests are ever generated; PLAN §6.2).
// The parent (this script) does not wait for or observe the child.

import { readStdin, runScaleDetached } from "./lib/scale.mjs";

const raw = await readStdin();
runScaleDetached(["quest", "generate"], raw);
process.exit(0);
