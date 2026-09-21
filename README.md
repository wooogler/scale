# SCALE

**S**caffolded **C**overage-**A**ware **L**earning **E**ngine — a coverage memory of a
codebase (built once by a high-capability model, frozen as a spatial "territory map")
that keeps a junior engineer's real comprehension in sync while they work in Claude Code.

Two users, one map:

- **Senior** builds and maintains the coverage memory — a set of markdown **component
  docs**, one per component, anchored to source files at a git SHA.
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

- **Coverage memory (`.scale/`).** One markdown component doc per component (frontmatter:
  stable `id`, `sources`, quizzable `concepts`, `rationale`), grouped into provinces of
  5–9. Every doc carries the same six sections — `Summary`, `What it does`, `Related
  components`, `How it works`, `Design decisions`, `Where it sits` — so a reader always
  knows where to look, and the cross-links in `Related components` are the graph. (The
  loader still accepts the older academic headings as aliases, so a memory built before the
  rename keeps loading; `/scale-map` never writes them again.) How
  many components a repo gets is arithmetic, not a fixed range — `scale estimate` sizes it
  from source lines and source files, and `scale map check` holds the build to it. A frozen
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
  teaches at deny time and the junior unlocks later in the map viewer — the deny hands
  them a deep link to that component and the `/scale-open <id>` that opens it — or via
  `/scale-study <id>`. Team leads set defaults in a committed `.scale/policy.json`;
  every member may override any knob in their own config.
- **Game skin is UI only.** territory / conquest / fallen-or-rebuilt (and importance-sized castles)
  are a rendering layer over the neutral `component` / `coverage` / `staleness` model —
  schemas and code never use game terms.

---

## Architecture

Monorepo, TypeScript throughout (npm workspaces), so CLI, hooks, and web share one schema.

| Package | Role |
|---|---|
| **`@scale/core`** | Shared engine: zod schemas, coverage model, component-doc loader, file→component index, layout, drift, cost estimator. |
| **`@scale/cli`** | The `scale` CLI wrapping core (also the binary the plugin hooks call). |
| **`@scale/plugin`** | Claude Code plugin: hooks (capture + edit gate) and `/scale-*` skills/commands. Ships two **generated, committed** payloads — `bin/scale.mjs` (the bundled CLI) and `web-dist/` — so it stays self-contained; regenerate with `npm run build:plugin`. |
| **`@scale/web`** | React + Vite + SVG map viewer served by `scale serve`, plus a local JSON API. |

---

## Install

Requires Node 18+ and Claude Code.

### The plugin — using SCALE

The repo root ships `.claude-plugin/marketplace.json`, so Claude Code takes this GitHub repo
itself as a marketplace. No clone, no `npm install`:

```bash
claude plugin marketplace add wooogler/scale
claude plugin install scale@scale-marketplace
```

Then **quit and reopen Claude Code** — hooks are read at session start. That is the whole
install: the hooks, the skills, the `/scale-*` commands, the map viewer, and a
self-contained `scale` CLI all ship inside the plugin.

**First run, from inside Claude Code.** On the next session start the hook starts the map
viewer for you and prints one line — `SCALE · map viewer: http://localhost:4318 · settings
in chat: /scale-settings`, or a nudge to run `/scale-settings` when the repo is not set up
yet. Run **`/scale-settings`** and it walks the whole setup in chat: your label, language,
the gate's shape (assessment / modality / enforcement) and the intervention model, one
question at a time. The **API key is the one thing it never asks for in chat** — it points
you at the viewer's settings page, or at `scale keys set <provider> --stdin` in your own
terminal. No terminal is needed for anything else, and **`/scale-open`** brings the map up
whenever you want it.

To update: `claude plugin marketplace update scale-marketplace`, then
`claude plugin update scale@scale-marketplace`, then restart.

