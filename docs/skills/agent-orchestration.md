# Agent Orchestration

Delegating bulk work to subagents and workflows.

A main session that reads every file itself carries all of them in context
until compaction. Delegation moves bulk reading into subagents that return
only their conclusions; parallel spawning runs independent work concurrently.

## How damame measures it

Opportunity-aware: rate = uses / (uses + misses).

- **Misses:** each finding from the `missed-delegation` rule — a bulk
  read-and-search sequence the main session ran itself when a subagent
  could have carried it.
- **Uses:** one use per technique per session for `subagent-delegation`,
  `parallel-agents`, `workflow-orchestration`, and `background-tasks`.

## Techniques

### Delegating bulk work to subagents

When a task needs many files read or searched, delegate to a subagent (like
Explore): only its conclusions return to your session, keeping the main
context small and delaying compaction. In Claude Code, asking "use an agent
to find where X is handled" is enough — the Agent tool does the rest.

### Running agents in parallel

Independent investigations don't need to wait for each other — spawn
several agents in one turn and they run concurrently. Wall-clock time drops
to the slowest branch instead of the sum. Phrase the request as one message
("investigate A, B, and C in parallel") so the spawns land in a single turn.

### Multi-agent workflows

For work with a known fan-out shape (review every module, migrate every
call site), a workflow script orchestrates many agents deterministically —
pipelines, verification passes, synthesis. Reach for this when the same
prompt applies to a list of targets you can enumerate up front.

### Background execution

Long-running commands (builds, test suites, servers) can run in the
background while the session continues. You get notified on completion
instead of blocking every turn on the slowest command. Ask for "run the
build in the background", or let the agent set `run_in_background` on Bash.

## What this never means

- No `missed-delegation` findings and no uses means recent work was small
  enough not to need delegation — neutral, not a deficit.
- The rate measures taken opportunities in transcripts, not orchestration
  ability.
- No comparison across people; opportunities come from your own sessions.
