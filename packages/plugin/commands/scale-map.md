---
description: Build or sync the SCALE coverage memory (Mode B) for this repository.
---

# /scale-map

Invoke the **scale-map** skill to build or update the coverage memory for the
current repository (PLAN §4.3). Senior side — run with Opus or better.

Use the **scale-map** skill now.

- If `.scale/` does not yet exist → run the full build: **Survey** (propose 5–9
  provinces and 20–60 components for approval) → **Write** (subagent fan-out, one
  province each) → **Link** (Related Work, no dead links) → **Layout** (`scale
  map layout` to freeze `map.json`).
- If `.scale/` already exists → run **sync mode**: `scale map drift` to find
  components whose sources changed, update those papers progressively up/down the
  tree, place any new components incrementally, re-verify links.

Arguments: `$ARGUMENTS` — optionally a province or component `id` to scope a sync
to, or `dry-run` to produce only the Survey plan without writing papers.

Stop for human approval after Survey before writing anything.
