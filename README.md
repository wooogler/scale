# SCALE

**S**caffolded **C**overage-**A**ware **L**earning **E**ngine — a coverage memory of a
codebase (built once by a high-capability model, frozen as a spatial "territory map")
that keeps a junior engineer's real comprehension in sync while they work in Claude Code.

Two users, one map:

- **Senior** builds and maintains the coverage memory — a set of markdown "papers", one
  per component, anchored to source files at a git SHA.
- **Junior** learns while coding with Claude Code — passive signals plus active quiz /
  Socratic checks track how well they actually understand each component, and lightweight
  interventions nudge comprehension up before it drifts.

> Research prototype targeting UIST. See [`PLAN.md`](./PLAN.md) for the full design and
> [`QUICKSTART.md`](./QUICKSTART.md) for the step-by-step, works-today path.

---

## Why

Codebases now grow faster than a junior can understand them: an agent can produce more
code in an afternoon than a person can genuinely internalize in a week. Ship velocity goes
up, comprehension falls behind, and the human slowly loses the mental model needed to
review, debug, and own the system.

SCALE treats the codebase as a **territory to be mapped**. The senior charts the territory
once; as the junior works, SCALE tracks which components they've actually explored,
scouted, and conquered — and surfaces the gaps — so the human's understanding stays synced
to the code they're shipping.

---

## How it works

- **Coverage memory (`.scale/`).** One markdown paper per component (frontmatter: stable
  `id`, `sources`, quizzable `concepts`, `rationale`), grouped into 5–9 provinces. A frozen
  `map.json` gives each component stable spatial coordinates and an importance weight; an
  `index.json` reverse-maps files → components. The memory is git-versioned and anchored to
  a build SHA.
- **Comprehension, per component × 3 dimensions** — **structure / concepts / rationale** —
  materialized from evidence: *passive* signals (files touched, prompts, diff-review
  latency) plus *active* quiz / Socratic checks. Each component has a skin-neutral state:
  `fog` → `explored` → `validated`, with `stale` when its sources drift.
- **Interventions in two timings.** *In-flow*: a deterministic pre-commit gate denies a
  commit that touched low-coverage territory until a comprehension check is recorded
  (budget-limited, always deferrable). *Post-session*: quests generated for the touched,
  low-coverage components, completed later in chat or the map viewer.
- **Game skin is UI only.** territory / conquest / rebellion (and importance-sized castles)
  are a rendering layer over the neutral `component` / `coverage` / `staleness` model —
  schemas and code never use game terms.

---

## Architecture

Monorepo, TypeScript throughout (npm workspaces), so CLI, hooks, and web share one schema.

| Package | Role |
|---|---|
| **`@scale/core`** | Shared engine: zod schemas, coverage model, paper loader, file→component index, layout, drift, cost estimator. |
| **`@scale/cli`** | The `scale` CLI wrapping core (also the binary the plugin hooks call). |
| **`@scale/plugin`** | Claude Code plugin: hooks (capture + commit gate) and `/scale-*` skills/commands. Ships two **generated, committed** payloads — `bin/scale.mjs` (the bundled CLI) and `web-dist/` — so it stays self-contained; regenerate with `npm run build:plugin`. |
| **`@scale/web`** | React + Vite + SVG map viewer served by `scale serve`, plus a local JSON API. |

---

## Install

Requires Node 18+.

```bash
git clone <this repo> && cd scale
npm install
npm run build                 # tsc -b — builds @scale/core + @scale/cli
npm run build -w @scale/web   # builds the map viewer (needed for `scale serve`)
```

Invoking the CLI (`scale` is not installed globally by default — any of these work):

```bash
node packages/cli/dist/index.js <args>   # after npm run build (used below)
npm run cli -- <args>                     # from source via tsx, no build needed
npm link packages/cli                     # then plain `scale <args>` on PATH
```

Every command runs against the **current working directory**: the target repo's `.scale/`
coverage memory plus per-user state under `~/.scale/<repo-id>/` (repo-id from the git
remote, else the folder name).

---

## Usage

### Configure the models (fixed two-tier policy)

```bash
scale config set models.intervention sonnet  # INTERVENTION: sonnet | opus   (default sonnet)
scale config set models.provider anthropic   # INTERVENTION api: anthropic | openai
```

Only the **intervention** tier is configured — quiz/Socratic checks, quest generation, and
the web Socratic proxy, which SCALE calls through the API itself. The **build** model is
not a setting: `/scale-map` runs inside a Claude Code session, so it uses whatever model
that session is on. Pick it with **`/model`** (Opus 5 or Fable 5) before you build; the
skill's confirm gate states which model it is running on and stops if it's neither.

The intervention tier is one token across both providers, so switching provider keeps the
tier you chose:

| `models.intervention` | `provider: anthropic` | `provider: openai` |
|---|---|---|
| `sonnet` | `claude-sonnet-5` | `gpt-5.6-terra` |
| `opus` | `claude-opus-4-8` | `gpt-5.6-sol` |

