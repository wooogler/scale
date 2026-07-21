# SCALE — Quickstart

**S**caffolded **C**overage-**A**ware **L**earning **E**ngine — a coverage memory
of a target codebase (built by a high-capability model), visualized as a
territory map, that helps a junior engineer build real comprehension while they
work in Claude Code. See `PLAN.md` for the full design.

This guide is the accurate, works-today path. Anything not yet functional is
called out in [What works / not yet](#what-works--not-yet).

> **Model policy (fixed).** Two tiers, and they never mix:
> - **BUILD** — the Mode B `scale-map` coverage-memory build — runs on **Opus 4.8
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

Set `models.openaiModel` to pin an explicit GPT model id instead. Build tokens map
to `claude-opus-4-8` / `claude-fable-5`.

The manipulated **2×2 study condition** lives in the same config:

```bash
scale config set condition.timing inflow|postsession
scale config set condition.modality quiz|socratic
```

---

## 3. Senior flow — build the coverage memory (per target repo)

Run in the target repo, in Claude Code, **on Opus or Fable**.

**Preview the cost first** (pure fs scan + arithmetic, no LLM/API):

```bash
scale estimate            # human table
scale estimate --json     # machine-readable
```

The estimate table lists **only the two build-tier models** (Opus 4.8, Fable 5) —
the intervention tier never builds. Fable costs more than Opus
(its always-on thinking emits ~1.5× output). Example (this repo):

```
repo: 40 files, 6,862 LOC → ~25 components

Build model  est. cost      est. time (single-agent)
-----------  -------------  ------------------------
Opus 4.8     $11.33         ~18 min
Fable 5      $22.67–$27.19  ~18 min
```

**Then build** with the `/scale-map` command (the Mode B skill): Survey (propose
5–9 provinces + 20–60 components, stops for your approval) → Write (subagent
fan-out) → Link (Related Work cross-links) → Layout. It stops for human approval
after Survey before writing anything.

The layout/index steps are deterministic CLI commands the skill calls (you can
also run them by hand):

```bash
scale map layout   # freeze .scale/map.json (spatial coords + importance) — committed
scale map index    # build .scale/index.json (file → component reverse index) — gitignored
```

`map.json` is frozen once and extended incrementally so the map stays spatially
stable. `scale map drift` reports the built-from SHA vs current HEAD (full
per-component churn detection is not yet wired — see below).

---

## 4. Junior flow — init + plugin

In the target repo:

```bash
scale init --user <label>   # creates ~/.scale/<repo-id>/ with a default config.json
```

Install the SCALE plugin so Claude Code wires the hooks + `/scale-*` commands. In
the repo's `.claude/settings.json`:

```json
{ "plugins": ["/absolute/path/to/scale/packages/plugin"] }
```

The plugin (see `packages/plugin/README.md`) captures evidence silently
(SessionStart context, prompt/edit signals) and runs the in-flow commit gate. All
hooks **fail open** — a missing/slow CLI degrades to a no-op and never blocks you.

### Comprehension checks (quiz / socratic)

Both modalities run in chat via the `scale-tutor` skill, grounded in the
component's paper (`concepts` + `rationale`). The active modality is
`condition.modality`:

- **quiz** — 1–2 grounded multiple-choice items.
- **socratic** — a short capped dialogue (≤3 exchanges).

Two ways to trigger a check yourself (available in every condition, no budget):

- `/scale-study [component-id]` — **voluntary learning**: a reading guide over the
  paper, then a check. Passing records a validation with `--origin voluntary`.
- `/scale-quiz [component-id]` — a manual/testing shortcut into the same tutor
  path without waiting for a commit.

Passing a check is recorded by the tutor via `scale record`, which updates
coverage (per-dim EMA) and can move a territory fog → explored → validated.

### The in-flow commit gate + defer

Under an **in-flow** condition, a `git commit` that touched fog/low-coverage/stale
territory triggers the gate (subject to the interruption budget: ≤1 per commit,
≤2 per session, ≥15 min cooldown, and never on a trivial diff below
`budgets.minChangedLines`, default 20). The gate **denies** the commit with a
reason telling the agent to run the tutor check; after `scale record` writes a
fresh validation marker, the retried commit passes.

To skip instead (the escape hatch — **defer = drop**, the territory simply stays
unconquered, nothing is queued):

```bash
scale gate defer <component-id>   # writes the deferred marker; retry the commit → allowed
```

Deferring is **the junior's call, not the agent's**. The deny message tells the
agent to put the check in front of you and never skip on your behalf; if an agent
skips a check on a commit it authored itself, it must use `--by agent` so the
evidence log doesn't record it as your decision.

The CLI's `scale gate commit` is pure git + file I/O (no LLM) and emits one JSON
line `{"allow":bool,"component":str|null,"reason":str|null}`; the plugin hook
turns `allow:false` into the commit-blocking deny. Under **post-session**
conditions the gate is a silent no-op.

---

## 5. The map viewer

```bash
scale serve --port 4318   # reads .scale/ from cwd + ~/.scale/<repo-id>/ state
```

Serves the React map app (build it first with `npm run build -w @scale/web`) plus
a JSON API (`/api/map`, `/api/coverage`, `/api/paper/:id`, `/api/quests`,
`/api/settings`). Provinces are tinted regions; components are nodes sized by
importance and colored by state (fog / explored / validated / stale). Click a node
for its rendered paper, dev stats, and any quests. The quest runner completes
quizzes fully locally; the socratic runner proxies the intervention model
server-side (needs an API key — see below).

The server binds **loopback only**. It has no authentication and accepts API keys,
so opening it to the network is an explicit `--host 0.0.0.0` opt-in.

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
`en` (pure English). The `.scale/` papers always stay English regardless: the
coverage memory is repo-shared, and `language` is a per-user preference.

**API keys.** Interventions run on Anthropic (default) or OpenAI; pick the provider
in Settings. The key comes from `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` if set
(these always win), otherwise from what you type in Settings, which is stored at
`~/.scale/keys.json` mode `0600`. The key is never returned by the API and never
logged — the UI shows only a masked tail. Start a Socratic dialogue with no key and
it tells you exactly what's missing with a button straight to the key field.

---

## 6. Post-session quests

Under a **post-session** condition, the `SessionEnd` hook runs `scale quest
generate` detached (never blocks exit). It picks the top-K (default 3) touched,
low-coverage/stale components by importance and generates items in the configured
modality on the **intervention model**:

```bash
scale config set condition.timing postsession
scale quest generate      # writes ~/.scale/<repo-id>/quests.json
scale quest list          # inspect pending quests
```

If no API key is available for the configured provider (or the API errors),
generation falls back to **deterministic** item synthesis from the paper — you
still get a valid `quests.json`. In-flow conditions generate no quests (a no-op).

Quests appear on the map as pending; you **complete them in the web app** (the
quest runner POSTs to `/api/quests/:id/complete` or `/api/socratic/:id/message`),
which records the result and moves the component's coverage. (`scale quest
complete` on the CLI is not yet implemented — completion is via the web runner.)

---

## What works / not yet

**Works today**

- CLI: `init`, `config get/set`, `log prompt|touch|review`, `gate commit`, `gate
  defer`, `record`, `coverage recompute`, `estimate`, `map layout|index`, `quest
  generate|list`, `serve`, `reset`.
- Plugin: all hooks (fail-open) + `/scale-map`, `/scale-status`, `/scale-study`,
  `/scale-quiz`. (`/scale-status` reports via `scale context`.)
- In-flow gate: deterministic deny/allow with budget enforcement + `gate defer`.
- Interventions: quiz + socratic in chat; post-session quest generation (LLM with
  deterministic fallback); web quest runner (quiz offline; socratic needs an API
  key). All four 2×2 cells switch by `config.json`.
- Web map viewer + JSON API; coverage materialized from evidence.

**Not yet**

- **2×2 study auto-driving** — the tutor runs a check when invoked, but there is no
  automated driver that fires the configured modality on schedule.
- **Mode A live co-construction** — building the memory alongside the junior in the
  flow (the hook infrastructure exists; the mode does not).
- **Full drift / rebellion detection** — `scale map drift` reports SHAs only;
  per-component source-churn staleness is not yet wired.
- **`scale quest complete` (CLI)** — a stub; complete quests via the web runner.
- Senior rationale interviews (schema-ready via `provenance`) and study-logging /
  condition-assignment infra are deferred (`PLAN.md` §11).

Build steps run on **Opus/Fable**; every intervention (quiz/socratic, quest
generation, socratic proxy) runs on the **Sonnet 5 / Opus 4.8 tier** — or
`gpt-5.6-terra` / `gpt-5.6-sol` when the provider is OpenAI.
