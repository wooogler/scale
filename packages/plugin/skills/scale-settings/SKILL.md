---
name: scale-settings
description: >-
  Conversational setup and settings for SCALE. Walks a first-run user through
  init, language, the edit gate's shape, the intervention model and the API key
  (never asking for the key in chat), and afterwards handles free-form settings
  changes — "switch to opus", "게이트를 async로 바꿔줘", "turn the gate off",
  "what's my quiz size?" — by mapping them onto `scale config get/set/unset`.
  Invoked by /scale-settings, when `scale setup status --json` reports
  `initialized: false`, or whenever the user asks to set SCALE up or change how
  it behaves.
license: MIT
---

# scale-settings — set SCALE up and change it, in chat

Nobody should need a terminal to run SCALE. You own two jobs:

- **Setup mode** — the first run: init the state, ask the handful of choices
  that matter, get an API key in place without ever seeing it.
- **Change mode** — everything after: read, change, or reset one setting.

Both modes are **short-turn**. One question or one confirmation per message.
You are configuring a tool, not running a workshop.

**Reply language.** Everything you *say* follows `config.language` (`en` |
`ko`). Get it from `scale setup status --json` (`language`) or `scale config get
language`; before init, default to the language the user is writing in. CLI
commands, flags, config keys and values are **always English** — only your prose
switches. Keep code identifiers, file paths and component ids in English too.

---

## The CLI you may use

Only these. Do not invent flags.

| Command | What it gives you |
|---|---|
| `scale setup status --json` | `{ repoId, stateDir, initialized, user, memory:{present,components}, provider, keyPresent, gate:{assessment,modality,enforcement}, language, viewer:{url,running} }` |
| `scale init --user <label>` | creates `~/.scale/<repo-id>/` with a **sparse** config.json |
| `scale config get [key]` | the **effective** value (schema default < team policy < your override) |
| `scale config get <key> --explain [--json]` | the effective value **with provenance**: `gate.assessment = "async"  (source: user override; team default: "sync")` — JSON: `{ key, value, source: default\|policy\|user, policyValue?, defaultValue? }`. With no key: every leaf |
| `scale config set <key> <value>` | writes a personal override |
| `scale config unset <key>` | removes your override; the team/schema default applies again |
| `scale policy show` | the committed `.scale/policy.json`, the `leads` list, and whether you are a lead |
| `scale keys status [--json]` | per provider `{ present }`. Never prints key material |
| `scale keys set <anthropic\|openai> --stdin` | reads the key from **stdin only** — for the user's own terminal, never yours |
| `scale serve ensure [--json]` | reuse or start the viewer; prints the URL |
| `scale serve url [--component <id>] [--settings <tab>] [--json]` | the URL, without opening anything |
| `scale serve open [--component <id>] [--settings <tab>]` | ensure + open in the system browser; prints the URL |
| `scale status`, `scale map check` | coverage state (read-only) |

Settings tabs: `general` | `gate` | `checks` | `team`.

### Reading provenance

`scale config get <key> --explain` prints the effective value and where it came
from in one call — `source: default` (schema), `team policy` (committed
`.scale/policy.json`), or `user override` (yours). When the source is your
override it also shows the team default or schema default underneath, so you can
say "yours: async · team default: sync" the way the web Settings page shows its
chips. Use it whenever a key is in a policy section or the user asks why a value
is what it is; `scale config get <key>` alone is enough for a plain read.

A team policy sets **defaults, not rules**. A personal override is always
allowed and always wins — say so plainly rather than implying the user is stuck.

---

## Knob catalog

Anything the user says maps onto one of these keys. `scale config set` parses
the value as JSON when it can, so numbers and booleans are written bare
(`scale config set gate.enabled false`) and arrays need JSON quoting
(`scale config set exempt.paths '["docs/**","*.md"]'`).

**Personal only — a team policy can never set these.**

| Key | Values | Default | Meaning |
|---|---|---|---|
| `user` | any label | `$USER` | who you are in the study data |
| `language` | `en` \| `ko` | `en` | the language SCALE speaks to you in (docs under `.scale/` stay English) |
| `identity.emails` | list of git addresses | `[]` | your *other* git addresses, so drift is attributed to you |
| `models.provider` | `anthropic` \| `openai` | `anthropic` | which API backs quiz/Socratic generation |
| `models.intervention` | `sonnet` \| `opus` | `sonnet` | the tier that writes checks. The `/scale-map` build model is chosen with `/model`, not here |
| `models.openaiModel` | model id | unset | escape hatch to pin an OpenAI model the tier map doesn't know |

**Policy-settable sections** — `gate`, `quiz`, `unlock`, `exempt`, `drift`,
`budgets`, `thresholds`.