**Running `scale` in your own terminal.** Claude Code puts the plugin's `bin/` on `PATH`
inside its own sessions, so the hooks and `/scale-*` commands always find the CLI — but a
plain Terminal window does not have it, and `scale` there is `command not found`. That is
expected and breaks nothing. If you want the command in a terminal too, add the installed
plugin's `bin/` to your `PATH`:

```bash
ls ~/.claude/plugins/cache/scale-marketplace/scale/    # the installed version, e.g. 0.4.0
# then add .../scale/<version>/bin to PATH in your shell rc
```

Note the path carries the version, so it moves every time the plugin updates. Installing
from a clone (below) avoids that — the clone's path is stable.

### From a clone — working on SCALE

```bash
git clone https://github.com/wooogler/scale.git && cd scale
npm run plugin:install        # register this clone as the marketplace + install
```

`scripts/plugin.mjs` (also `plugin:status`, `plugin:reload`, `plugin:uninstall`) drives the
whole install surface from your checkout; `npm run plugin:install -- --path` also puts the
clone's `bin/` on `PATH` in `~/.zshrc` for terminal use. `packages/plugin/README.md` →
Install has the details, including why `reload` exists (Claude Code caches a plugin by
version, so `plugin update` is a no-op until the version moves).

To run the CLI from source instead of the bundled one — needed only when changing the CLI
itself:

```bash
npm install
npm run build                 # tsc -b — builds @scale/core + @scale/cli
npm run build -w @scale/web   # builds the map viewer (needed for `scale serve`)
npm run cli -- <args>         # from source via tsx, no build needed
```

Every command runs against the **current working directory**: the target repo's `.scale/`
coverage memory plus per-user state under `~/.scale/<repo-id>/` (repo-id from the git
remote, else the folder name).

---

## Uninstall

Two steps — the second is what makes Claude Code forget the repo. Without it the marketplace
stays registered and SCALE is one click from reinstallation:

```bash
claude plugin uninstall scale@scale-marketplace
claude plugin marketplace remove scale-marketplace
```

Then restart Claude Code: a running session keeps the hooks it loaded at start. Installed
from a clone, `npm run plugin:uninstall` does both and also removes the `~/.zshrc` block it
added.

**Nothing above deletes your data**, by design:

| where | what it is | to remove |
|---|---|---|
| `<repo>/.scale/` | the coverage memory — component docs + `map.json`, git-versioned | delete it like any other tracked content |
| `~/.scale/<repo-id>/` | your coverage, evidence, quests, config | `rm -rf ~/.scale/<repo-id>` |
| `~/.scale/<repo-id>/serve.json` | **transient** — the running viewer's calling card (`pid`, `port`, `host`, `url`, `startedAt`, `idleMinutes`, `version`) | `scale serve stop` removes it; a stale one is ignored |
| `~/.scale/keys.json` | your API key (mode 0600) | delete only if you mean to; revoke it upstream too |

`~/.scale/keys.json` sits in the directory you would most naturally wipe, so **do not use
`rm -rf ~/.scale/*`** — that glob takes the key with it. To drop the per-repo state and keep
the key: `find ~/.scale -mindepth 1 -maxdepth 1 -type d -exec rm -rf {} +`. From a clone,
`npm run plugin:uninstall -- --purge` clears the plugin caches and moves `~/.scale` to a
timestamped backup rather than deleting it.

---

## Usage

### Configure the models (fixed two-tier policy)

