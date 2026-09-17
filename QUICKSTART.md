# SCALE — Quickstart

**S**caffolded **C**overage-**A**ware **L**earning **E**ngine — a coverage memory
of a target codebase (built by a high-capability model), visualized as a
territory map, that helps a junior engineer build real comprehension while they
work in Claude Code. See `PLAN.md` for the full design.

This guide is the accurate, works-today path. Anything not yet functional is
called out in [What works / not yet](#what-works--not-yet).

> **Model policy (fixed).** Two tiers, and they never mix:
> - **BUILD** — the Mode B `scale-map` coverage-memory build — runs on **Opus 5
>   or Fable 5 only**.
> - **INTERVENTION** — quiz/socratic tutor, post-session quest generation, the web
>   socratic proxy — runs on the **Sonnet 5 / Opus 4.8 tier** (or the matching
>   GPT-5.6 models when `models.provider` is `openai`).

---

## 1. One-time setup

Requires Node 18+ (the CLI and web app are TypeScript; npm workspaces).

```bash
git clone <this repo> && cd scale
npm install
npm run build              # tsc -b — builds @scale/core + @scale/cli
npm run build -w @scale/web  # builds the map web app (needed for `scale serve`)
```

**Invoking the `scale` CLI.** The `scale` binary is defined by `@scale/cli` but is
not installed globally by default. Any of these work:

```bash
node packages/cli/dist/index.js <args>   # after `npm run build` (used throughout)
npm run cli -- <args>                     # runs from source via tsx (no build needed)
npm link packages/cli                     # then plain `scale <args>` on PATH
```

Below, `scale` means any of the above. Every command runs against the **current
working directory**: the target repo's `.scale/` coverage memory plus per-user
state under `~/.scale/<repo-id>/` (repo-id derived from the git remote, else the
repo folder name).

---

## 2. Configure the models

`scale init` writes a default `config.json`; `scale config` reads/writes it. You
must `scale init` before `config get/set` will work.

```bash
scale config set models.intervention sonnet # INTERVENTION tier: sonnet | opus (default sonnet)
scale config set models.provider anthropic  # INTERVENTION api: anthropic | openai
scale config get models                     # { "intervention": ..., "provider": ... }
```

Only the **intervention** tier is configured here — it is the one SCALE calls
through the API itself. The **build** model is not a setting: `/scale-map` runs
inside a Claude Code session, so it uses whatever model that session is on. Pick
it with **`/model`** before building.

The schema only accepts `sonnet|opus`; anything else fails validation. The token
resolves per provider, so switching provider keeps the tier you chose:

| `models.intervention` | `provider: anthropic` | `provider: openai` |
|---|---|---|
| `sonnet` | `claude-sonnet-5` | `gpt-5.6-terra` |
| `opus` | `claude-opus-4-8` | `gpt-5.6-sol` |

Set `models.openaiModel` to pin an explicit GPT model id instead. There is **no
build-model config key** — `/scale-map` runs inside a Claude Code session, so the
build model is whatever that session is on; pick it with `/model` beforehand.

The **edit gate** is configured in the same file — and every value you set is a
personal override on top of the team's committed defaults in `.scale/policy.json`
(PLAN-GATE §2; `scale config get` shows the effective merge):

```bash
scale config set gate.assessment sync|async      # check in chat now vs unlock later
scale config set gate.modality quiz|socratic
scale config set gate.enforcement advisory|soft|hard
scale config set gate.enabled false              # opt yourself out entirely
```

---

## 3. Senior flow — build the coverage memory (per target repo)

Run in the target repo, in Claude Code, **on Opus or Fable**.

**Preview the cost first** (pure fs scan + arithmetic, no LLM/API):

```bash
scale estimate            # human table
scale estimate --json     # machine-readable
```

The estimate prints the **target component count and the band the build must land
in**, the province shape that count implies, and whether the count is capped by
how many source files there are to anchor to. Then it prices the build.

The estimate table lists **only the two build-tier models** (Opus 5, Fable 5) —
the intervention tier never builds. Both are quoted as a band: the calibration run
was Opus 4.8 with thinking off, and both build models think by default, so the low
end is that measurement and the high end is ~1.5× output. Fable's rates are 2×
Opus's on top of that. Shape of the output (figures move with the repo — run it
yourself for the current ones):

