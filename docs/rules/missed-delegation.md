# missed-delegation

**Category:** delegation · **Since:** 0.1.0 · **Confidence:** deterministic

## What it detects

A run of 15 or more consecutive read-only tool calls (Read, Grep, Glob, LS,
WebFetch, WebSearch, NotebookRead) in the main thread within a single turn,
when a delegable agent type (`Explore` or `general-purpose`) was listed in the
session's own environment snapshot and no subagent was spawned anywhere in that
turn. If neither agent type was available in the session, the rule never fires
— it will not claim the user had a tool they didn't. Severity escalates from
moderate to major when a compaction event also falls inside the same turn: the
undelegated survey grew the context until earlier detail was discarded.

## Evidence it keys on

- the per-turn longest read-only run from the deterministic metrics pass
  (`read_only_runs`), with its first/last call event ids
- absence of any `subagent_run` event inside the turn's event index range
  (`session.turns`)
- `agent_listing_delta` attachments in the transcript itself (`env.agents`,
  `removed !== true`) — never current disk state
- `compaction` events inside the same turn range (severity escalation only)

## Savings method (modeled)

Sum of `output_bytes / 4` over the tool results linked to the run's calls
(events on abandoned branches are skipped). This is a bytes-per-token
approximation of the read output that entered the main context and was
re-carried by every subsequent request in the session. It assumes a subagent
performing the same survey would have returned only a short summary, whose size
is treated as negligible by comparison. When no result bytes were recorded, the
finding omits savings rather than guess.

## How to fix it

Delegate multi-file surveys to an available agent instead of reading file after
file in the main thread, e.g. "Ask the Explore agent to survey the files and
return only the conclusions". The raw file contents then live in the subagent's
context; only its final answer enters the main thread.

## Known non-firing cases (tested)

- 14 consecutive reads (just under threshold)
- 16 consecutive reads with no delegable agent listed in the session env
- 15 consecutive reads in a turn that also spawned a subagent (Task call)
