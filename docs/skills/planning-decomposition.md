# Planning & Decomposition

Agreeing on scope before tokens are spent.

Large tasks handed to an agent without a plan tend to drift: the agent
builds something, you redirect, work gets thrown away. Settling the
approach first means direction changes happen on a cheap plan instead of on
half-built code, and breaking work into visible steps keeps long sessions
from silently dropping pieces.

## How damame measures it

Opportunity-aware: rate = uses / (uses + misses).

- **Misses:** each finding from the `abandoned-work` rule — work the agent
  produced and then discarded after a redirect — counts as a missed
  planning opportunity.
- **Uses:** one use per technique per session where `plan-mode-first` or
  `todo-tracking` is observed.

With fewer than 2 total opportunities the state is "getting started" (too
little data to say more); a rate of 0.7 or above with enough opportunities
reads as "practiced well".

## Techniques

### Plan mode before big changes

Start large or ambiguous tasks in plan mode: the AI proposes an approach
you approve before any tokens are spent executing. Direction changes then
happen on a plan, not on half-built work. In Claude Code, Shift+Tab cycles
into plan mode; damame detects it from the session's recorded permission
modes, so entering it even once in a session counts.

### Task tracking on multi-step work

Ask for (or let the AI keep) a running todo list on multi-step tasks. It
keeps long sessions oriented and makes dropped steps visible instead of
silently forgotten. Detected from TodoWrite calls; saying "keep a todo list
for this" at the start of a large task is usually enough, and the list
doubles as a checkpoint when you return to a session after a break.

## What this never means

- No `abandoned-work` findings and no technique uses means the recent work
  didn't call for planning — a neutral state, not a gap.
- The rate measures whether detected opportunities were taken, not how well
  you can plan in general.
- No cross-person comparison: opportunities come only from your own
  sessions.