**`/scale-settings` does all of this in chat** — it maps "switch to opus" or "게이트를
async로 바꿔줘" onto the same keys, and `scale config get <key> --explain` is what it reads
to tell you whether today's value is yours, your team's, or the schema's. The CLI below is
the same file without the conversation.

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
scale config set quiz.items 3                   # MCQ items per check (1-5, default 2)
scale config set quiz.focus rationale           # auto | structure | concepts | rationale
scale config set quiz.grounding diff            # balanced | diff | doc
```

`gate.*` and `budgets.*` set **how often** a check interrupts you; `quiz.*` sets
**what it asks**.

Every value you `set` becomes a **personal override**, written sparsely on top of the
team's committed defaults in `.scale/policy.json` (see [Team policy](#team-policy)).

### Senior — build the coverage memory (once per repo, on Opus/Fable)

```bash
scale estimate                 # preview per-model cost/time (pure fs scan, no LLM)
# → build the component docs with /scale-map: Survey (approval gate) → Write → Link → Layout
scale map layout               # freeze .scale/map.json (spatial coords + importance)
scale map index                # build .scale/index.json (file → component reverse index)
```

### Junior — learn while coding

With the plugin installed ([Install](#install)) there is **nothing to set up per repo**.
`~/.scale/<repo-id>/` (coverage, evidence, session) is created on first use, and every
setting resolves at read time from schema defaults plus the repo's committed
`.scale/policy.json` — so the gate runs with `quiz` / `sync` / `soft` out of the box and
your user label falls back to `$USER`.

Run **`/scale-settings`** when you want to pin that label or change a setting — it runs
`scale init --user <label>` for you and then walks the choices in chat, one question at a
time. (`scale init --user <label>` by hand does the same; `scale config get/set` are the
one pair of commands that require it.) Either way the config stays sparse on purpose: only
explicit choices are stored, so a later team-policy change still reaches you instead of
being shadowed by materialized defaults.

Then work normally in Claude Code:

- **Learn:** `/scale-study [id]` (voluntary reading guide + check) or `/scale-quiz [id]`
  (manual check) — MCQ quiz (one Claude Code question card per item) or short
  Socratic dialogue in chat, per `gate.modality`.
- **The edit gate:** an Edit/Write into LOCKED territory (never checked, or re-locked by
  drift) is denied. `sync` assessment: the tutor puts the check in front of you and a pass
  unlocks the territory durably. `async` assessment: the agent teaches instead, and you
  unlock later with **`/scale-review`** — the owed check, in chat, run exactly as the gate
  would have (same modality, cards, recording; only the timing differs) — or in the map
  viewer (the deny carries a deep link plus `/scale-open <id>`), or with `/scale-study
  <id>`. `scale gate defer <id>` skips — a session-scoped unlock; it locks again next
  session.
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
- **Check progress:** `/scale-status` or `scale status` (coverage, how much territory is
  unlocked, what drifted, whether your git identity actually matches your commits — and a
  `Map viewer:` line with the URL), and **`/scale-open`** for the map itself
  (`/scale-open <id>` jumps to one component, `/scale-open <id> <section>` to one section of
  its doc, `/scale-open settings` to the settings page).
- **Post-session review in chat**: `/scale-review` runs the checks you owe — async denies
  first, then territory touched since its last check — through the same tutor path as the
  gate, so in-flow and post-session checks are the same process at different times.
- **Post-session quests** (async assessment only): `scale quest generate` produces quests
  for touched components; complete them with `scale quest complete` or in the map viewer —
  passing also unlocks the territory.

---

## Applying it to a codebase you already work in

The two roles are a division of labor, not two people — on a repo you already work in, you
are usually both, and what changes is the order you do things in. Everything below runs
with the target repo as the **current working directory**: SCALE reads that repo's
`.scale/` and keeps your personal state under `~/.scale/<repo-id>/`, so a second repo needs
no global setup, only its own map.

**Size the repo before you build it.** `scale estimate` is a pure fs scan — no LLM, no
cost — and it answers the question that has to be settled first: how many components this
codebase should be cut into, and what the one-time build costs on each model. The scan
already skips `node_modules`, `dist`, `build`, `vendor`, tests, and anything carrying an
`@generated` or `DO NOT EDIT` marker. If the count still looks wrong for the repo you know,
the usual cause is a checked-in bundle without that marker — exclude it before you build,
because the partition is arithmetic from source lines and source files, and `scale map
check` will hold the finished build to the same band.

**The build is one session, and the Survey gate is where your knowledge enters.** Pick
Opus 5 or Fable 5 with `/model`, then run `/scale-map` in the target repo. The skill
surveys the source into provinces and components and stops for approval before it writes a
single component doc. That pause is the point: a model reading an unfamiliar repo groups by
directory when the real seams are often elsewhere, and you are the one who knows which
module is load-bearing and which three files are really one idea. Correcting the partition
there costs a sentence; correcting it after forty docs exist costs the build.

**What lands where.** The component docs, `map.json`, `deps.json`, and any
`.scale/policy.json` are committed to the target repo — the map is a shared artifact and
belongs in review, where a wrong claim in a doc can be caught the same way a wrong comment
is. `.scale/index.json` is gitignored and rebuilt on demand with `scale map index`, because
it is derived. Your coverage, evidence log, locks, quests, and cached `translations/` never
leave `~/.scale/<repo-id>/`: two people working the same repo share the map but not the
score, and not each other's translations.

**Expect to start at zero, on code you wrote.** Coverage is materialized from evidence
SCALE observed, and it observed none of the work that predates the map — so the first
`scale status` on a repo you know well still reports every territory locked. That is
honest rather than harsh, since the claim being tested is that you can explain the
component now, not that you once touched it. It does mean the first week is front-loaded,
and two knobs make it bearable: start on `gate.enforcement advisory` so the gate reports
instead of blocks, and put vendored, generated, and migration paths in `exempt.paths` so
the session budget is spent on code you actually own. New files never gate — only exact
doc anchors do (see [Settings](#settings)).

**A repo with history behaves differently from an empty one.** Drift is measured per
validated component since the sha *you* validated it at, split by author, so an active repo
will re-lock territory on you — that is the mechanism working, not noise. Two things are
worth checking on the first day. `scale status` reports whether your git identity matches
your recent commits; if it does not, add the address to `identity.emails` or to the repo's
`.mailmap`, or your own churn will read as a collaborator's and re-lock you under the much
stricter foreign bar. And `drift.foreignRatio` is tuned for how fast the repo actually
moves — on a busy shared subsystem the default `0.25` fires often.

**Rolling it out to the team.** Commit `.scale/policy.json` with the defaults you want
people to start on; each member still runs `scale init --user <label>`, gets their own lock
ledger, and may override any policy key in their own config (see
[Team policy](#team-policy)). The map is shared, the pressure is personal — which is also
why a team lead can turn `gate.enabled` off for themselves without touching anyone else.

**Keeping the map honest as the code moves.** Component docs are anchored to source files
at a build sha, so renames and deletions age them. `scale map check` reports the partition
against the sizing band, anchored paths that no longer exist, and files claimed by more
than one component; re-run `scale map index` whenever anchors change, and re-run
`/scale-map` scoped to a single province when a subsystem has genuinely been restructured.
A map that has drifted from the code teaches the wrong thing, which is worse than no map.

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
| `scale doc show <id> [--lang en\|ko] [--json] [--refresh]` | Print one component doc. `--lang ko` prints a per-user translation, cached under `~/.scale/<repo-id>/translations/`; `--refresh` rebuilds it. | ⚡/🧠 |
| `scale estimate [--json]` | Target component count + band for this repo, and the build cost per model. | ⚡ |
| `scale config get [key]` / `set <key> <val>` | Read/write `config.json` (gate, quiz shape, models, budgets, thresholds). | ⚡ |
| `scale config get <key> --explain [--json]` | The same value **plus where it came from** — `gate.assessment = "async"  (source: user override; team default: "sync")`. With no key, every leaf. | ⚡ |
| `scale setup status [--json]` | What SCALE still needs here: `initialized`, `user`, `memory`, `provider`, `keyPresent`, `gate`, `language`, `viewer`. What `/scale-settings` reads first. | ⚡ |
| `scale keys status [--json]` | Per provider, whether a key is present. Never prints key material. | ⚡ |
| `scale keys set <anthropic\|openai> --stdin` | Store a key read from **stdin only** — never as an argv value, which would land in shell history. | ⚡ |
| `scale policy show` | Print `.scale/policy.json`, its `leads`, your git identity, and whether you count as a lead. | ⚡ |
| `scale log prompt \| touch \| review` | Append a raw passive signal to `evidence.jsonl` (hook fast-append). | ⚡ |
| `scale gate edit` | Decide if an edit into locked territory is denied (PreToolUse hook); prints one JSON line, always exit 0. | ⚡ |
| `scale gate defer <id>` | Skip a component's check — a session-scoped unlock; it locks again next session. | ⚡ |
| `scale record <id> [-d -s \| --socratic]` | Record a quiz/Socratic validation outcome; updates coverage. | ⚡ |
| `scale coverage recompute` | Re-materialize `coverage.json` from `evidence.jsonl`. | ⚡ |
| `scale review queue [--json] [--limit N]` | What to review now: owed async checks first, then touched-since-last-check territory below the bar. Same picker as quest generation. | ⚡ |
| `scale review start <id>` | Print the check brief for a component — the deny reason's twin — and open the intervention in the accounting stream. | ⚡ |
| `scale review diff <id> [--max-bytes N]` | The code changed in that territory since its last check (commits + working tree), for grounding. | ⚡ |
| `scale quest generate [-k N]` | Generate quests for touched, low-coverage components. | 🧠 |
| `scale quest list` | List pending/completed quests from `quests.json`. | ⚡ |
| `scale quest complete <id> --results \| --socratic` | Record a quest outcome, mark it completed, update coverage. | ⚡ |
| `scale map layout` | Compute/extend the frozen spatial layout → `.scale/map.json`. | ⚡ |
| `scale map index` | Build the file→component reverse index → `.scale/index.json`. | ⚡ |
| `scale map check [--json]` | Hold a built `.scale/` to the sizing contract; non-zero exit when it does not hold. | ⚡ |
| `scale map drift` | Flag components whose sources changed since the build SHA (minimal stub). | ⚡ |
| `scale serve [-p 4318] [--host <addr>] [--token <t>]` | Serve the local web map viewer + JSON API, in the **foreground**. | ⚡/🧠 |
| `scale serve ensure [--json] [--idle-minutes <n>]` | Reuse a live viewer for this repo, or start a detached one; prints the URL. Never hangs > ~3 s. What the SessionStart hook runs. | ⚡/🧠 |
| `scale serve url [--component <id> [--section <slug>]] [--settings <tab>] [--json]` | Where the viewer is, without starting anything — with the hash deep link appended. | ⚡ |
| `scale serve open [--component <id> [--section <slug>]] [--settings <tab>]` | `ensure`, then open it in the system browser; prints the URL. This is what `/scale-open` calls. | ⚡/🧠 |
| `scale serve stop` | Stop the detached viewer named in `serve.json` (only if it is ours) and remove the file. | ⚡ |
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

**You rarely type any of that.** The SessionStart hook runs `scale serve ensure`, so the
viewer is already up by the time you read the banner, and **`/scale-open`** is the normal
way in. `ensure` reuses a viewer whose `/api/health` reports *this* repo-id, adopts one
already answering on the port, walks 4319–4328 when the port is held by something else,
and otherwise spawns a fully detached `scale serve`. It records the result in
`~/.scale/<repo-id>/serve.json` (`pid`, `port`, `host`, `url`, `startedAt`, `idleMinutes`,
`version`) — transient state, not something to back up. A detached viewer exits after
**240 idle minutes** by default (`--idle-minutes`, `0` to disable), because nobody is
watching it; a foreground `scale serve` never times out unless you ask it to.
`scale serve stop` ends it early. Bare `scale serve` — foreground, and `--host 0.0.0.0`
for the phone — stays exactly as it was, for when you want the log in front of you.

**Deep links.** The viewer's routes are in the URL hash, so any of them can be handed to
you as a link: `#/c/<component-id>` opens that component's panel,
`#/c/<component-id>/<section>` opens it scrolled to one section of the doc, `#/settings`
the Settings modal, `#/settings/<tab>` one of `general` | `gate` | `checks` | `team`. The
section vocabulary is stable and **English** — derived from the doc's English source, so a
link survives translation: `concepts`, `decisions`, and the body heading slugs `summary`,
`what-it-does`, `related-components`, `how-it-works`, `design-decisions`, `where-it-sits`.
A section a doc does not have opens the doc from the top rather than erroring. The hash is
kept in sync as you click, so a URL you copy out of the address bar reopens what you were
looking at. `scale serve url --component <id> [--section <slug>]` / `--settings <tab>`
build them for you, and the gate's deny message carries one for the component it just
denied.