Set `models.openaiModel` (CLI only) to pin an explicit GPT model id instead of the tier
mapping. The 2×2 study condition lives in the same config:

```bash
scale config set condition.timing inflow|postsession
scale config set condition.modality quiz|socratic
```

### Senior — build the coverage memory (once per repo, on Opus/Fable)

```bash
scale estimate                 # preview per-model cost/time (pure fs scan, no LLM)
# → build the papers with the /scale-map skill: Survey (approval gate) → Write → Link → Layout
scale map layout               # freeze .scale/map.json (spatial coords + importance)
scale map index                # build .scale/index.json (file → component reverse index)
```

### Junior — init, then learn while coding

```bash
scale init --user <label>      # create ~/.scale/<repo-id>/ with a default config.json
```

Install the plugin so hooks + `/scale-*` commands wire up. The repo root ships
`.claude-plugin/marketplace.json`, so:

```bash
claude plugin marketplace add /absolute/path/to/scale
claude plugin install scale@scale-marketplace
```

(There is no `plugins` key in `.claude/settings.json`; installing writes
`enabledPlugins` in `~/.claude/settings.json`. See `packages/plugin/README.md`
for the release procedure — a plugin update needs a version bump.)

Then work normally in Claude Code:

- **Learn:** `/scale-study [id]` (voluntary reading guide + check) or `/scale-quiz [id]`
  (manual check) — MCQ quiz or short Socratic dialogue per `condition.modality`.
- **In-flow gate:** under an `inflow` condition, a commit touching fog/low-coverage/stale
  territory is denied until a check is recorded; `scale gate defer <id>` skips it.
- **Check progress:** `scale status` (coverage at a glance) and `scale serve` (the map).
- **Post-session:** under a `postsession` condition, `scale quest generate` produces quests
  for touched components; complete them with `scale quest complete` or in the map viewer.

---

## CLI commands

