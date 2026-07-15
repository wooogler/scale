#!/usr/bin/env node
// PreToolUse(Bash: git commit) hook  →  `scale gate commit`
// (PLAN §6.1 in-flow `pre-commit` trigger + interruption budget)
//
// CONTRACT (Claude Code hooks):
//   stdin  : JSON  { session_id, cwd, hook_event_name:"PreToolUse",
//                    tool_name:"Bash", tool_input:{ command:"git commit ..." } }
//   stdout : a PreToolUse permission-decision envelope:
//              { "hookSpecificOutput": {
//                  "hookEventName":"PreToolUse",
//                  "permissionDecision":"allow"|"deny",
//                  "permissionDecisionReason":"<text the agent sees on deny>" } }
//   exit 0 : success. (exit 2 is the legacy "block" path; we use JSON instead.)
//
// Two-stage gate mechanics (PLAN §6.1):
//   1. First `git commit` on a diff that touched fog/low-coverage/stale
//      territory, IF budget allows (≤1/commit, ≤2/session, ≥15 min cooldown,
//      non-trivial diff), returns DENY with a reason instructing the agent to
//      run the scale-tutor protocol in chat.
//   2. Tutor runs → `scale record` writes a fresh validation marker (TTL 10 min).
//   3. Agent retries the commit → the gate sees the marker → ALLOW.
//   "Skip" is final: the gate allows immediately and the item is dropped
//   (logged as evidence, never queued). Post-session conditions: gate is a no-op.
//
// ALL of that policy lives in the CLI (deterministic, config-driven). This hook
// is a thin translator: it only matches "is this a git commit?", asks the CLI,
// and maps the CLI's decision onto the Claude Code envelope. Fails OPEN (allow).

import { readStdin, parseHookInput, runScaleSync } from "./lib/scale.mjs";

function allow() {
  // Emitting nothing is equivalent to allow; we stay silent to avoid overhead.
  process.exit(0);
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    })
  );
  process.exit(0);
}

const raw = await readStdin();
const input = parseHookInput(raw);

// Cheap pre-filter so non-commit Bash calls cost ~nothing (regex only).
const cmd = String(input?.tool_input?.command ?? "");
const isGitCommit = /(^|[\s;&|(])git\s+(?:-[^\s]+\s+)*commit\b/.test(cmd);
if (!isGitCommit) allow();

// Ask the CLI for the policy decision. Contract with `scale gate commit`:
//   stdout JSON: { "allow": boolean, "component": string|null, "reason": string|null }
//   exit 0 on a clean decision. On any failure we fail open (allow).
const res = runScaleSync(["gate", "commit"], raw);
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
  deny(
    decision.reason ||
      "SCALE: run the scale-tutor check for the territory you just touched, then retry the commit."
  );
}
allow();
