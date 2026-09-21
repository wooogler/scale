---
description: Manually trigger a grounded comprehension check on touched territory (testing).
argument-hint: "[component-id]"
---

# /scale-quiz

Manually fire a comprehension check — a testing/dev shortcut into the same
tutor path the edit gate uses (PLAN-GATE §3), without waiting for an edit to be
denied. A check passed here unlocks the territory exactly as a gate-path check
would.

Use the **scale-tutor** skill.

- Target component: `$ARGUMENTS` (a component `id`). If empty, pick the most
  recently touched fog / low-coverage / stale component from the CLI.
- Run the check in the configured modality (quiz or socratic), grounded in the
  component doc (`concepts` + `rationale`) and the session diff. Quiz items go
  out as `AskUserQuestion` cards, one per item, exactly as the skill's
  **Delivery** section says (no `(Recommended)`, correct slot randomized).
- Grade per dimension and record via `scale record <componentId> --dim <dim>
  --score <0..1>` — one call per quiz item (default `--origin session`).

No answer-reveal before the junior attempts. Keep it short and supportive. Useful
for iterating on item quality against the pilot docs (PLAN §10).
