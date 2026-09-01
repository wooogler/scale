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
- **The edit gate** (PLAN-GATE). Territory is **locked** per user until they pass a
  comprehension check: an Edit/Write reaching into locked territory is denied
  (budget-limited, deterministic), and a passed check unlocks it **durably**. Two
  assessment venues, same lock: `sync` runs the check in chat right there; `async`
  teaches at deny time and the junior unlocks later in the map viewer or via
  `/scale-study`. Team leads set defaults in a committed `.scale/policy.json`;
  every member may override any knob in their own config.
- **Game skin is UI only.** territory / conquest / fallen-or-rebuilt (and importance-sized castles)
  are a rendering layer over the neutral `component` / `coverage` / `staleness` model —
  schemas and code never use game terms.

---

## Architecture

Monorepo, TypeScript throughout (npm workspaces), so CLI, hooks, and web share one schema.

| Package | Role |
|---|---|
| **`@scale/core`** | Shared engine: zod schemas, coverage model, paper loader, file→component index, layout, drift, cost estimator. |
| **`@scale/cli`** | The `scale` CLI wrapping core (also the binary the plugin hooks call). |
| **`@scale/plugin`** | Claude Code plugin: hooks (capture + edit gate) and `/scale-*` skills/commands. Ships two **generated, committed** payloads — `bin/scale.mjs` (the bundled CLI) and `web-dist/` — so it stays self-contained; regenerate with `npm run build:plugin`. |
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
mapping. The gate's behavior lives in the same config:

```bash
scale config set gate.assessment sync|async     # check in chat now vs unlock later
scale config set gate.modality quiz|socratic
scale config set gate.enforcement advisory|soft|hard
```

Every value you `set` becomes a **personal override**, written sparsely on top of the
team's committed defaults in `.scale/policy.json` (see [Team policy](#team-policy)).

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
  (manual check) — MCQ quiz or short Socratic dialogue per `gate.modality`.
- **The edit gate:** an Edit/Write into LOCKED territory (never checked, or re-locked by
  drift) is denied. `sync` assessment: the tutor runs the check in chat and a pass
  unlocks the territory durably. `async` assessment: the agent teaches instead, and you
  unlock later in the map viewer or with `/scale-study`. `scale gate defer <id>` skips —
  a session-scoped unlock; it locks again next session.
- **Drift — 함락 / 재건:** unlocking is durable but not unconditional. Every recompute measures each
  validated component's churn since the sha you validated it at, **split by author**. A
  collaborator's change past `drift.foreignRatio` re-locks the territory (SessionStart
  names them, once a day); your own change uses a far higher bar, since the gate already
  cleared you before you wrote it. One passing check recovers it, and the deny says you
  *did* demonstrate it, and the check is grounded in the collaborator's actual diff — a
  skeleton (commits, files, declarations touched) plus a churn-ranked excerpt, all inside
  an explicit untrusted-data fence, with `drift.shareDiff` deciding how much of it reaches
  the API at all. The map skins the two causes apart: a teammate's change leaves the
  territory **Fallen** (함락) with their name on it, your own rewrite leaves it **Rebuilt**
  (재건). Neither is a failure.
- **Check progress:** `scale status` (coverage, how much territory is unlocked, what
  drifted, and whether your git identity actually matches your commits) and
  `scale serve` (the map).