**Reading docs in the viewer.** A doc's **Related components** links are live: clicking one
opens that component's panel and selects it on the map, and the back button walks the docs
you came through (map clicks are browsing and do not add history). The **📖 Docs** button
in the header lists every component doc grouped by province, so a README is reachable
without finding its castle first. `GET /api/docs` is the index behind both
(`{ id, title, province, dir }` per component).

**Owed checks.** When an async user is denied an edit, the component is written to
`pendingUnlocks` in `locks.json`. The next `SessionStart` says how many territories still
owe a check (`Unlocked for editing: 3/37. 1 territory still owes a check…`), SessionEnd
quest generation targets those first, the viewer shows a 🔒 badge on the node and a
count in the header (`GET /api/locks`), and the panel points at the quiz or socratic
runner. Passing there — graded server-side — unlocks the edit for the next session.

**Where a setting comes from.** The Settings modal marks every gate and budget knob
`default` / `team default` / `yours`. `yours` means your own config pins it, so a later
team change will not move you; the ↺ button beside it (or `scale config unset <key>`)
drops the pin and the team value shows through. `scale config get <key> --explain` prints
the same provenance in one line (`--json` for `{ key, value, source, policyValue?,
defaultValue? }`), which is how `/scale-settings` answers "why is it set to that?". If the phone tab outlives the server,
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