```
repo: 54 files, 17,671 LOC → ~54 components (build within 36–81)
  capped by FILE COUNT: this repo wants ~64, but sources anchor whole files, so 54 file(s) resolve at most 54 components.
  Going finer would put several components on one file, and the edit gate, coverage
  credit and drift all key off the file — they would move together.
  shape: 6 top-level group(s), 1 grouping level(s) above the components.

Build model  est. cost      est. time (single-agent)
-----------  -------------  ------------------------
Opus 5       $29.18–$35.02  ~46 min
Fable 5      $58.37–$70.03  ~46 min
```

**Then build** with the `/scale-map` command (the Mode B skill): Survey (propose
the number of components `scale estimate` sized the repo for, grouped into
provinces of 5–9, stopping for your approval) → Write (subagent fan-out) → Link
(`Related components` cross-links) → Layout → Check. It stops for human approval after
Survey before writing anything, and again if its honest partition falls outside
the estimate's band.

**Then verify** the partition is one the tool can actually work with:

```bash
scale map check
```

It compares the built count against the estimate's band, measures components per
anchored file, and exits non-zero when the partition is too fine to route an edit
through. A partition finer than one component per source file breaks the edit
gate, coverage credit and drift at once, because all three key off the file.

The layout/index steps are deterministic CLI commands the skill calls (you can
also run them by hand):

```bash
scale map layout   # freeze .scale/map.json (spatial coords + importance) — committed
scale map index    # build .scale/index.json (file → component reverse index) — gitignored
```