- **Post-session quests** (async assessment only): `scale quest generate` produces quests
  for touched components; complete them with `scale quest complete` or in the map viewer —
  passing also unlocks the territory.

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
| `scale gate edit` | Decide if an edit into locked territory is denied (PreToolUse hook); prints one JSON line, always exit 0. | ⚡ |
| `scale gate defer <id>` | Skip a component's check — a session-scoped unlock; it locks again next session. | ⚡ |
| `scale record <id> [-d -s \| --socratic]` | Record a quiz/Socratic validation outcome; updates coverage. | ⚡ |
| `scale coverage recompute` | Re-materialize `coverage.json` from `evidence.jsonl`. | ⚡ |
| `scale quest generate [-k N]` | Generate quests for touched, low-coverage components. | 🧠 |
| `scale quest list` | List pending/completed quests from `quests.json`. | ⚡ |
| `scale quest complete <id> --results \| --socratic` | Record a quest outcome, mark it completed, update coverage. | ⚡ |
| `scale map layout` | Compute/extend the frozen spatial layout → `.scale/map.json`. | ⚡ |
| `scale map index` | Build the file→component reverse index → `.scale/index.json`. | ⚡ |
| `scale map drift` | Flag components whose sources changed since the build SHA (minimal stub). | ⚡ |
| `scale serve [-p 4318] [--host <addr>] [--token <t>]` | Serve the local web map viewer + JSON API. | ⚡/🧠 |
| `scale config unset <key>` | Drop one personal override so the team default applies again. | ⚡ |
| `scale telemetry summary [--json]` | Counts and learning-vs-avoidance ratios from the local study log. | ⚡ |
| `scale reset [-y]` | Delete the `~/.scale/<repo-id>/` state dir (demo/pilot reset). | ⚡ |

`scale serve` itself is pure Node; only its Socratic runner (`/api/socratic/:id/message`)
proxies the intervention model. It binds **loopback only** by default, where the only
guard is a same-origin check. Passing `--host` (e.g. `0.0.0.0` to reach the map from a
phone over a trusted LAN) makes the server **generate a bearer token** and print a
`http://<lan-ip>:4318/?token=…` URL: every `/api/*` request must carry it (`Authorization:
Bearer` or `?token=`), the page keeps it for the tab, and the static bundle stays public.
Anyone holding the URL can read your coverage and write your settings — treat it like a
password. `--token` pins a value of your own.

**Owed checks.** When an async user is denied an edit, the component is written to
`pendingUnlocks` in `locks.json`. The next `SessionStart` says how many territories still
owe a check (`Unlocked for editing: 3/37. 1 territory still owes a check…`), SessionEnd
quest generation targets those first, the viewer shows a 🔒 badge on the node and a
count in the header (`GET /api/locks`), and the panel points at the quiz or socratic
runner. Passing there — graded server-side — unlocks the edit for the next session.

**Where a setting comes from.** The Settings modal marks every gate and budget knob
`default` / `team default` / `yours`. `yours` means your own config pins it, so a later
team change will not move you; the ↺ button beside it (or `scale config unset <key>`)
drops the pin and the team value shows through. If the phone tab outlives the server,
the page says its key expired instead of rendering an empty map.

## Study telemetry (local only)

Alongside `evidence.jsonl` (the comprehension model's input, which never leaves the
machine) SCALE writes `~/.scale/<repo-id>/telemetry.jsonl`: the stream a deployment
study would collect, designed from the start to be shippable — no prompt text, no file
contents, no file paths, no collaborator addresses (authors are counted). Every row is
`{v:1, ts, user, sessionId, type, …}`:

| type | when | what it carries |
|---|---|---|
| `config_change` | any override lands (CLI or Settings) | one row per changed leaf: `path`, `from`, `to`, `source`, `reset`, the team's `policyValue`, and `direction` (`loosen` / `tighten` / `neutral`) |
| `gate` | a deny, re-deny, or advisory | component, `cause` (`locked` / `drift_foreign` / `drift_self`), enforcement, assessment, budget used/max |
| `skip` | `scale gate defer` | component, `by`, time since the deny |
| `redirect` | an edit is allowed elsewhere while a deny is outstanding | the denied component, what was edited instead, unanchored file count, time since the deny |
| `out_of_band` | at period end, from git | a locked component whose sources changed with no Edit/Write reaching the gate — an edit around the tools |
| `unlock` | the ledger unlocks a component | `via`, mean score, checks, how long the check was owed, whether it recovered drift |
| `relock` | drift re-locks a component | cause, number of foreign authors |
| `session_end` | the last window closes | edits / allows / denies / re-denies / advisories / redirects / skips, ledger counts |

`scale telemetry summary` reads it back: denies, unlocks and recoveries, the three
avoidance signals, and the share of denied components that were never unlocked. Nothing
is transmitted; the collection path is a separate decision (PLAN-GATE §15).

