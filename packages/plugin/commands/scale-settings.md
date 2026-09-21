---
description: Set SCALE up, or change any setting — in chat, no terminal needed.
argument-hint: "[setup | <key> [value] | what you want to change]"
---

# /scale-settings

Configure SCALE conversationally. No one should need a terminal to set this up
or to change how the gate behaves.

Use the **scale-settings** skill now.

- `$ARGUMENTS` decides the mode:
  - **empty** → run `scale setup status --json`. If `initialized` is `false`,
    go to **setup mode**; otherwise show the short settings summary and ask what
    they want to change.
  - **`setup`** → **setup mode**: walk the first-run choices (user label,
    language, gate assessment/modality/enforcement, model provider + tier, API
    key) with the AskUserQuestion tool, one choice at a time.
  - **anything else** → **change mode**: a dotted key with or without a value
    (`gate.modality socratic`, `quiz.items`), or plain language in any language
    ("게이트를 async로 바꿔줘", "switch to opus", "turn the gate off").

Reply in the user's configured `language` (`en` or `ko`). Keep every turn
short — one question or one confirmation at a time.

Never ask for an API key in chat, and never put a key in a command line. The
skill's two key paths (the viewer's settings page, or `scale keys set
<provider> --stdin` in the user's own terminal) are the only ones.