`map.json` is frozen once and extended incrementally so the map stays spatially
stable. `scale map drift` reports the built-from SHA vs current HEAD; the
per-component churn detection that matters to a junior is not this command but
[Drift](#drift--when-someone-changes-your-territory), which runs on
every recompute.

---

## 4. Junior flow — init + plugin

In the target repo:

```bash
scale init --user <label>   # creates ~/.scale/<repo-id>/ with a default config.json
```

Install the SCALE plugin so Claude Code wires the hooks + `/scale-*` commands.
From this clone:

```bash
npm run plugin:install     # then quit and reopen Claude Code
npm run plugin:status      # confirm what is registered and which version runs
```

`npm run plugin:uninstall` reverses it and `npm run plugin:reload` pushes your
edits into the plugin cache without a version bump; `scripts/plugin.mjs --help`
lists the rest. If you are not going to change SCALE, skip the clone entirely:
`claude plugin marketplace add wooogler/scale` then
`claude plugin install scale@scale-marketplace` (see
`packages/plugin/README.md` → Install, path A).

There is no `plugins` key in `.claude/settings.json`; installing writes
`enabledPlugins` in `~/.claude/settings.json`. Confirm what is actually running
with `scale --version` — it prints the installed plugin's release, and a number
behind `packages/plugin/.claude-plugin/plugin.json` means the session is serving
a stale cache (`packages/plugin/README.md` has the release procedure).

The plugin (see `packages/plugin/README.md`) captures evidence silently
(SessionStart context, prompt/edit signals) and runs the edit gate. All
hooks **fail open** — a missing/slow CLI degrades to a no-op and never blocks you.

### Comprehension checks (quiz / socratic)

Both modalities run in chat via the `scale-tutor` skill, grounded in the
component doc (`concepts` + `rationale`). The active modality is
`gate.modality`:

- **quiz** — 1–2 grounded multiple-choice items.
- **socratic** — a short capped dialogue (≤3 exchanges).

Two ways to trigger a check yourself (available in every condition, no budget):

- `/scale-study [component-id]` — **voluntary learning**: a reading guide over the
  doc, then a check. Passing records a validation with `--origin voluntary`.
- `/scale-quiz [component-id]` — a manual/testing shortcut into the same tutor
  path without waiting for the gate.

To read a doc on its own, with no check attached:

```bash
scale doc show <component-id>             # the English source
scale doc show <component-id> --lang ko   # per-user translation (--refresh rebuilds)
```

A non-English `--lang` calls the intervention model once and caches the result in
`~/.scale/<repo-id>/translations/`, keyed by a hash of the doc file, so editing the
doc invalidates it; with no API key you get the English source plus a note. Checks
are always grounded in the English source, never in the translation.

Passing a check is recorded by the tutor via `scale record`, which updates
coverage (per-dim EMA), can move a territory fog → explored → validated — and,
when the check's mean score reaches `unlock.passBar` (default 0.6), **unlocks the
territory durably** for editing (PLAN-GATE §3.1).

### The edit gate + defer

Every territory starts **locked** for you (except components already `validated`).
When the agent tries to Edit/Write a file anchored to a locked component, the
gate **denies the edit** (subject to the interruption budget: ≤2 denies per
session, ≥15 min cooldown; the component just denied stays denied until it is
checked or skipped). What happens next depends on `gate.assessment`:

- **sync** — the tutor runs the check right there in chat; a pass unlocks the
  territory durably and the retried edit goes through.
- **async** — the agent TEACHES the component instead (no quiz in chat), and you
  unlock later: in the map viewer's quest runner, or with `/scale-study` in a
  later session. The edit stays blocked for now unless you skip.

To skip (under `soft` enforcement — `hard` disables it):

```bash
scale gate defer <component-id>   # session-scoped unlock; retry the edit → allowed
```

A skip unlocks that territory for **this session only** — it locks again next
session. Skipping is **the junior's call, not the agent's**; an agent editing
with no junior in the loop must use `--by agent` so the evidence log doesn't
record it as your decision.

The CLI's `scale gate edit` is pure file I/O (no LLM, no git churn scan) and
emits one JSON line `{"allow":bool,"component":str|null,"reason":str|null}`; the
plugin hook turns `allow:false` into the edit-blocking deny.

### Drift — when someone changes your territory

Unlocking is durable, but not unconditional: if the code you demonstrated moves,
your understanding of it is out of date. On every recompute (SessionStart, and
after each check) SCALE measures each validated component's churn since the sha
you validated it at, **split by who authored the commits**:

- **A collaborator's change** — the map calls this **함락 / Fallen** — re-locks the
  territory once it passes
  `drift.foreignRatio` (default 0.25 of the component's size). The territory
  goes `stale`, leaves your unlock ledger, and SessionStart tells you once a day
  who changed it. The next edit into it is denied with a message that says you
  *did* demonstrate it and points the check at what changed.
- **Your own change** — **재건 / Rebuilt** — uses a much higher bar (`drift.selfRatio`, default 0.8)
  — the gate already cleared you before you wrote it, so re-locking you on your
  own work would mostly measure how much you typed. The high bar still catches
  the real case: unlocking with one check and then rewriting the thing wholesale.

One passing check recovers it, and that check is grounded in **what actually
changed** — the commits, the files, the declarations touched, and a clipped
excerpt of the diff. That excerpt is someone else's code entering a prompt, so
it travels inside an explicit untrusted-data fence, and `drift.shareDiff`
decides how much of it reaches the API: `full` (metadata + diff), `metadata`
(no source lines), or `off`. `scale status` shows which territories are
re-locked, and your git identity plus how much of recent history it matches — a
mismatched `user.email` is the one failure that would otherwise be invisible.

Attribution uses the mailmap-canonical **author** (never the committer), so
merging a teammate's PR credits their churn to them, not to you. With no
resolvable identity, everything reads as yours: a missing `user.email` can never
lock you out of your own codebase.

---

## 5. The map viewer

```bash
scale serve --port 4318   # reads .scale/ from cwd + ~/.scale/<repo-id>/ state
```

Serves the React map app (build it first with `npm run build -w @scale/web`) plus
a JSON API (`/api/map`, `/api/coverage`, `/api/doc/:id`,
`POST /api/doc/:id/translation`, `/api/quests`, `/api/locks`, `/api/settings`).
Provinces are tinted regions; components are nodes sized by importance and colored
by state (fog / explored / validated / 함락·재건). A 🔒 badge marks a territory that
still **owes a check** from a denied edit; the header counts them. Click a node for
its rendered component doc — including its `Design decisions` entries — plus dev
stats and any quests. When your `language` is `ko` the panel shows the translation,
with a toggle back to the original.
The quiz runner sends your picks to the server, which grades them and returns the
reveal (the answer key never reaches the browser); the socratic runner proxies the
intervention model server-side (needs an API key — see below). Passing either
unlocks the component for editing.

The server binds **loopback only** by default. To open the map on your phone:

```bash
scale serve --host 0.0.0.0
```

It prints a `http://<lan-ip>:4318/?token=…` URL — open that. Off loopback every
API call needs the token (the page keeps it for the tab); the static bundle does
not. Whoever has the URL can read your coverage and change your settings, so share
it like a password. `--token <value>` pins your own.

Every gate and budget knob in Settings shows where its value comes from —
`default`, `team default`, or `yours` — and a `↺` beside anything that is yours
puts the team default back (CLI: `scale config unset gate.enforcement`).

### Settings (⚙ in the header)

Everything in `config.json` is editable from the browser — interaction language
(the **Language** row at the top), condition (timing × modality), in-flow
triggers, interruption budgets, and the model policy — plus API keys. Changes
save immediately and are re-validated server-side against the schema, so an
invalid value is rejected instead of landing on disk.

**Language.** `scale config set language ko` (or the Language row in the modal)
switches everything SCALE says to you into Korean — the web UI, quiz items,
Socratic dialogue, and in-flow check delivery — while code identifiers, file
paths, and established dev terms (EMA, hook, commit…) stay English. Default is
`en` (pure English). The `.scale/` component docs always stay English regardless:
the coverage memory is repo-shared, and `language` is a per-user preference — a
`ko` reading of a doc is a per-user translation rendered on the way to the screen
and cached under `~/.scale/<repo-id>/translations/`, never written back to `.scale/`
and never used to ground a check.

**API keys.** Interventions run on Anthropic (default) or OpenAI; pick the provider
in Settings. The key comes from `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` if set
(these always win), otherwise from what you type in Settings, which is stored at
`~/.scale/keys.json` mode `0600`. The key is never returned by the API and never
logged — the UI shows only a masked tail. Start a Socratic dialogue with no key and
it tells you exactly what's missing with a button straight to the key field.

---

## 6. Post-session quests

Under **async assessment**, the `SessionEnd` hook runs `scale quest generate`
detached (never blocks exit). It picks the top-K (default 3) touched,
low-coverage/stale components by importance and generates items in the configured
modality on the **intervention model**:

```bash
scale config set gate.assessment async
scale quest generate      # writes ~/.scale/<repo-id>/quests.json
scale quest list          # inspect pending quests
```

If no API key is available for the configured provider (or the API errors),
generation falls back to **deterministic** item synthesis from the doc — you
still get a valid `quests.json`. Sync-assessment users generate no quests (their
checks happen in chat).

Quests appear on the map as pending; you **complete them in the web app** (the
quest runner POSTs to `/api/quests/:id/complete` or `/api/socratic/:id/message`),
which records the result and moves the component's coverage. `scale quest
complete <questId> --results '<json>'` does the same from the CLI — both paths
share one implementation, and a passed quest **unlocks the territory** exactly
like an in-chat check.

---

## What works / not yet

**Works today**

- CLI: `init`, `config get/set` (layered over `.scale/policy.json`), `log
  prompt|touch|review`, `gate edit`, `gate defer`, `record`, `coverage recompute`,
  `estimate`, `map layout|index`, `doc show`, `quest generate|list|complete`,
  `serve`, `reset`.
- Plugin: all hooks (fail-open) + `/scale-map`, `/scale-status`, `/scale-study`,
  `/scale-quiz`. (`/scale-status` reports via `scale status`.)
- The edit gate: deterministic lock/deny with the per-user unlock ledger
  (`locks.json`), team-policy defaults + personal overrides, budget enforcement,
  and session-scoped `gate defer`.
- Interventions: quiz + socratic in chat; async quest generation (LLM with
  deterministic fallback); web quest runner (quiz offline; socratic needs an API
  key). Both completion paths unlock territory.
- Web map viewer + JSON API; coverage materialized from evidence.
- Async completion: pending unlocks (SessionStart count, 🔒 in the viewer,
  `/api/locks`), server-side quiz grading, LAN bearer token for a phone.
- Settings provenance + reset; local study telemetry in
  `~/.scale/<repo-id>/telemetry.jsonl` (README → "Study telemetry").

**Not yet** (staged in PLAN-GATE §4)

- **Telemetry collection** — `telemetry.jsonl` is written locally (see
  `scale telemetry summary`); nothing is sent anywhere yet.
- **Mode A live co-construction** — building the memory alongside the junior in the
  flow (the hook infrastructure exists; the mode does not).
- **`scale map drift`** — still a stub reporting SHAs only. Per-component staleness
  itself is wired (it runs on every recompute — see Drift); this senior-side
  reporting command never caught up.
- Senior rationale interviews (schema-ready via `provenance`) and study-logging
  infra are deferred (`PLAN.md` §11).

Build steps run on **Opus/Fable**; every intervention (quiz/socratic, quest
generation, socratic proxy) runs on the **Sonnet 5 / Opus 4.8 tier** — or
`gpt-5.6-terra` / `gpt-5.6-sol` when the provider is OpenAI.
