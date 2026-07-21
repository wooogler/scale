---
id: session-lifecycle-hooks
title: Session Start and Session End
sources:
  - packages/plugin/hooks/session-start.mjs
  - packages/plugin/hooks/session-end.mjs
concepts:
  - id: context-injection-envelope
    name: Session start returns an explicit structured envelope so injected text is unambiguous and stable across editor versions
  - id: injection-is-not-a-prompt
    name: The injected summary is a few lines of context for the agent, never a question the user has to answer
  - id: fresh-session-record
    name: Starting a session resets the per-session record that carries the interruption budget, using a newly generated identifier rather than the editor's
  - id: detached-session-end
    name: Session end launches follow-up work fully detached and returns immediately without observing the child
  - id: policy-lives-in-the-command
    name: Whether session end produces anything at all is decided downstream from configuration, so the hook itself has no condition logic
rationale:
  - decision: Session start emits a structured envelope rather than relying on plain output being interpreted as context
    why: Plain output happens to be treated as added context today, but an explicit envelope states the intent and survives changes in how the editor interprets a hook's output
    alternatives: Printing bare text was rejected as version-fragile; printing nothing and having the agent query on demand was rejected because the summary must arrive before the first turn to shape it
    provenance: inferred
  - decision: Session end hands its work to a fully detached process and exits without waiting
    why: The follow-up work may contact a model over the network, and a session that hangs while closing is the most irritating possible interruption because the user has already disengaged
    alternatives: Running the work synchronously was rejected outright; deferring it to the next session start was rejected because it would move the cost onto the moment the user is trying to begin
    provenance: inferred
  - decision: Both scripts are dumb translators with no branching on study condition or coverage state
    why: Condition and budget logic must be deterministic, testable, and changeable in one place; duplicating it into shell-adjacent scripts would let the two drift apart silently
    alternatives: Checking the configuration in the hook to skip the call entirely was rejected because it saves one short process start at the cost of two implementations of the same policy
    provenance: inferred
---

```mermaid
sequenceDiagram
    participant U as Developer
    participant E as Editor session
    participant SS as Session start script
    participant SE as Session end script
    participant C as Fast command surface
    participant D as Detached child

    E->>SS: session begins, payload on input
    SS->>C: ask for the coverage summary
    C-->>SS: a few lines of text, or nothing
    SS-->>E: structured envelope adds text to agent context
    Note over U,E: work happens; other hooks capture signals
    E->>SE: session ends, payload on input
    SE->>D: launch follow-up work, streams severed
    SE-->>E: exit immediately, nothing observed
    D-->>D: decides from configuration whether to do anything
```

## Abstract

These are the two hooks that bracket a working session: one runs as it opens and injects
a short coverage summary into the agent's context, the other runs as it closes and kicks
off post-session follow-up work without waiting for it. Both are deliberately thin — they
read the event payload, make exactly one call, and exit. What makes them interesting is
the asymmetry between them: the opening hook is synchronous because its whole purpose is
to produce text that must arrive before the first turn, while the closing hook is
detached because its work may involve a network call and must never delay an exit.

## Introduction

A session boundary is the one moment where a comprehension system can speak to a
developer's agent without interrupting anything. Nothing is in flight, no edit is
half-applied, no thought is mid-sentence. The system exploits both boundaries, for
opposite reasons.

At the opening boundary the goal is orientation. The agent is about to help someone work
on a codebase for which a coverage record already exists — which components the person has
genuinely validated, which they have merely brushed against, which have drifted since they
last proved they understood them. Handing the agent a few lines of that is cheap and shapes
its behavior for the whole session. It has to be synchronous, because context that arrives
after the first turn is context that did not shape the first turn.

At the closing boundary the goal is the opposite: to start something and get out of the
way. Post-session follow-up may need to generate comprehension items, which may mean a
model call, which may mean seconds and a network. A session that lingers while closing is
worse than one that lingers while starting, because the user has already left. So the
closing hook launches and abandons.

## Related Work

The mechanics that make both of these calls safe — resolution of the command, the timeout
backstop, the detached launch, the context envelope itself — all live in
[Hook Wiring and the Fail-Open Rule](../plugin-hooks/), which is the prerequisite for
reading this paper. The three hooks that fire between these two boundaries are covered by
[Capturing Touches, Prompts, and Review Latency](../edit-and-prompt-hooks/); together the
five make up the whole observation surface. The work the closing hook launches is
documented in [Selection, Generation, and Offline Fallback](../../quests/quest-generation/),
including what happens when no key is available. The summary the opening hook injects is
produced by a recomputation over the evidence log, described in
[Impure Edges: Git Churn, Clock, and Disk](../../comprehension/coverage-materialization/).
The fold underneath that recomputation — the pure function that turns the whole evidence
history into the states and figures the three injected lines report — is
[Pure Materialization of Coverage](../../comprehension/state-engine/); the opening hook is
borrowing an interpretation that belongs to comprehension rather than forming one of its own,
and that borrowing is the only reading of the record capture ever does.
The per-session record that the opening hook resets is where the interruption budget is
counted, and its layout is part of
[Per-User State Layout and Repository Identity](../../platform/state-directory/); the
budget itself is spent by [Deny, Retry, and Defer-as-Drop](../../interventions/gate-enforcement/).
The study condition that the closing hook pointedly refuses to branch on, together with the
size of that budget, is declared in
[Conditions, Budgets, Thresholds, and Model Tiers](../../platform/config-schema/), which is the
single place the policy these two scripts decline to implement actually lives.
Both scripts address the system through [The Command Surface](../../platform/cli-surface/).