Everything below lives in `~/.scale/<repo-id>/config.json`. Three ways in, same file and
same validation: **`/scale-settings`** in chat (plain language, any language — "switch to
opus", "게이트를 async로 바꿔줘"), the **⚙ Settings** modal in the viewer (`/scale-open
settings`, a **Language** row at the top then the rest), or `scale config set <key>
<value>` in a terminal. No terminal is needed for any of it.

| Setting | Values | What it changes |
|---|---|---|
| `language` | `en` \| `ko` | Interaction language for everything SCALE says to you — web UI, quiz items, Socratic dialogue, in-flow checks. Code identifiers, file paths, and established dev terms stay English. Default `en`. |
| `gate.enabled` | `true` \| `false` | The gate as a whole. A team lead who wants to exempt themselves turns this off in their own config. |
| `gate.assessment` | `sync` \| `async` | Where the check runs after a deny: in chat right now, vs. teach now + unlock later (map viewer / `/scale-study`). |
| `gate.modality` | `quiz` \| `socratic` | Multiple choice vs. dialogue. |
| `gate.enforcement` | `advisory` \| `soft` \| `hard` | Note-only, block-with-skip, or block-without-skip. There is no absolute lock: your own `enforcement` override is the sanctioned pressure valve. |
| `quiz.items` | 1–5 | MCQ items per check (default 2). Quiz modality only — a Socratic dialogue is capped at 3 exchanges instead. |
| `quiz.focus` | `auto` \| `structure` \| `concepts` \| `rationale` | Which coverage dimension the items probe. `auto` (default) targets your weakest dimension and varies across items; naming one drills that dimension only — the knob for "I keep failing on rationale", which frequency settings could never answer. |
| `quiz.grounding` | `balanced` \| `diff` \| `doc` | What the questions are about. `balanced` (default) grounds in the doc and sharpens with the change you just made; `diff` makes every question about that change; `doc` asks about the documented design only and never shows your diff to the model. |
| `drift.foreignRatio` | 0–1 | A **collaborator's** churn ÷ component size that re-locks it (default 0.25). Low on purpose — their change is code you have never read, and re-locking only costs you if you go on to edit that territory. |
| `drift.selfRatio` | 0–1 | The same for **your own** churn (default 0.8). Much higher: the gate cleared you before you wrote it, so this only catches a wholesale rewrite of something you unlocked with one check. |
| `drift.trigger` | `ratio` \| `any-foreign-commit` | `any-foreign-commit` re-locks on a single foreign commit. Measured here, one commit touches ~7.9 of 37 components and the busiest are touched by ~60% of commits, so on a real team it re-locks the same territory daily. Available, not the default. |
| `drift.digest` | `daily` \| `session` \| `off` | How often SessionStart names newly re-locked territory. |
| `drift.shareDiff` | `full` \| `metadata` \| `off` | **How much of a teammate's change reaches the intervention API** when grounding a recovery check. `full` sends commit metadata plus a clipped diff excerpt; `metadata` sends who/which files/which declarations and **no source lines**; `off` grounds recovery in the component doc alone. Team-policy settable — a lead can decide this once for everyone. |
| `identity.emails` | list | Extra git addresses that are also **you** (a work address, a GitHub `users.noreply`), on top of `git config user.email`. Personal only — a team policy can never set who you are. Prefer a committed `.mailmap`, which SCALE already honors. |
| `unlock.passBar` | 0–1 | Mean score a single check needs to count as passed (default 0.6). |
| `unlock.checksRequired` | ≥ 1 | Passed checks needed before a territory unlocks (default 1). |
| `exempt.paths` | glob list | Files the gate never fires on (`*` within a segment, `**` across). New files are already exempt — only exact doc anchors gate. |
| `thresholds.docReadCap` | 0–1 | Ceiling on the coverage a *reading* alone can earn (default 0.4): opening a component doc explores territory, it never conquers it. (A config still carrying the old pre-rename key is migrated to this one silently.) |
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
(PLAN-GATE §2). It may carry the `gate`, `quiz`, `unlock`, `exempt`, `drift`, `budgets`, and
`thresholds` sections; personal keys (`user`, `language`, `models`) are ignored if present. Precedence,
per leaf key:

```
schema defaults  <  .scale/policy.json (committed)  <  ~/.scale/<repo-id>/config.json
```

```jsonc
// .scale/policy.json — guard it with CODEOWNERS if the lead should approve changes
{
  "leads": ["lead@example.com"],
  "gate": { "assessment": "async", "enforcement": "soft" },
  "quiz": { "items": 3, "grounding": "diff" },
  "budgets": { "maxPerSession": 3 },
  "exempt": { "paths": ["**/*.md"] }
}
```

Anything a member writes with `scale config set` (or the Settings modal) becomes their
personal override on top of these defaults — including `gate.enabled: false` for a lead
who doesn't want to gate themselves. The user file stays sparse, so a later policy change
reaches everyone who hasn't explicitly overridden that key. A policy that fails to parse
is ignored whole (fail open) and `scale status` says so.

#### Who is a lead — `leads`

`leads` is the one policy key that is **not** a config section: a list of git email
addresses, matched case-insensitively against the same identity drift attribution uses
(`git config user.email` plus your `identity.emails`). It never merges into anyone's
config and never shows up in provenance.

```bash
scale policy show     # the policy, the leads list, your git identity, and your role
```

**The bootstrap rule:** with no policy file, an unparseable one, or an empty `leads`,
**everyone is a lead**. A repo that has never thought about roles must not be one nobody
can configure. The first person to add themselves to `leads` closes it — a positive act by
a named human, recorded in git history like any other policy change. Removing the last
lead reopens it, deliberately: a lead who leaves the team should not be able to strand it.

**This is a UX gate, not a security boundary.** `leads` decides who gets an editable Team
tab in the Settings modal (and who the `/api/policy` writes behind it accept); it decides
nothing about the file. `.scale/policy.json` is ordinary JSON in the repo, so anyone who
can write the working tree can edit it in an editor. The point is to stop a member
retuning the team's defaults from a settings screen while thinking they are changing their
own. **Real control over this path is git — review and CODEOWNERS on `.scale/policy.json`.**

**The Team tab** (`/scale-open settings team`, or Settings → Team in the viewer) is a
convenience over that same file.
It shows your git identity and role, the leads list, and every team default beside the
schema default it falls back to. A non-lead sees all of it **read-only** — knowing what
your team decided is useful whether or not you may change it. Saving writes the file and
leaves it uncommitted; the tab says so, because nothing reaches your teammates until
someone commits and pushes it.

`language` never touches the coverage memory: the `.scale/` component docs are always
written in English — they are repo-shared state, and `language` is a per-user interaction
preference.

**Reading a doc in your language.** With `language: ko`, the viewer panel and `scale doc
show <id> --lang ko` render a per-user translation — `POST /api/doc/:id/translation`
with `{"lang":"ko"}` over HTTP, a POST because it is the one route that spends API
money and a GET would be reachable as a sub-resource with no `Origin` to refuse — produced by the intervention model on first read and cached at
`~/.scale/<repo-id>/translations/<id>.<lang>.json`, keyed by a sha256 of the doc file so a
rewritten doc invalidates it. It preserves code identifiers, file paths, concept ids, and
fenced code, falls back to the English source with a note when there is no key or the call
fails, and never grounds anything: quizzes and Socratic checks read the English source, so
what you are assessed on never depends on a translation.

### API keys

Interventions (Socratic dialogue, LLM-written quests, doc translation) need a key for the
selected provider:

1. **Environment** — `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. Always wins.
2. **Settings modal** — ⚙ in the viewer (`/scale-open settings`). Stored in
   `~/.scale/keys.json` at mode `0600`, user-global (a key is an account credential, not
   project state).
3. **Your own terminal** — `scale keys set anthropic --stdin` (or `openai`), which reads
   the key from **stdin only**. There is deliberately no way to pass a key as an argument,
   where it would land in shell history and process listings.

**A key never goes in chat.** `/scale-settings` will offer you path 2 or path 3 and then
verify with `scale keys status --json`; it will not take a key you paste into the
conversation. `scale keys status` reports only `{ present }` per provider.

The key is never returned by the API and never logged — the UI only ever shows a masked
tail (`sk-…9f2A`) and where it came from. With no key, quest generation falls back to
deterministic doc-grounded items, translation falls back to the English source with a note,
and the Socratic runner says exactly what's missing and names `/scale-settings`.

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

Also works today, and the reason none of that needs a terminal: the SessionStart hook
starts the viewer (`scale serve ensure`) and prints its URL, **`/scale-settings`** runs
first-run setup and every later settings change in chat, **`/scale-open`** opens the map
or any single component, and every message SCALE writes — the session banner, `scale
status`, a gate deny — carries a clickable deep link.

**Known limitation — the gate only sees `Edit` / `Write` / `MultiEdit`.** Those are the
matchers on the `PreToolUse` hook, so a change the agent makes through **Bash** instead
(`sed -i`, a heredoc, a redirect, a throwaway Python script) reaches the file without ever
consulting the lock. Claude Code's **auto mode** makes this the normal path: it instructs
the agent to prefer Bash for file edits, and a whole session then runs with the gate
silently inert. Keep auto mode **off** for SCALE to work as designed — and note this is a
coverage gap, not a security boundary: the gate is a learning intervention, and someone
who wants past it can always edit the file by hand.

You can tell after the fact: `~/.scale/<repo-id>/session.json` counts every gate decision,
so a session whose `counters.edits` is 0 while the working tree changed went around it.

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
  synthesizes items from the doc; the Socratic proxy is unavailable without a key; doc
  translation falls back to the English source).

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
markdown links an LLM wrote in each doc's `Related components` section (24.6% of which have
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
