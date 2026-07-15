# @scale/plugin

The **SCALE** Claude Code plugin: hooks that capture coverage evidence and gate
commits, plus two skills (`scale-map`, `scale-tutor`) and four slash commands.
SCALE = **S**caffolded **C**overage-**A**ware **L**earning **E**ngine (see
`../../PLAN.md`).

This package is **static** — plain `.mjs` hook scripts + markdown. No build step.

## Structure

```
packages/plugin/
├── .claude-plugin/
│   └── plugin.json          # plugin manifest (name, version, entry points)
├── hooks/
│   ├── hooks.json           # event → script wiring (PLAN §7.2)
│   ├── lib/scale.mjs        # shared helper: resolve & run the `scale` CLI, fail-open
│   ├── session-start.mjs    # SessionStart      → scale context   (inject 3-line coverage)
│   ├── prompt-submit.mjs    # UserPromptSubmit   → scale log prompt (component mentions)
│   ├── pre-edit.mjs         # PreToolUse(Edit|Write|MultiEdit) → scale log review (propose ts)
│   ├── post-edit.mjs        # PostToolUse(Edit|Write|MultiEdit)→ scale log touch  (+ review pair)
│   ├── pre-commit-gate.mjs  # PreToolUse(Bash: git commit)     → scale gate commit (in-flow gate)
│   └── session-end.mjs      # SessionEnd        → scale quest generate (DETACHED, async)
├── skills/
│   ├── scale-map/SKILL.md   # Mode B coverage-memory builder (senior; forks cluedoc)
│   └── scale-tutor/SKILL.md # junior quiz & Socratic tutor + voluntary study
├── commands/
│   ├── scale-map.md         # /scale-map    — build/sync coverage memory
│   ├── scale-status.md      # /scale-status — coverage at a glance
│   ├── scale-study.md       # /scale-study  — voluntary learning (§6.3)
│   └── scale-quiz.md        # /scale-quiz   — manual check (testing)
├── package.json             # @scale/plugin (created by Foundation)
└── README.md
```

## How the hooks work

Each event in `hooks/hooks.json` runs a thin `.mjs` script that:

1. reads the Claude Code hook JSON from **stdin**,
2. shells out to the **`scale` CLI** (via `hooks/lib/scale.mjs`), and
3. returns fast (< 200 ms target; hard timeout backstop) with **no inline LLM**.

The stdin/stdout contract for each event is documented at the top of its script.

**Fail-open by design.** If the `scale` CLI is missing, slow, or errors, every
hook degrades to a no-op and never blocks the user (PLAN §1 Principle 2). The CLI
is resolved in this order:

1. `$SCALE_BIN` — explicit override
2. `scale` — on `PATH` (normal install)
3. `npx tsx ../cli/src/index.ts` — dev fallback when the CLI isn't linked

Override the sync-call backstop timeout with `$SCALE_HOOK_TIMEOUT_MS` (default
1500 ms).

The one hook that can affect flow is **`pre-commit-gate.mjs`**: on a `git commit`
that touched fog/low-coverage/stale territory (and only when the CLI's budget
policy allows), it returns a `deny` with a reason telling the agent to run the
`scale-tutor` check; after `scale record` writes a validation marker, the retried
commit passes. Everything else is silent evidence capture. Post-session
conditions: the gate is a no-op (PLAN §6.1).

## Install

Requires Node 18+ and (for real behavior) the `scale` CLI on `PATH`.

**As a local/dev plugin** — point Claude Code at this directory. In the target
repo's `.claude/settings.json`:

```json
{
  "plugins": ["/absolute/path/to/scale/packages/plugin"]
}
```

Or via the marketplace/`/plugin` install flow once published. Claude Code reads
`.claude-plugin/plugin.json`, wires the hooks from `hooks/hooks.json`, and exposes
the skills and `/scale-*` commands. It exports `${CLAUDE_PLUGIN_ROOT}` (this
directory) to the hook commands, which is how the scripts locate themselves.

Verify the hooks are loaded with `/hooks` inside Claude Code.

## Conventions I guessed at (verify later)

The exact plugin manifest/loader schema was not available while building this, so
the following are **best-effort guesses** to confirm against current Claude Code
plugin docs:

- **`.claude-plugin/plugin.json` schema** — I used `name`, `version`,
  `description`, `author`, `license`, `keywords`, and explicit `hooks`/`skills`/
  `commands` path pointers. The path pointers may be unnecessary if Claude Code
  auto-discovers `hooks/hooks.json`, `skills/*/SKILL.md`, and `commands/*.md` by
  convention; harmless if ignored, but confirm the field names.
- **`hooks.json` shape** — `{ "hooks": { <Event>: [ { "matcher", "hooks":
  [ { "type":"command", "command", "timeout" } ] } ] } }`, `${CLAUDE_PLUGIN_ROOT}`
  expansion, and `SessionEnd` as a valid event name. Matchers are regex over
  `tool_name`. Confirm `SessionEnd`/`UserPromptSubmit` are supported in plugin
  hooks and that `timeout` is in seconds.
- **Hook stdout envelopes** — `hookSpecificOutput.additionalContext` for
  SessionStart/UserPromptSubmit, and `hookSpecificOutput.permissionDecision`
  (`allow`/`deny`) + `permissionDecisionReason` for PreToolUse. These are the
  current documented forms; verify they haven't changed.
- **Command frontmatter** — `description` and `argument-hint`, with `$ARGUMENTS`
  interpolation. Confirmed against common usage; verify `argument-hint` is honored.
- **CLI sub-command surface** — the scripts assume `scale context`,
  `scale log prompt|touch|review`, `scale gate commit`, `scale record`, and
  `scale quest generate --detached`. These match what `packages/cli` ships
  (verified). Note the actual `scale gate commit` contract: it emits one JSON
  line `{"allow":boolean,"component":string|null,"reason":string|null}` (NOT a
  `{"decision":...}` shape); `pre-commit-gate.mjs` maps `allow:false` onto the
  Claude Code deny envelope. The user's escape hatch is `scale gate defer
  <componentId>` (defer = drop), which writes the marker that lets the retried
  commit pass.
```