## Description

The opening script reads the event payload from standard input, makes one synchronous
call asking for the coverage summary, and — only if that call reported success — wraps
the resulting text in a context envelope and prints it. Then it exits successfully,
unconditionally. If the call failed, timed out, or produced nothing, the script prints
nothing and the session begins exactly as it would have without the plugin installed.
The envelope helper trims the text and suppresses the output entirely when the text is
empty, so an installation with no coverage memory yet injects silence rather than an
empty shell.

It is worth being precise about who that text is addressed to, because the mechanism looks
superficially like an interruption and is not one. The envelope adds material to the
agent's context; it is not shown to the developer as a message, it asks nothing, and
nothing waits on a reply. The developer types their first request exactly as they would
have anyway, and the only difference is that the agent answering already knows which parts
of the codebase this person has proved they understand. Nothing here spends the
interruption allowance, because nothing here interrupts. That distinction is what allows
the summary to be unconditional — it can be injected at the start of every single session,
however many there are, without any budget or cooldown, precisely because its cost to the
person is zero.

What the call does downstream matters for understanding what the hook actually achieves.
It first writes a fresh per-session record — a newly generated identifier, the current
time, a zeroed count of interruptions fired, no last-interruption timestamp, and no
pending component. This is how the interruption budget is reset: a new session is a new
allowance. Notably the identifier is generated locally rather than taken from the event
payload, even though the payload carries the editor's own session identifier. The payload
is piped in and simply not read, because the command surface takes its arguments from the
command line. In practice this is harmless for the opening hook, since the command needs
nothing from the payload, but it does mean the record's identifier and the editor's do not
correspond.

The command then re-materializes coverage from the evidence log and formats at most three
lines. The first is always present and gives the total number of components, the
importance-weighted progress figure as a percentage, and a breakdown of how many are
validated, merely touched, or still unknown. The second appears only if there is anything
to say and names up to three of the weakest components that are still unknown or merely
touched, ordered by their mean comprehension. The third appears only if some component has
been flagged as needing re-validation, and lists those.

If materialization throws — no coverage memory in the repository, an
unreadable map document — the command catches it and prints a one-line notice instead. The
notice is still printed on the success stream, so the hook injects it as context; the agent
is told that coverage is unavailable rather than told nothing. The script comment also
mentions a possible silent drift refresh at this point, but no drift check runs here today;
per-component staleness detection is one of the acknowledged gaps in the system.

The closing script is shorter still. It reads the payload and calls the detached launcher,
which spawns the follow-up work with an extra flag marking it detached, discards both of
the child's output streams, writes the payload to its input, closes it, unreferences the
child, and returns. The parent exits immediately. Nothing observes the child, so nothing
can report on it: if it fails, it fails silently and invisibly from the session that started
it. The comment is explicit that the parent does not wait for or observe the child.

Whether that follow-up work should do anything at all is decided entirely downstream. Under
a post-session study condition it selects a handful of components that were touched during
the session and are weakly covered or stale, weights them by importance, and generates
comprehension items for them. Under an in-flow condition it does nothing and says so. The
hook has no idea which is which, and that is intentional — the branch exists once, where it
can be tested, rather than twice.

Together these two scripts define the session as a unit for everything else: the budget that
limits interruptions is scoped to it, the set of components considered for follow-up is drawn
from it, and the summary injected at its start reflects everything learned before it.

## Rationale

The choice of an explicit envelope over bare text is justified directly in the source
comment, which notes that plain output is also treated as added context but calls the
envelope explicit and version-stable. Read charitably, the reasoning is that a hook is a
contract with software the authors do not control; relying on a convenience behavior means
a future change to that behavior turns a working feature into a silent no-op with no error
to notice. The envelope names the event and the intent, so a change in interpretation
breaks loudly or not at all. Reversing this would probably work today and might quietly
stop working later, which is the worst kind of dependency for a system whose failures are
already designed to be silent.

Detaching the closing hook is the sharper decision, and the comments are unambiguous about
why: the work may call a model and must never block exit. The interesting part is what is
given up. Because nothing observes the child, there is no way for the session that started
the work to know it succeeded, and a user who closes a session and reopens it immediately
may find follow-up items not yet present. Both costs were evidently judged smaller than a
delay at exit. If the call were made synchronous instead, the worst case would be a session
that appears frozen for several seconds while a network request completes — and if the
request hung, the outer timeout in the wiring would be the only thing saving the exit.

Keeping condition logic out of both scripts appears to follow from a broader pattern
visible across this codebase: hooks translate, commands decide. The closing hook could
cheaply read configuration and skip the launch entirely under an in-flow condition, saving
one process start per session. That optimization was not taken. The likely reason is that
the condition is the manipulated variable of the study; having exactly one place that reads
it means an experimental condition can never be half-applied because two implementations
disagreed. The cost of the road not taken is negligible; the cost of divergence would be
invalidated study data.

## Conclusion

These two scripts frame every session: one opens it by giving the agent a compact picture
of what the developer actually understands, the other closes it by starting follow-up work
it will never hear back from. Both are thin on purpose, and both lean entirely on the
guarantees described in [Hook Wiring and the Fail-Open Rule](../plugin-hooks/). To see what
happens between the boundaries, read
[Capturing Touches, Prompts, and Review Latency](../edit-and-prompt-hooks/); to see what
the closing hook actually sets in motion, read
[Selection, Generation, and Offline Fallback](../../quests/quest-generation/).