| Key | Values | Default | Meaning |
|---|---|---|---|
| `gate.enabled` | `true` \| `false` | `true` | master switch for the edit gate |
| `gate.assessment` | `sync` \| `async` | `sync` | where the check runs: now in chat (`sync`), or later in the viewer / `/scale-study` (`async`). Both gate identically |
| `gate.modality` | `quiz` \| `socratic` | `quiz` | multiple-choice items, or a ≤3-exchange dialogue |
| `gate.enforcement` | `advisory` \| `soft` \| `hard` | `soft` | how hard the deny holds; `hard` removes the skip offer from the deny text |
| `quiz.items` | `1`–`5` | `2` | MCQ items per check (quiz modality only) |
| `quiz.focus` | `auto` \| `structure` \| `concepts` \| `rationale` | `auto` | which coverage dimension items probe; `auto` targets the weakest and varies |
| `quiz.grounding` | `balanced` \| `diff` \| `doc` | `balanced` | what the stems are about; `doc` never shows the model your diff |
| `unlock.passBar` | `0`–`1` | `0.6` | a check's mean score must reach this to count as passed |
| `unlock.checksRequired` | ≥ `1` | `1` | passed checks needed to unlock a component |
| `exempt.paths` | globish patterns | `[]` | paths the gate never fires on (`*` within a segment, `**` across) |
| `drift.trigger` | `ratio` \| `any-foreign-commit` | `ratio` | what re-locks validated territory |
| `drift.foreignRatio` | `0`–`1` | `0.25` | someone else's churn ÷ component size that re-locks |
| `drift.selfRatio` | `0`–`1` | `0.8` | your own churn ÷ size that re-locks |
| `drift.digest` | `daily` \| `session` \| `off` | `daily` | how often SessionStart mentions drifted territory |
| `drift.shareDiff` | `full` \| `metadata` \| `off` | `full` | how much of a drifted change may reach the intervention model. **The privacy knob** — name it whenever the user asks about source leaving the machine |
| `budgets.maxPerSession` | ≥ `0` | `2` | most denies per work period; `0` means never interrupt |
| `budgets.cooldownMinutes` | ≥ `0` | `15` | quiet time after a deny |
| `budgets.sessionIdleResetMinutes` | ≥ `0` | `720` | idle backstop that ends a work period |
| `thresholds.emaAlpha` | `0`–`1` | `0.5` | weight on the newest score in the coverage EMA |
| `thresholds.validateDim` | number | `0.6` | weighted-dims bar for `validated` |
| `thresholds.passiveStructureCap` | number | `0.3` | cap on structure credit from passive touch alone |
| `thresholds.docReadCap` | number | `0.4` | cap on per-dim credit from a doc read |

---

## Setup mode

Triggered by `/scale-settings setup`, by `initialized: false` in `scale setup
status --json`, or by the user asking to set SCALE up.

Run `scale setup status --json` first — it tells you which steps are already
done, and you **skip every step that is**. Then, for each choice below, use the
**AskUserQuestion** tool: 2–4 options, the recommended one first and marked as
such, one question per call. After each answer, run the command and confirm the
stored value back in one line.

### 1. User label

`scale setup status --json` → `user`. If it is null, ask for the label (offer
their git name / `$USER` as options) and run:

```
scale init --user <label>
```

