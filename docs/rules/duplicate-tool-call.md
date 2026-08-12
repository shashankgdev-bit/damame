# duplicate-tool-call

**Category:** redundant-work · **Since:** 0.1.0 · **Confidence:** deterministic

## What it detects

The same tool call — identical name and input, matched by the pre-truncation
`input_hash` — issued more than once, returning byte-identical output every
time, with no successful state-changing tool call (Bash, Edit, Write,
MultiEdit, NotebookEdit) between the first and last occurrence. Under those
conditions the repeats could not have observed anything new; each one re-paid
for output already in context. A group fires when it has at least
`min_occurrences` calls (default 3) *or* the repeats re-injected at least
`min_repeated_bytes` of output (default 20,000) — so a pair of duplicated
large reads fires even below the occurrence threshold. TodoWrite and
AskUserQuestion are skipped entirely: repetition is part of their normal
protocol.

## Evidence it keys on

- `tool_call.input_hash` equality across occurrences (sha256 of name + full
  input, computed pre-truncation)
- `tool_result.output_hash` identical on every occurrence — the proof the
  repeats returned nothing new
- `state_change_between: false` from the deterministic metrics pass
  (`duplicate_tool_calls`), which excludes abandoned-branch events
- `repeated_output_bytes`: the summed `output_bytes` of every occurrence after
  the first

## Savings method (modeled)

`repeated_output_bytes / 4` — the bytes of output re-injected by occurrences
after the first, converted to tokens with the ~4 bytes/token approximation.
The first occurrence is never counted; it was necessary work. Savings are
omitted entirely when the duplicated output was empty. Severity is moderate
when the repeated bytes cross `min_repeated_bytes`, minor otherwise.

## How to fix it

Refer back to the earlier result instead of re-running the call: the file
content, command output, or search hits are already in context from the first
occurrence. Re-run only after something has actually changed — and when a file
is needed in several places, read it once up front rather than once per use.

## Known non-firing cases (tested)

- 2 occurrences with small output (under both thresholds)
- re-running the same call after an Edit succeeded in between
  (`state_change_between` — correct behavior, not redundant work)
- occurrences whose outputs differ (`identical_results: false`)
- repeated TodoWrite calls, even with identical input and large output
