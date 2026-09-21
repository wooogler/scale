---
description: Post-session review — run the comprehension checks you owe, in chat, exactly as the edit gate would have.
argument-hint: "[component-id]"
---

# /scale-review

The **post-session** surface of SCALE, in chat. Under `gate.assessment: async`
the edit gate only TEACHES when it denies an edit and leaves the check owed;
this command is where that check happens — and it happens **exactly as it
would have in-flow**: same tutor, same modality, same quiz shape, same cards,
same recording, same skip. Only the timing differs. That parity is what the
study measures, so do not "adapt" the check to the review setting.

Use the **scale-tutor** skill, section **Post-session review**.

1. `scale review queue --json` — the ordered list of what this user should
   review now: owed checks first (async denies), then territory they touched
   since it was last checked and still understand below the bar. Relay the
   list in one short block (component, why it is here, when). If `$ARGUMENTS`
   names a component, review only that one (it need not be in the queue).
   Empty queue → say so in one line and stop.
2. For each item, in order: `scale review start <componentId>` prints the
   **brief** — the same instruction text the edit gate's deny reason carries,
   with a review head instead of a deny head. Follow it as you would a deny
   reason. Grounding for the diff comes from `scale review diff <componentId>`
   (the code they changed in that territory) — the gate path's "session diff".
3. Run the check per the skill (quiz → one `AskUserQuestion` card per item;
   socratic → ≤ 3 exchanges), record with `scale record`, relay the progress
   line, close with Reading pointers, then move to the next item.
4. Skip is the junior's call, exactly as in the gate path: `scale gate defer
   <componentId>` (unless the brief says enforcement is hard), then next item.
5. After the last item, one short summary: what was checked, what unlocked,
   what remains owed.

No budget applies (the junior chose to be here), but keep each check as tight
as an in-flow one — that is the point.
