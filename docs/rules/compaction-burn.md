# compaction-burn

**Category:** context-hygiene · **Since:** 0.1.0 · **Confidence:** deterministic

## What it detects

Two or more context compactions in a single session (`min_compactions`, default
2). Each compaction pauses work while the conversation is summarized, and
detail not carried into the summary has to be re-established afterward.
Repeated compactions indicate bulk tool output — full-file reads, wide search
results — accumulating in the main context window. Severity is moderate at 2–3
compactions and major at 4 or more. All compactions in the session are grouped
into one finding.

## Evidence it keys on

- `compaction` events from the deterministic metrics pass (`compactions`),
  parsed from the CLI's `compact_boundary` system lines
- `compactMetadata.durationMs` / `preTokens` / `postTokens` recorded on each
  boundary by the CLI

## Savings method (measured)

Wall-clock only: the sum of `compactMetadata.durationMs` recorded by the CLI
for each compaction — time the session demonstrably spent inside the
summarization pause. No token savings are claimed: the cost of re-establishing
summarized-away detail is real but not defensibly attributable from the
transcript alone, so it is omitted rather than modeled. If no compaction in the
session carries a recorded duration, `savings` is omitted entirely.

## How to fix it

Delegate bulk file reading and searching to an exploration subagent (`Explore`
or `general-purpose`) when one is available in the session — only the
subagent's summary returns to the main context, delaying or avoiding
compaction. Without such an agent: read targeted line ranges instead of whole
files, keep search output narrow, and carry forward conclusions rather than raw
tool output. The recommendation cites a subagent only when the session's own
environment snapshot listed one (and it was not removed); otherwise it falls
back to the `delegate-bulk-exploration` prompting pattern.

## Known non-firing cases (tested)

- a single compaction (just under threshold)
- a resumed session carrying a compact-summary user message, plus api_error
  system events, but no `compact_boundary` in this transcript
