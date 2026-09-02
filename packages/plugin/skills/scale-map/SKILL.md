---
name: scale-map
description: >-
  Mode B coverage-memory builder for SCALE (senior side, run with Opus or
  better). Surveys a target repository into the number of component "papers"
  `scale estimate` sizes it for, groups them into provinces, writes each paper
  (structure + concepts + inferred rationale), cross-links them, and freezes a
  spatial map. Use this to build the
  coverage memory from scratch, or in sync mode to update papers after code
  changes. Forked and extended from cluedoc (MIT). Invoke via /scale-map or when
  asked to "build the scale map", "survey the repo into components", or "update
  the coverage memory".
license: MIT
---

# scale-map — Mode B coverage-memory builder

You are the **senior cartographer**. You build the coverage memory that a junior
engineer will learn from: a tree of markdown **papers** under `.scale/` in the
target repository, one folder per component, plus a frozen spatial `map.json`.

This skill is a **fork/extension of cluedoc** (a capability-tree-of-papers
documentation method, MIT). You keep cluedoc's discipline — the academic "paper"
form, prose-only bodies, cross-paper Related Work links as the graph — and add
four SCALE-specific things: a **stable `id`**, a **`concepts[]`** list, a
**`rationale[]`** block with provenance, a body **Rationale** section, and a
**frozen `map.json`** layout. See PLAN §4.1–§4.3.

Run this once per repo to build, then in **sync mode** after changes.

---

## Terminology (read first)

SCALE has two vocabularies. **The memory you write uses only the neutral one.**

| Neutral (schema / papers / code — ALWAYS use this) | Map UI skin (never in papers) |
|---|---|
| component | castle / territory / 성 |
| province | province / 주 |
| coverage / dims (structure, concepts, rationale) | dev stats / 내정 3스탯 |
| coverage states: fog, explored, validated, stale | fog, scouted, conquered, rebellion |

The strategy-game skin (conquest, territories) is a **UI layer only**. Papers,
`id`s, and prose must be plainly professional documentation. A junior reading a
paper should see a clear technical description, not game flavor.

---

## What you produce

```
.scale/
├── README.md                        # root paper: the whole realm
├── <province-id>/
│   ├── README.md                    # province paper: this feature group
│   └── <component-id>/
│       └── README.md                # component paper (the quizzable unit)
└── map.json                         # frozen layout — written by `scale map layout`
```

- **The target component count comes from `scale estimate`, not from this file.**
  It is arithmetic over the repo's own shape — source lines and source **files** —
  and it prints a band you must land inside. There is no fixed range that fits
  every repo: a two-thousand-line library wants a handful, and a large
  service wants far more than one flat layer of provinces can hold (see the
  grouping note below). Read the number before you plan the partition.
- **Never go finer than one component per source file.** `sources` anchors whole
  files, and every consumer that turns an edit into a territory — the edit gate,
  coverage credit, drift — is keyed by file. Put two components on one file and
  an edit gates, credits and re-locks both; put twelve on one file and the tool
  can no longer tell which territory the junior is even in. This is why the
  estimate caps the count at the file count, and why it says so when it does.
- **Group into provinces of 5–9 components.** Provinces exist to make the map
  readable, so their count follows from the component count rather than being
  chosen. `scale estimate` prints the shape: how many top-level groups, and how
  many grouping levels. Take the count from there rather than dividing yourself,
  and land every province inside 5–9 — `scale map check` warns on groups at
  either edge. A repo large enough that provinces themselves would exceed nine
  needs another grouping level; the estimate says so, and that case is not yet
  supported by `map.json` — stop and say so rather than flattening it.
- One folder per component; the folder name **is** the component `id`.
- Bodies are **prose only**: no code symbols, no file paths, no snippets in the
  body text. All code anchoring lives in the `sources` frontmatter field. (This
  is cluedoc's core rule and it is load-bearing — it forces genuine explanation
  and keeps papers robust to code drift.)

---

## Extended frontmatter (every component paper)

```yaml
---
id: session-management            # stable slug. This is the COVERAGE KEY.
                                  #   NEVER rename it — renaming orphans all
                                  #   per-user coverage & map coordinates.
title: Session Management         # human title (renameable freely)
sources:                          # file-granularity code anchors (paths, no line #s)
  - src/server/auth/sessions.ts
  - src/server/middleware/session.ts
concepts:                         # named, quizzable concept units. The tutor
  - id: server-side-sessions      #   generates items PER concept; keep each one
    name: Server-side session store; the cookie carries only an opaque id
  - id: session-rotation          #   atomic and independently testable.
    name: Session rotation on privilege change
rationale:                        # the "why", with provenance
  - decision: Sessions are server-side; the cookie is an opaque id
    why: Revocation must be immediate for shared-document access control
    alternatives: JWT-in-cookie (rejected — revocation complexity)
    provenance: inferred          # inferred | prompt:<ref> | interview:<ref>
---
```