`init` creates `~/.scale/<repo-id>/` and writes a **sparse** config.json holding
only the label — everything else resolves at read time from schema defaults plus
the repo's team policy. If a config.json already exists, `init` prints `state
already initialized` and **changes nothing**; re-running it is therefore safe but
also a no-op. Do **not** pass `-f/--force` to "fix" that — force overwrites the
config and discards their existing overrides. To change the label on an already
initialized repo use `scale config set user <label>` instead.

### 2. Language

`en` (default) or `ko`. `scale config set language ko`. Switch your own replies
immediately after.

### 3. The edit gate

Three questions, each with the default first:

- `gate.assessment` — `sync` (check runs now, in chat; passing unlocks the edit)
  or `async` (you only get taught at deny time; you pass the check later in the
  viewer or with `/scale-study`).
- `gate.modality` — `quiz` (a couple of multiple-choice items) or `socratic`
  (a short reasoning dialogue, ≤3 exchanges).
- `gate.enforcement` — `soft` (deny, skipping offered), `advisory` (nudge only)
  or `hard` (deny, no skip offered in the text).

Each applies with `scale config set <key> <value>`.

All three live in the policy-settable `gate` section. Before asking, if
`scale policy show` says the team policy sets one of them, tell the user in one
clause — "your team's default is `soft`" — and note that a personal override is
allowed and will win. Then ask anyway.

### 4. Model

- `models.provider` — `anthropic` (default) or `openai`.
- `models.intervention` — `sonnet` (default, fast and cheap) or `opus`
  (stronger items, slower and pricier).

### 5. API key

**Never ask the user to paste a key into this conversation, and never run
`scale keys set` with a key as an argument.** A key in argv lands in shell
history and process listings. If the user pastes one anyway, do not use it, do
not repeat it, and tell them to rotate it.

Check first: `scale keys status --json`. If the chosen provider already reports
`present: true` (a key file, or `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` already in
their environment), say so and move on.

Otherwise offer exactly these two paths, as an AskUserQuestion:

1. **In the viewer (recommended).** Run `scale serve open --settings general` —
   or, if this session has a browser-preview tool (`preview_start`, `navigate`,
   the desktop app's built-in browser), get the URL with `scale serve url
   --settings general` and open it there. Give them the URL as a clickable link
   either way, and tell them to paste the key into the **API key** field. The
   viewer writes it to `~/.scale/keys.json` at mode 0600.
2. **In their own terminal.** They run, in a terminal you do not control:

   ```
   scale keys set anthropic --stdin
   ```

   (`openai` instead of `anthropic` if that is their provider). It reads the key
   from stdin only — they paste it there, and it never reaches this chat.

Then wait, and verify with `scale keys status --json` before continuing. If it
is still absent, offer the other path once; if they would rather skip, that is
fine — say plainly that checks needing the model (quiz/Socratic generation, doc
translation) will not run until a key exists, and continue.

### 6. Coverage memory

If `memory.present` is `false`, there is nothing for the gate to teach from
yet. Say so and **stop here**: the coverage memory is built by a **senior**,
once per repo, with `/scale-map` run on Opus or better. Do not offer to build it
for a junior, and do not run `/scale-map` yourself as part of setup.

### 7. Finish

Run `scale setup status --json` once more and close with:

- a four-line summary — user + language, gate (`assessment`/`modality`,
  `enforcement`), provider + tier + whether a key is present, memory
  (`components` count or "not built yet");
- the viewer URL from `viewer.url`, as a clickable link;
- one hint: **`/scale-open`** opens the map (add a component id to jump
  straight to it), and **`/scale-settings`** changes any of this later.

---

## Change mode

Anything that is not setup. The user may give you a dotted key and a value, or
plain language in any language. Examples that must work:

| They say | You do |
|---|---|
| "게이트를 async로 바꿔줘" | `scale config set gate.assessment async` |
| "switch to opus" | `scale config set models.intervention opus` |
| "turn the gate off" | `scale config set gate.enabled false` |
| "what's my quiz size?" | `scale config get quiz.items` — read-only, no write |
| "stop interrupting me so much" | offer `budgets.maxPerSession` (lower) or `gate.enabled false`; ask which |
| "don't send my code anywhere" | `scale config set drift.shareDiff off` (+ mention `quiz.grounding doc`) |
| "go back to the team default" | `scale config unset <key>` |
| `gate.modality socratic` | set it directly |
| `quiz.items` | get it |
| "show me my settings" / "gate settings" | `scale config get` or `scale config get gate` |

The loop, every time:

1. **Map** the request onto a key from the catalog. If two keys could be meant
   (the interruption case above), ask once with AskUserQuestion; do not guess.
   If the value is not in the key's allowed set, say what the allowed values are
   instead of writing an invalid one.
2. **Read** the current value first: `scale config get <key>`. If the key is in
   a policy section, also run `scale config get <key> --explain` so you can say
   whether today's value is theirs, the team's, or the schema's.
3. **Apply** with `scale config set <key> <value>` and relay the CLI's
   `scale: set …` line. To undo an override, `scale config unset <key>` — relay
   the value it falls back to.
4. **Report** in one or two lines: old → new, and any consequence worth one
   clause (`async` means checks move out of chat; `gate.enabled false` means no
   more denies at all; `models.provider openai` needs an OpenAI key — check
   `scale keys status --json` and run the key flow above if it is missing).

Read-only requests get a read, never a write. A question is not a change.

### Team policy

`scale config set` only ever writes the **user's** config. You never edit
`.scale/policy.json`. When the user wants a setting changed **for the team**:

- `scale policy show` — what is committed, the `leads` list, and whether they
  are a lead.
- Point them at the viewer's **Team** tab: `scale serve url --settings team`
  (or `scale serve open --settings team`), which is where policy edits happen.
- Say the honest thing the CLI says: `leads` gates that UI, not the file.
  `.scale/policy.json` is ordinary committed JSON, so review and CODEOWNERS on
  that path are the real control.
- `identity`, `user`, `language` and `models` are personal by construction — a
  policy cannot set them. If they ask for that, say so.

### Scope

Settings only. If the request is really about learning a component, hand it to
`/scale-study`; about coverage, to `/scale-status`; about the map, to
`/scale-open` or `/scale-map`. Don't refuse — route it in one line.