`⚡ hot-path` = deterministic git + file I/O, no network (safe on the commit path).
`🧠 LLM/API` = may call the intervention model (needs an API key — see
[API keys](#api-keys); degrades to a deterministic fallback offline).

| Command | What it does | |
|---|---|---|
| `scale init [--user <l>] [--force]` | Create `~/.scale/<repo-id>/` with a default `config.json`. | ⚡ |
| `scale status [--json]` | Coverage at a glance: unification progress, per-province states, stale territory, pending quests. | ⚡ |
| `scale context` | Print the SessionStart coverage summary injected to the agent. | ⚡ |
| `scale estimate [--json]` | Estimate the scale-map build cost per model before you run it. | ⚡ |
| `scale config get [key]` / `set <key> <val>` | Read/write `config.json` (condition, models, budgets, thresholds). | ⚡ |
| `scale log prompt \| touch \| review` | Append a raw passive signal to `evidence.jsonl` (hook fast-append). | ⚡ |
| `scale gate commit` | Decide if a pre-commit check should fire; prints one JSON line, always exit 0. | ⚡ |
| `scale gate defer <id>` | Skip the pre-commit check for a component (defer = drop). | ⚡ |
| `scale record <id> [-d -s \| --socratic]` | Record a quiz/Socratic validation outcome; updates coverage. | ⚡ |
| `scale coverage recompute` | Re-materialize `coverage.json` from `evidence.jsonl`. | ⚡ |
| `scale quest generate [-k N]` | Generate quests for touched, low-coverage components. | 🧠 |
| `scale quest list` | List pending/completed quests from `quests.json`. | ⚡ |
| `scale quest complete <id> --results \| --socratic` | Record a quest outcome, mark it completed, update coverage. | ⚡ |
| `scale map layout` | Compute/extend the frozen spatial layout → `.scale/map.json`. | ⚡ |
| `scale map index` | Build the file→component reverse index → `.scale/index.json`. | ⚡ |
| `scale map drift` | Flag components whose sources changed since the build SHA (minimal stub). | ⚡ |
| `scale serve [-p 4318] [--host <addr>]` | Serve the local web map viewer + JSON API. | ⚡/🧠 |
| `scale reset [-y]` | Delete the `~/.scale/<repo-id>/` state dir (demo/pilot reset). | ⚡ |

`scale serve` itself is pure Node; only its Socratic runner (`/api/socratic/:id/message`)
proxies the intervention model. It binds **loopback only** by default: the server has no
authentication and accepts API keys, so `--host` is an explicit opt-in (e.g. to open the
map on a phone over a trusted LAN).

---

## Settings

Everything below lives in `~/.scale/<repo-id>/config.json`. Edit it with `scale config
set <key> <value>`, or open the **⚙ Settings** modal in `scale serve` — a **Language**
row at the top, then the rest — same file, same validation, no terminal needed.

| Setting | Values | What it changes |
|---|---|---|
| `language` | `en` \| `ko` | Interaction language for everything SCALE says to you — web UI, quiz items, Socratic dialogue, in-flow checks. Code identifiers, file paths, and established dev terms stay English. Default `en`. |
| `condition.timing` | `inflow` \| `postsession` | Interrupt while working vs. at session end. |
| `condition.modality` | `quiz` \| `socratic` | Multiple choice vs. dialogue. |
| `inflow.triggers` | `pre-commit` | Which in-flow moments the gate fires on. The schema also accepts `post-task`, but **nothing implements it** — there is no Stop hook, so enabling it alone yields a silently zero-intervention session. |
| `budgets.*` | non-negative numbers | Interruption ceiling: per commit, per session, cooldown, minimum changed lines. `0` means "off". |
| `models.provider` | `anthropic` \| `openai` | Which API serves **interventions**. |
| `models.intervention` | `sonnet` \| `opus` | Intervention tier; resolves per provider (see table above). |
| `models.openaiModel` | any model id | Optional override pinning an explicit GPT model. |

The build model is not listed: `/scale-map` runs inside a Claude Code session and uses
that session's model (`/model`), so a setting here could only state an intention it cannot
enforce. Only interventions follow `models.provider`.

`language` never touches the coverage memory: the `.scale/` papers are always written in
English — they are repo-shared state, and `language` is a per-user interaction preference.

### API keys

Interventions (Socratic dialogue, LLM-written quests) need a key for the selected provider:

1. **Environment** — `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. Always wins.
2. **Settings modal** — ⚙ in `scale serve`. Stored in `~/.scale/keys.json` at mode `0600`,
   user-global (a key is an account credential, not project state).

The key is never returned by the API and never logged — the UI only ever shows a masked
tail (`sk-…9f2A`) and where it came from. With no key, quest generation falls back to
deterministic paper-grounded items and the Socratic runner says exactly what's missing and
links to Settings.

---

## Cost

- **Build (one-time, Opus 5 / Fable 5).** ~$11 for a ~6k-LOC repo. Both build models
  think by default, which the calibration run did not, so each is quoted as a low–high
  band at ~1.5× output; Fable's rates are 2× Opus's on top of that. `scale estimate`
  previews the exact figure per model before you commit.
- **Interventions (recurring, Sonnet 5 / Opus 4.8 tier).** ~$0.15–$1 per session for quiz/Socratic
  checks and quest generation.

The build is expensive but happens once; interventions are cheap because they repeat every
session — which is why the two tiers never mix.

---

## What works / not yet

**Works today** — the full loop: build the memory (`/scale-map` on Opus/Fable) → `scale
map layout`/`index` → coverage materialized from evidence → quiz + Socratic checks in chat
→ deterministic in-flow commit gate (with budget + `gate defer`) → `scale status` → post-
session `scale quest generate`/`list`/`complete` (CLI and web share one completion path) →
web map viewer + JSON API. All four 2×2 condition cells switch by `config.json`.

**Not yet**

- **`inflow.triggers: post-task`** — accepted by the schema and shown in the Settings
  modal, but no Stop hook exists. Turning it on (with `pre-commit` off) produces a
  session that looks like `inflow` and delivers no interventions.
- **2×2 study auto-driving** — the tutor runs a check when invoked; nothing fires the
  configured modality automatically on schedule.
- **Mode A live co-construction** — building the memory alongside the junior in-flow (hook
  infrastructure exists; the mode does not).
- **Full drift / rebellion detection** — `scale map drift` reports SHAs only; per-component
  source-churn staleness isn't wired yet.
- **API-dependent paths** — LLM quest generation and the web Socratic proxy need an API key
  (Anthropic or OpenAI); both fall back to deterministic behavior offline (quest generation
  synthesizes items from the paper; the Socratic proxy is unavailable without a key).

---

## Repo tooling

```bash
npm run build:plugin   # regenerate the plugin payload (bin/scale.mjs + web-dist/)
npm run check:map      # audit .scale/ against the code — read-only, no API, free
```

**`check:map`** ([`scripts/graphify-check.mjs`](./scripts/graphify-check.mjs)) is the
only check that the coverage memory still matches the code. It reports stale anchors
(what changed since `map.json`'s `builtFromSha`), orphan source files no component
claims, anchors pointing at files that no longer exist, and double-claimed files. Given
a [graphify](https://github.com/Graphify-Labs/graphify) extraction it adds link
precision/recall and cohesion against the AST. It never writes anything.

**`.graphifyignore`** excludes `packages/plugin/bin/` and `web-dist/` from a graphify
extraction. Those are generated payloads the plugin commits on purpose, so `.gitignore`
does not cover them; leaving them in supplied 67% of the nodes on the first run and
double-counted every symbol. Do not delete the file because nothing imports it.

CI ([`.github/workflows/ci.yml`](./.github/workflows/ci.yml)) typechecks and tests on
Node 20/22, and separately rebuilds the plugin payload and fails if it differs from
what is committed.

---

## More

- **[`QUICKSTART.md`](./QUICKSTART.md)** — the step-by-step, works-today walkthrough.
- **[`PLAN.md`](./PLAN.md)** — the full design, schemas, and roadmap.