Frontmatter rules:

- **`id`** — lowercase kebab slug, unique across the whole realm. Stable forever.
  Choose it carefully at Survey time; it is the primary key everywhere downstream.
- **`sources`** — file granularity only (never line ranges). List the files whose
  behavior this component *is*. **A file claimed by two components is a cost, not
  a licence.** Everything downstream keys off the file, so both components gate,
  take coverage credit and re-lock on any edit to it — the tool cannot tell them
  apart. Share a file only where the behaviour genuinely is shared (a small
  helper two territories both own), never as a way to split one large file into
  several components. `scale map check` fails a partition that averages more
  than ~1 component per anchored file. If a file is too big to be one learnable
  unit, say so in Survey and leave it as one component: splitting it honestly
  needs symbol-level anchors, which the tool does not have yet.
- **`concepts`** — 2–6 per component. Each is a discrete idea a junior could be
  quizzed on. Give each a stable `id` and a one-line `name`. These drive item
  generation, so make them specific ("cookie carries only an opaque id"), not
  vague ("sessions work").
- **`rationale`** — 1–4 entries. Each is a real design *decision*, its *why*, the
  *alternatives* considered/rejected, and its `provenance`. In a fresh build you
  are inferring these from the code, so **`provenance: inferred`** for all of
  them. (A future senior-interview pass will upgrade some to `prompt:<ref>` /
  `interview:<ref>`; the schema already carries provenance so it slots in without
  migration — PLAN §4.3.)

Province and root READMEs use the same frontmatter minus `concepts`/`rationale`
(they orient rather than teach); they still carry a stable `id`, `title`, and may
list representative `sources`.

---

## The paper form (7 body sections)

cluedoc's six sections, **plus a new Rationale section** (§4.1). Keep them in this
order. Prose only.

1. **Hero visual** — one Mermaid diagram at the top that captures the component's
   shape at a glance (a flow, a state machine, a sequence, or a small component
   graph). This is the "figure 1" of the paper and anchors spatial memory.
2. **Abstract** — 2–4 sentences: what this component is and why it exists, self
   contained. A reader should grasp the whole from the abstract alone.
3. **Introduction** — the problem this component solves and the context a newcomer
   needs before the details. Motivate before you explain.
4. **Related Work** — cross-links to *other papers* (`[Session Management](../session-management/)`).
   **These links ARE the graph** — they become `reference` edges in `map.json`.
   Link every component this one collaborates with, depends on, or contrasts
   against. No dead links (Link step verifies this).
5. **Description** — the substance: how it works, the moving parts, the data and
   control flow, the invariants. Still prose — describe the mechanism, don't paste
   the code. This is where `concepts` are explained in narrative form.
