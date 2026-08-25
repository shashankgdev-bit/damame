# eternal-session

**Category:** context-hygiene · **Since:** 0.1.0 · **Confidence:** deterministic

## What it detects

One session that has become a long-lived workspace rather than a task-scoped conversation. The rule fires only when three signals coincide:

- the session was resumed at least `min_resumes` times (default **15**) — counted as resume boundaries, i.e. transcript lines whose parent pointer is null;
- the context was compacted at least `min_compactions` times (default **3**);
- the wall-clock span from the session's first to last event is at least `min_span_days` days (default **7**).

Each compaction pauses work while the conversation is summarized, and each summary is lossy — a session kept alive for weeks runs on summaries of summaries. Severity is **moderate**, escalating to **major** when the compaction count reaches `major_compactions` (default **10**).

This rule intentionally overlaps with `compaction-burn`: that rule fires on the single-session compaction burn itself, while this one fires on the session-lifecycle pattern that keeps producing compactions because the session is never allowed to end.

## Evidence it keys on

- `session.chain_root_event_ids` — resume boundaries recorded by the adapter (lines with `parentUuid: null`).
- `metrics.compactions` — compaction events; up to 8 are cited as evidence events.
- `session.started_at` / `session.ended_at` — wall-clock span in days.
- Tool-call `file_path` inputs on the live branch, matched case-insensitively against `CLAUDE.md | LEDGER | LEARNINGS | BRIEFING | NOTES | PLAN` to detect existing state files (abandoned-branch calls are excluded). The matched file names appear in `evidence.metrics.state_files` (may be empty).
- `evidence.metrics` carries `resumes`, `compactions`, `span_days` (rounded to one decimal), and `state_files`.

## Savings method (measured)

`savings.wall_clock_ms` is the sum of `compactMetadata.durationMs` recorded by the CLI for each compaction — wall-clock time demonstrably spent paused in summarization. This is the same measured basis `compaction-burn` uses; the overlap is deliberate (see above). Savings are omitted entirely when no compaction recorded a duration. No token savings are claimed: the re-establishment cost after each lossy summary is real but not defensibly attributable from the transcript alone.

## How to fix it

Adopt a session-per-task lifecycle:

- If the session already touches state files (a ledger, plan, notes, or `CLAUDE.md`), those files already carry the memory — start a fresh session from them for each new task. The recommendation names the exact files observed.
- If no state files were touched, first create a state/briefing file that records the project's working state, then start fresh sessions from it.

A new session that begins by reading its state file gets the same working knowledge in a clean, cheap context, with no compaction chain behind it.

## Known non-firing cases (tested)

- 14 resumes with 3 compactions over 7 days (one resume under threshold).
- 15 resumes with 2 compactions over 7 days (one compaction under threshold).
- A 2-day session with 1 compaction and 5 resumes — a normal multi-sitting task.
- A 30-day span with only 5 resumes and 2 compactions — long-lived but not a compacting workspace.
