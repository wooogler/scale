---
description: Open the SCALE map viewer — the whole map, one component, one section of its doc, or settings.
argument-hint: "[component-id [section] | settings [tab]]"
---

# /scale-open

Open the SCALE map viewer in a browser and always hand the user the URL.

1. Run `scale serve ensure --json`. It reuses a running viewer or starts a
   detached one, and prints `{ url, port, pid, started, reused }`. It never
   hangs longer than ~3 s; on a non-zero exit, relay its one-line message and
   stop.
2. Work out the target from `$ARGUMENTS`:
   - empty → the map itself, no flag.
   - `settings` or `settings <tab>` → `--settings <tab>`, where `<tab>` is one
     of `general` | `gate` | `checks` | `team` (default `general`).
   - `<component-id>` → `--component <id>`.
   - `<component-id> <section>` → `--component <id> --section <section>`, which
     opens that component's panel scrolled to one section of its doc. The
     section vocabulary is stable and English (it is derived from the doc's
     English source, so it survives translation):
     - `concepts` — the declared concepts list;
     - `decisions` — the design-rationale list;
     - a heading slug from the doc body — `summary`, `what-it-does`,
       `related-components`, `how-it-works`, `design-decisions`,
       `where-it-sits`, plus any sub-heading, kebab-cased.
     A section the doc does not have is not an error: the viewer opens the doc
     from the top. `--section` is normalized, so `--section "Design decisions"`
     and `--section design-decisions` are the same link.
3. Open it:
   - **If this session has a browser-preview tool** (a tool named
     `preview_start`, `navigate`, or the desktop app's built-in browser), get
     the URL with
     `scale serve url [--component <id> [--section <slug>] | --settings <tab>] --json`
     and open it there — the user sees the map right beside the conversation.
   - **Otherwise** run
     `scale serve open [--component <id> [--section <slug>] | --settings <tab>]`,
     which opens the system browser and prints the URL.
4. **Always echo the URL as a clickable link**, on its own line, even when the
   preview tool already opened it — e.g.
   `Map viewer: http://localhost:4318/#/c/gate-core/design-decisions`.

If the component id is not one the map knows, say so and open the map root
instead of guessing. Keep the reply to a line or two: what opened, and the URL.

Once a doc is open the reader can keep going without you: its **Related
components** links are clickable and move between docs in-app, and the **📖 Docs**
button in the header lists every component doc grouped by province.
