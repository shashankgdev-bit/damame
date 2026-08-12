# edit-fail-loop

**Category:** error-loop · **Since:** 0.1.0 · **Confidence:** deterministic

## What it detects

Three or more consecutive failures of the Edit tool against the same file with a
stale-content signature (`edit_string_not_found`, `edit_string_not_unique`,
`file_not_read`, `file_modified_since_read`). Interleaved *diagnostic* calls
(e.g. a Read between two failed Edits) do not break the run — the classic
Edit-fail → Read → Edit-fail cycle is exactly what this rule targets. A
successful Edit of the same file ends the run.

## Evidence it keys on

- `tool_result.is_error: true` with a normalized `error_signature` in the set above
- same `tool_call.input.file_path` across the run
- run boundaries from the deterministic metrics pass (`error_runs`)

## Savings method (measured)

Sum of deduped assistant usage (grouped by API `message.id`) between the first
failure in the run and the run's end — tokens demonstrably spent on
re-attempts. Wall-clock is the timestamp span of the run. Nothing is modeled;
the first attempt is never counted.

## How to fix it

Read the exact region of the file immediately before constructing an edit, and
re-read after any tool call that may have modified it. If the same string
appears multiple times, include more surrounding context in `old_string`
instead of retrying variants.

## Known non-firing cases (tested)

- 2 consecutive failures (just under threshold)
- failures spread across different files
