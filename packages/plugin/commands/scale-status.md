---
description: Show SCALE coverage status — unification progress and territory states.
---

# /scale-status

Report the junior's current coverage at a glance. Read-only; no learning check.

Run `scale status` (or `scale context` if `status` is unavailable) and present
its output:

- **Unification progress** — the weighted total coverage across the realm
  (Σ importance × mean dims / Σ importance, PLAN §5.1).
- **Territory breakdown** — counts by state: fog / explored / validated / stale.
- **Rebellion** — any previously-validated components now `stale` (drifted code)
  that want re-validation.
- **Recently touched** — components visited this session and their coverage.

Keep it concise. If the coverage memory or state is not yet initialized, say so
and point to `/scale-map` (to build the memory) or `scale init` (to init state).
