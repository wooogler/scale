#!/usr/bin/env node
// UserPromptSubmit hook  →  `scale log prompt`  (PLAN §5 evidence, §7.2)
//
// CONTRACT (Claude Code hooks):
//   stdin  : JSON  { session_id, cwd, hook_event_name:"UserPromptSubmit", prompt }
//   stdout : optional additionalContext envelope (see session-start.mjs). We do
//            NOT add context here — this is a silent, async evidence capture.
//   exit 0 : success. Never exit non-zero: a blocking UserPromptSubmit hook would
//            swallow the user's prompt. Fail open, always.
//
// Behavior: forward the prompt to the CLI, which extracts component mentions
// (keyword/slug match against map.json) and appends a `prompt` evidence row.
// Pure append; no LLM. We do not wait on output.

import { readStdin, runScaleSync } from "./lib/scale.mjs";

const raw = await readStdin();
runScaleSync(["log", "prompt"], raw);
process.exit(0);
