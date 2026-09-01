#!/usr/bin/env node
// PreToolUse(Edit|Write|MultiEdit) hook  →  `scale gate edit`
// (PLAN-GATE §3: the edit gate — SCALE's one blocking intervention)
//
// CONTRACT (Claude Code hooks):
//   stdin  : JSON  { session_id, cwd, hook_event_name:"PreToolUse",
//                    tool_name:"Edit"|"Write"|"MultiEdit", tool_input:{...} }
//   stdout : a PreToolUse permission-decision envelope:
//              { "hookSpecificOutput": { "hookEventName":"PreToolUse",
//                  "permissionDecision":"allow"|"deny",
//                  "permissionDecisionReason":"<text the agent sees on deny>" } }
//   exit 0 : success. Fails OPEN (allow) on any CLI absence/error/timeout.
//
// One CLI call does both jobs of this hook:
//   1. records the propose-timestamp for the diff_review latency pair
//      (post-edit.mjs closes it — this used to be `scale log review`), and
//   2. answers the edit-gate policy question. Contract with `scale gate edit`:
//        stdout JSON: { "allow": boolean, "component": string|null,
//                       "reason": string|null }
//      exit 0 on a clean decision; on any failure we fail open (allow).
//
// ALL policy lives in the CLI (deterministic, config-driven, team-policy
// aware). This hook is a thin translator onto the Claude Code envelope.

import { readStdin, runScaleSync } from "./lib/scale.mjs";

function allow() {
  // Emitting nothing is equivalent to allow; we stay silent to avoid overhead.
  process.exit(0);
}

const raw = await readStdin();
const res = runScaleSync(["gate", "edit"], raw);
if (!res.ok) allow();

let decision;
try {
  decision = JSON.parse(res.stdout.trim() || "{}");
} catch {
  allow();
}

// Block only on an explicit allow:false. Anything else (allow:true, missing
// field, malformed) fails open — the junior's flow is never blocked on doubt.
if (decision && decision.allow === false) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          decision.reason ||
          "SCALE edit gate: this edit reaches locked territory. Run the " +
            "scale-tutor check for it with the junior, then retry the edit.",
      },
    })
  );
}
process.exit(0);
