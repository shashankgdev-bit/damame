# repeated-delegation

**Category:** missed-resource · **Since:** 0.1.0 · **Confidence:** deterministic

## What it detects

The same delegation re-improvised by hand many times. The rule collects every
subagent spawn in the session and normalizes each spawn's task `description`
into a "task family" key: lowercase, collapse whitespace, replace digit runs
with `#`, keep the first three tokens. When one family accumulates
`min_occurrences` spawns (default **5**), the rule fires once for that family.

Severity is **moderate**, escalating to **major** when the family reaches three
times the threshold (15 occurrences at the default) — at that scale the session
is plainly running a procedure, not making one-off requests.

The finding is about reliability, not tokens: every hand-retyped variant of the
procedure reconstructs it from memory, so steps can be reworded, reordered, or
dropped between runs with no guarantee the runs were equivalent. A saved,
parameterized workflow makes the procedure a single command whose steps are
identical by construction.

## Evidence it keys on

- `subagent_run` events in `session.events`, skipping those with
  `on_abandoned_branch`.
- Each run's spawn `tool_call` (via `spawn_call_event_id`) and that call's
  string `input.description`. Runs with no linked spawn call, or whose call has
  no string description, are skipped entirely — there is nothing to compare.
- Cited events are the spawn tool calls (up to 8 per family; further
  occurrences are counted in `evidence.metrics.occurrences` but not cited).
- `evidence.metrics` carries `occurrences`, the normalized `family` key, and up
  to 3 `sample_descriptions` verbatim.

## Savings method (none)

No savings block is emitted. The repetition itself is not waste — each spawn
did real, distinct work, and a workflow would have spent roughly the same
tokens running the same steps. The cost being flagged is drift and omission
risk across hand-typed variants, which has no honest token model.

## How to fix it

Save the repeated delegation as a named, parameterized workflow (a skill or
slash command that takes the varying part — the target, the file, the case
number — as an argument). Invoking it becomes one command per run, the
procedure's steps are fixed in one place, and changing the procedure means
editing the workflow once rather than remembering to retype it consistently.

## Known non-firing cases (tested)

- 4 spawns of the same family (one under the default threshold).
- 6 spawns with unrelated descriptions — six families of one, none at
  threshold.
- Spawns whose `Task` call carries no `description` input, regardless of
  count.
- Descriptions differing only in case, extra whitespace, digits, or words past
  the third token still group together (fires as one family — tested as the
  positive case, not a non-firing one).
