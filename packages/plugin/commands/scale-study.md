---
description: Voluntarily study a component — reading guide plus a comprehension check.
argument-hint: "[component-id]"
---

# /scale-study

Start **voluntary learning** on a component (PLAN §6.3). Available in every
condition; **no interruption budget applies** — this is the junior's own
initiative. Works even with no coding task in progress.

Use the **scale-tutor** skill in voluntary study mode.

- Target component: `$ARGUMENTS` (a component `id`). If empty, offer a short menu
  of the junior's fog / low-coverage / stale territory and ask which to study.
- Give a **reading guide** over the component doc first (hero visual, key
  concepts, rationale; point at the `sources` to read the real code).
- Then offer a **comprehension check** in the configured modality (quiz or
  socratic). Passing counts as a voluntary validation, recorded via `scale
  record` with `--origin voluntary`.

Brief, supportive, grounded. If the junior only wants to read, that's fine —
record nothing and leave the check open.
