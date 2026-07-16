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
| **`@scale/plugin`** | Claude Code plugin: hooks (capture + commit gate) and `/scale-*` skills/commands. Static, no build step. |
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
scale config set models.build opus          # BUILD:        opus | fable    (default opus)
scale config set models.intervention haiku  # INTERVENTION: sonnet | haiku  (default haiku)
```

Tokens resolve to concrete ids (`claude-opus-4-8`, `claude-fable-5`, `claude-sonnet-5`,
`claude-haiku-4-5`). The 2×2 study condition lives in the same config:

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

Install the plugin in the repo's `.claude/settings.json` so hooks + `/scale-*` commands
wire up:

```json
{ "plugins": ["/absolute/path/to/scale/packages/plugin"] }
```

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
`🧠 LLM/API` = may call the intervention model (needs `ANTHROPIC_API_KEY`; degrades to a
deterministic fallback offline).

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
| `scale serve [-p 4318]` | Serve the local web map viewer + JSON API. | ⚡/🧠 |
| `scale reset [-y]` | Delete the `~/.scale/<repo-id>/` state dir (demo/pilot reset). | ⚡ |

`scale serve` itself is pure Node; only its Socratic runner (`/api/socratic/:id/message`)
proxies the intervention model.

---

## Cost

- **Build (one-time, Opus/Fable).** ~$11 for a ~6k-LOC repo on Opus; Fable runs ~2× the
  output (always-on thinking) and costs more. `scale estimate` previews the exact figure
  per model before you commit.
- **Interventions (recurring, Sonnet/Haiku).** ~$0.15–$1 per session for quiz/Socratic
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

- **2×2 study auto-driving** — the tutor runs a check when invoked; nothing fires the
  configured modality automatically on schedule.
- **Mode A live co-construction** — building the memory alongside the junior in-flow (hook
  infrastructure exists; the mode does not).
- **Full drift / rebellion detection** — `scale map drift` reports SHAs only; per-component
  source-churn staleness isn't wired yet.
- **API-dependent paths** — LLM quest generation and the web Socratic proxy need an
  `ANTHROPIC_API_KEY`; both fall back to deterministic behavior offline (quest generation
  synthesizes items from the paper; the Socratic proxy is unavailable without a key).

---

## More

- **[`QUICKSTART.md`](./QUICKSTART.md)** — the step-by-step, works-today walkthrough.
- **[`PLAN.md`](./PLAN.md)** — the full design, schemas, and roadmap.
</content>
</invoke>