---

## Settings

Everything below lives in `~/.scale/<repo-id>/config.json`. Edit it with `scale config
set <key> <value>`, or open the **⚙ Settings** modal in `scale serve` — a **Language**
row at the top, then the rest — same file, same validation, no terminal needed.

| Setting | Values | What it changes |
|---|---|---|
| `language` | `en` \| `ko` | Interaction language for everything SCALE says to you — web UI, quiz items, Socratic dialogue, in-flow checks. Code identifiers, file paths, and established dev terms stay English. Default `en`. |
| `gate.enabled` | `true` \| `false` | The gate as a whole. A team lead who wants to exempt themselves turns this off in their own config. |
| `gate.assessment` | `sync` \| `async` | Where the check runs after a deny: in chat right now, vs. teach now + unlock later (map viewer / `/scale-study`). |
| `gate.modality` | `quiz` \| `socratic` | Multiple choice vs. dialogue. |
| `gate.enforcement` | `advisory` \| `soft` \| `hard` | Note-only, block-with-skip, or block-without-skip. There is no absolute lock: your own `enforcement` override is the sanctioned pressure valve. |
| `drift.foreignRatio` | 0–1 | A **collaborator's** churn ÷ component size that re-locks it (default 0.25). Low on purpose — their change is code you have never read, and re-locking only costs you if you go on to edit that territory. |
| `drift.selfRatio` | 0–1 | The same for **your own** churn (default 0.8). Much higher: the gate cleared you before you wrote it, so this only catches a wholesale rewrite of something you unlocked with one check. |
| `drift.trigger` | `ratio` \| `any-foreign-commit` | `any-foreign-commit` re-locks on a single foreign commit. Measured here, one commit touches ~7.9 of 37 components and the busiest are touched by ~60% of commits, so on a real team it re-locks the same territory daily. Available, not the default. |
| `drift.digest` | `daily` \| `session` \| `off` | How often SessionStart names newly re-locked territory. |
| `drift.shareDiff` | `full` \| `metadata` \| `off` | **How much of a teammate's change reaches the intervention API** when grounding a recovery check. `full` sends commit metadata plus a clipped diff excerpt; `metadata` sends who/which files/which declarations and **no source lines**; `off` grounds recovery in the paper alone. Team-policy settable — a lead can decide this once for everyone. |
| `identity.emails` | list | Extra git addresses that are also **you** (a work address, a GitHub `users.noreply`), on top of `git config user.email`. Personal only — a team policy can never set who you are. Prefer a committed `.mailmap`, which SCALE already honors. |
| `unlock.passBar` | 0–1 | Mean score a single check needs to count as passed (default 0.6). |
| `unlock.checksRequired` | ≥ 1 | Passed checks needed before a territory unlocks (default 1). |
| `exempt.paths` | glob list | Files the gate never fires on (`*` within a segment, `**` across). New files are already exempt — only exact paper anchors gate. |
| `budgets.*` | non-negative numbers | Interruption ceiling: denies per session, cooldown minutes. `0` means "off". |
| `budgets.sessionIdleResetMinutes` | non-negative number | Backstop for ending a budget period (default 720 = 12h). A period normally ends when the **last Claude Code window** attached to the repo closes, so a second terminal shares the budget instead of refilling it; this only recovers a SessionEnd lost to a crash, and is deliberately longer than a working day so it never ends a session by itself. |
| `models.provider` | `anthropic` \| `openai` | Which API serves **interventions**. |
| `models.intervention` | `sonnet` \| `opus` | Intervention tier; resolves per provider (see table above). |
| `models.openaiModel` | any model id | Optional override pinning an explicit GPT model. |

The build model is not listed: `/scale-map` runs inside a Claude Code session and uses
that session's model (`/model`), so a setting here could only state an intention it cannot
enforce. Only interventions follow `models.provider`.

### Team policy

A team lead sets DEFAULTS — not rules — by committing `.scale/policy.json` to the repo
(PLAN-GATE §2). It may carry the `gate`, `unlock`, `exempt`, `budgets`, and `thresholds`
sections; personal keys (`user`, `language`, `models`) are ignored if present. Precedence,
per leaf key:

