---
description: Show SCALE coverage status — unification progress and territory states.
---

# /scale-status

Report the junior's current coverage at a glance. Read-only; no learning check.

Run `scale status` and present its output (git+file reads only, no LLM). It
prints, per PLAN §5.1:

- **Header** — repo-id, user, gate (assessment/modality + enforcement), the
  resolved intervention model, whether a committed team policy is applied, and
  how many territories are unlocked for editing.
- **Unification progress** — the importance-weighted total coverage across the
  realm (Σ importance × mean dims / Σ importance).
- **Territory breakdown** — counts by state: fog / explored / validated / stale.
- **Per-province rollup** — each province's components with their skin-neutral
  state (fog/explored/validated/stale) and comprehension mean.
- **Needs re-validation (stale)** — previously-validated components whose code
  drifted (rebellion) and want re-validation.
- **Pending quests** — count of quests still awaiting completion.

Use `scale status --json` for the structured form. Keep the presentation
concise. If the coverage memory or state is not yet initialized, `scale status`
says so; point to `/scale-map` (to build the memory) or `/scale-settings setup`
(to init state and pick the settings, without a terminal).

End every report with the map viewer URL as a clickable link — get it from
`scale serve url` (or `scale serve ensure --json` if nothing is running yet) —
plus one line: **`/scale-open <component-id>`** opens a territory in the viewer,
and **`/scale-settings`** changes the gate, language, model or any other setting.
