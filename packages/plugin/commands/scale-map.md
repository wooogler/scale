---
description: Build or sync the SCALE coverage memory (Mode B) for this repository.
---

# /scale-map

Invoke the **scale-map** skill to build or update the coverage memory for the
current repository (PLAN §4.3). Senior side — run with Opus or better.

Use the **scale-map** skill now.

- If `.scale/` does not yet exist → run the full build: **Estimate** (`scale
  estimate` — the target component count and the band, presented verbatim, plus
  the cost gate) → **Survey** (propose that many components, grouped into
  provinces, for approval) → **Write** (subagent fan-out, one province each) →
  **Link** (Related Work, no dead links) → **Layout** (`scale map layout` to
  freeze `map.json`) → **Check** (`scale map check` must exit zero).
- If `.scale/` already exists → run **sync mode**: `scale map drift` to find
  components whose sources changed, update those papers progressively up/down the
  tree, place any new components incrementally, re-verify links.

Arguments: `$ARGUMENTS` — optionally a province or component `id` to scope a sync
to, or `dry-run` to produce only the Survey plan without writing papers.

Stop for human approval after Survey before writing anything. If your honest
partition falls outside the estimate's band, stop and get the revised number
approved — do not build past it and explain afterwards.