```
schema defaults  <  .scale/policy.json (committed)  <  ~/.scale/<repo-id>/config.json
```

```jsonc
// .scale/policy.json — guard it with CODEOWNERS if the lead should approve changes
{
  "gate": { "assessment": "async", "enforcement": "soft" },
  "budgets": { "maxPerSession": 3 },
  "exempt": { "paths": ["**/*.md"] }
}
```

Anything a member writes with `scale config set` (or the Settings modal) becomes their
personal override on top of these defaults — including `gate.enabled: false` for a lead
who doesn't want to gate themselves. The user file stays sparse, so a later policy change
reaches everyone who hasn't explicitly overridden that key. A policy that fails to parse
is ignored whole (fail open) and `scale status` says so.

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
map layout`/`index` → coverage materialized from evidence → the deterministic **edit gate**
(locks + budget + session-scoped `gate defer`, team-policy defaults with per-user
overrides) → quiz + Socratic checks in chat that durably **unlock** territory → `scale
status` → post-session `scale quest generate`/`list`/`complete` (CLI and web share one
completion path, both unlock) → pending-unlock surfacing (SessionStart count, 🔒 in the
viewer, `/api/locks`) → server-side quiz grading → LAN bearer token for a phone → web map
viewer + JSON API → settings provenance + reset → local study telemetry (overrides,
denies, skips, redirects, out-of-band edits, unlocks, re-locks, session tallies).

**Not yet** (see PLAN-GATE §4 for the staged plan)

- **Telemetry collection** — the local log exists and is shippable by design; how it
  leaves the machine (consent, transport, aggregation) is not decided or built.
- **Mode A live co-construction** — building the memory alongside the junior in-flow (hook
  infrastructure exists; the mode does not).
- **`scale map drift`** — still a stub that reports SHAs only. Per-component staleness
  itself IS wired (it runs on every recompute; see Drift above); this senior-side
  reporting command just never caught up.
- **API-dependent paths** — LLM quest generation and the web Socratic proxy need an API key
  (Anthropic or OpenAI); both fall back to deterministic behavior offline (quest generation
  synthesizes items from the paper; the Socratic proxy is unavailable without a key).

---

## Repo tooling

```bash
npm run build:plugin   # regenerate the plugin payload (bin/scale.mjs + web-dist/)
npm run check:map      # audit .scale/ against the code — read-only, no API, free
npm run distill        # graphify graph -> .scale/deps.json (senior side only)
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

**`distill`** ([`scripts/distill-graph.mjs`](./scripts/distill-graph.mjs)) turns a
[graphify](https://github.com/Graphify-Labs/graphify) AST extraction into
`.scale/deps.json`, which `scale map layout` merges as `depends_on` edges. Those edges
put measured dependency centrality into `importance` — which drives node size, the
gate's candidate ranking, and quest selection, and until now came only from the
markdown links an LLM wrote in each paper's Related Work section (24.6% of which have
any code path behind them, per `check:map`). The LLM's `reference` edges are kept
alongside rather than replaced: the difference between them is the measurement.

This is a **senior-side, build-time** step. graphify is Python and never runs on the
junior's path — they read the committed JSON:

```bash
uv tool install graphifyy       # once, senior machine only
graphify extract . --code-only  # local, deterministic, no API key, no LLM
npm run distill                 # -> .scale/deps.json  (commit it)
scale map layout                # merges it; coordinates stay frozen
```

With no `.scale/deps.json` the layout is byte-identical to what it was before
graphify existed — the integration is optional at every step.

CI ([`.github/workflows/ci.yml`](./.github/workflows/ci.yml)) typechecks and tests on
Node 20/22, and separately rebuilds the plugin payload and fails if it differs from
what is committed.

---

## More

- **[`QUICKSTART.md`](./QUICKSTART.md)** — the step-by-step, works-today walkthrough.
- **[`PLAN.md`](./PLAN.md)** — the full design, schemas, and roadmap.