6. **Rationale** *(new)* — the prose form of the `rationale[]` frontmatter. Explain
   the key decisions, why the alternatives were rejected, and what would break if
   the decision were reversed. Mark inferred reasoning honestly ("The code
   suggests…") so a later interview pass knows what to confirm. This section is
   what makes the *rationale* coverage dimension gradable.
7. **Conclusion** — a short synthesis: where this component sits in the larger
   system and what a reader now understands. Point forward to the most important
   Related Work neighbors.

Do not add a code section, an API reference, or file listings — that lives in the
source, and duplicating it rots. The paper explains; the code is the ground truth
(`sources` is the bridge).

---

## Workflow

### 0. Estimate & confirm  →  cost gate BEFORE any analysis (non-skippable)

**This is the very first thing you do — before reading a single source file, before
Survey, before anything.** A full build is expensive (LLM-heavy; see the calibration
in `scale estimate`), so the user must see the cost and pick the build model first.

1. Run `scale estimate` in the target repo. It is pure and fast (fs scan +
   arithmetic — no LLM, no API) and prints: repo size → **target component count
   and the band you must build inside**, the province shape that count implies,
   whether file-level anchors are what caps it, and estimated **cost + time for
   each BUILD model (Opus 5 and Fable 5)**.
2. **Present that output to the user verbatim.** The component count is not a
   footnote to the price — it is the contract for the build. Note that the two
   are computed independently: the price is projected from source lines alone,
   so it does **not** rise when you propose more components than the target.
   That is precisely why the count has to be honoured rather than merely noted:
   nothing about the price will stop you. Measured on koa, built twice from one
   commit — 36 components against a target of 8 spent about 1.4× the tokens of
   the 8-component build. More, because the papers are the output, but nowhere
   near the 4.5× the count overshot by, since most of a build is reading the
   same source either way.
3. **State the model YOU are running on.** The build happens in this Claude Code
   session, so the model doing the work is the session's — there is no config key
   that changes it, and no way for you to switch it yourself. Say plainly which
   model you are. If it is **not Opus 5 or Fable 5**, tell the user the build
   tier wants one of those and that they must switch with **`/model`** and re-run
   `/scale-map`; do not proceed on a smaller model just because they asked.
4. **Ask the user to confirm and STOP for their answer:** given the estimate and
   the model you just named, do they want to run the (paid) build now?
5. **Do not begin Survey (or any repo analysis / paper writing) until the user
   explicitly confirms.** If they decline, stop cleanly. This gate is mandatory
   on every fresh build; only **Sync mode** (§5, updating an existing `.scale/`)
   skips it, since sync touches only drifted papers, not a full build.

### 1. Survey  →  propose, get approval

Explore the repository (read the README, entry points, directory layout,
package/build manifests, route tables, schema/migrations). Then propose a **plan**
for human approval before writing anything:

- **Components — as many as the estimate said, inside its band.** For each, a
  proposed `id`, `title`, and candidate `sources`. Aim for a coherent learnable
  unit, roughly "a thing a junior could understand in one sitting". Two hard
  constraints, both from **What you produce** above: no component may be finer than a file,
  and no file should be claimed by more than one component unless it genuinely
  is shared behaviour.
- **Provinces — as many as the estimate's shape line says, each holding 5–9.** Name them after
  user-facing or architectural seams (e.g. Authentication, Document Signing,
  Templates, Teams, Webhooks), not after directories.

Present this as a table/tree and **stop for approval**. Granularity is the
make-or-break decision; do not proceed to Write on a guess.

**If your honest partition falls outside the estimate's band, you must stop.**
Do not build it and mention the discrepancy afterwards — that has already
happened once and produced a map at 4.5× the estimate, five components deep on
every source file, which broke the edit gate, coverage credit and drift together.
Instead: say which way you differ and why, note that the cost moves with the
count, and ask the user to approve the revised number explicitly before you
write anything. The band is roughly 1.5× either way, further clipped so that its
top never authorizes something the check would reject: it will not exceed what
one flat layer of provinces holds, nor a density of about one component per
source file. Needing more than the band usually means the repo has few, large
files, in which case say so — the honest fit is the file count, and finer
partitioning has to wait for symbol-level anchors.

After Layout, run **`scale map check`**. It holds the built partition to the same
arithmetic — size against the band, components per anchored file, group sizes —
and exits non-zero when it does not hold. A build is not finished until it passes
or the user has accepted a named exception.

### 2. Write  →  subagent fan-out, one province at a time

Write every paper. **Fan out with subagents** so papers are built in parallel and
each subagent holds only its slice of the repo in context. Give each subagent: its
components with `sources`, this paper form, the terminology rule, and — this is
the part that decides the map's quality — the accuracy rule below.

**One subagent per province, unless there is only one province.** A small repo
sizes to a single province, and then per-province fan-out is no fan-out at all:
one subagent writes every paper in sequence. In that case fan out **per
component** instead, hand each writer the full component roster so its Related
Work links resolve, and write the province and root papers afterwards from the
finished set.

**Accuracy is the writer's job, not the reviewer's.** Instruct every subagent to:
read its anchored sources end to end before writing; verify every falsifiable
claim against the code, and where a claim is about behaviour, against the repo's
own tests or by running it; check that a causal chain is the chain the code
actually takes, not a plausible one; and **omit anything it cannot confirm** — a
shorter true paper beats a fuller false one. Require each subagent to report what
it could not verify. Without this, papers come back confidently wrong: one build
asserted in two separate papers that middleware registered after the request
handler is created does not run, argued a design rationale for it, and was
refuted by a five-line script. A false paper is worse than a missing one, because
the tutor grades a junior against it.

**This applies to the province and root papers too, and they are where it gets
forgotten.** They are written last, from the finished component papers, and it is
tempting to let them summarise rather than verify — at which point they
generalise. Measured on one build: the province paper stated a count of shared
files that `scale map check` contradicts, claimed a uniform default-handling rule
that two of the settings do not follow, and gave a reason for one grouping that
its own component paper disproves. Every claim in an orienting paper is a claim
about the code, so hold it to the same standard: check it, or drop it to the
level of generality you can actually support. Also read the component papers
against each other — two of them describing the same edge in opposite terms is a
contradiction only a reader of both will catch, and that reader is you.

Each component paper must have: complete extended frontmatter (with
`provenance: inferred` on every rationale entry), a hero Mermaid visual, and all
seven sections. Explain the `concepts` in the Description; explain the `rationale`
in the Rationale section. Prose only — re-check for leaked code/paths before
finishing.

Papers are **always written in English**, regardless of the per-user
`config.language` setting: the coverage memory is repo-shared state, while
`language` is a per-user *interaction* preference (it changes what the tutor and
the web UI say to the junior, not what the memory contains). A Korean-language
session must not drift into Korean papers.

Also write the province READMEs (orienting the province, linking its components)
and the root `.scale/README.md` (orienting the whole realm, linking provinces).

### 3. Link  →  Related Work cross-links, verify no dead links

Ensure every paper's Related Work section links its true neighbors, and that every
link resolves to an existing paper folder. Add reciprocal links where the
relationship is mutual. **Verify there are zero dead links** before proceeding —
broken links corrupt the graph and the map edges built from it.

### 4. Layout  →  freeze coordinates (deterministic, CLI — NOT you)

Run the CLI to compute and **freeze** the spatial map:

```
scale map layout
```

This is deterministic — a seeded PRNG keyed off the sorted node ids, a compact
sunflower spiral per province, then collision relaxation against fixed neighbours;
coordinates normalized 0–1 — and writes `map.json` with `provinces`, `nodes` (each
with `x`, `y`, `importance`), and `edges` (`hierarchy` from the folder tree +
`reference` from Related Work links).

`importance` is the **normalized in-degree of a component's `reference` /
`depends_on` edges** — how many other papers link *to* it. It is not dependency
centrality and not git churn: that measure was designed and never built, and the
component's own paper records why (`.scale/map/frozen-layout/`). Write Related
Work links because they are true, not to inflate a component's size.

**You never hand-place nodes and never edit `map.json` coordinates.** Spatial
stability is the entire point of the map (survey knowledge / method-of-loci —
PLAN §4.2): the layout is computed once and frozen. After this freeze, new
components are placed *incrementally near their neighbors* and existing nodes
never move.

Then (optional, regenerable) build the reverse index used by the junior's hooks:

```
scale map index      # file→component reverse index (index.json, gitignored)
```

Commit `.scale/` (papers + `map.json`). `index.json` is gitignored and rebuilt on
demand.

### 5. Sync mode  →  update after code changes (later runs)

When invoked after the code has changed, do **not** rebuild from scratch. Instead:

1. Run `scale map drift` — it flags components whose `sources` changed since the
   map's `builtFromSha` (this is what surfaces staleness / "rebellion").
2. For each flagged component, re-read its `sources` and update its paper
   **progressively, up and down the tree** (cluedoc's progressive model): fix the
   Description, revise `concepts` if the shape changed, and revise `rationale`
   (keep provenance honest — new inferred reasoning stays `inferred`). Ripple
   changes up to the province/root papers when a component's role shifts.
3. If genuinely new components appeared (new files matching no `sources`), add
   them: new folder, full paper, Related Work links — then re-run `scale map
   layout`, which **places the new nodes incrementally without moving existing
   ones**. Never re-run a global re-layout after the initial freeze (it would
   destroy spatial memory — PLAN §10).
4. Re-verify no dead links.

---

## Quality bar (self-check before you finish)

- [ ] `scale map check` exits zero (partition inside the estimate's band, at most
      ~1 component per anchored file, provinces of 5–9), all within a clean tree
      under `.scale/`.
- [ ] Every component paper has a stable `id`, `sources` (files only), 2–6 concrete
      `concepts`, 1–4 `rationale` entries each with `provenance`.
- [ ] Every paper has a hero Mermaid visual and all seven sections in order.
- [ ] Bodies are prose only — zero code symbols, paths, or snippets in the text.
- [ ] Related Work links resolve (zero dead links); the graph is connected.
- [ ] `map.json` was produced by `scale map layout`, not hand-edited.
- [ ] Terminology is neutral throughout — no game-skin words in any paper.
- [ ] Every rationale a fresh build inferred is honestly marked `inferred`.
