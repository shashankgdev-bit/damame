# oversized-context-reads

**Category:** context-hygiene · **Since:** 0.1.0 · **Confidence:** deterministic

## What it detects

Full-file Reads — no `offset`, no `limit` — whose result was large enough
(≥ ~80KB, thresholded by the metrics pass) that the entire file body entered
the model context. Once loaded, that content is carried in every subsequent
request until compaction, so a single oversized read taxes the whole rest of
the session. Findings are grouped per file: one large full read is `minor`;
two or more full reads of the same file raise the finding to `moderate`.

## Evidence it keys on

- `metrics.large_full_reads`: successful `Read` results with
  `output_bytes ≥ 80,000` whose call had neither `offset` nor `limit`
- `tool_call.input.file_path` for grouping repeated reads of the same file
- events on abandoned branches are excluded by the metrics pass

## Savings method (modeled)

Sum over the group of `(output_bytes − assumed_targeted_bytes) / 4`. Two
assumptions, both stated in the finding's method string: 4 bytes per token, and
that a targeted read of ~`assumed_targeted_bytes` (default 8,000 bytes) would
have sufficed. Nothing here is measured — which bytes were actually needed is
unknowable from the transcript — so the basis is always `modeled`.

## How to fix it

Locate the relevant region first (Grep for the symbol or section), then Read
only that region with `offset`/`limit`. When a large file genuinely needs
broad exploration and an Explore subagent is available, delegating the scan
keeps the bulk of the file in the subagent's context instead of the main
thread's; the finding still recommends the targeted-read prompting pattern
because a single large read may be a one-off.

## Thresholds

- `min_reads` (default 1): full reads of a file required before firing
- `assumed_targeted_bytes` (default 8,000): counterfactual targeted-read size
  used by the savings model
- the 80KB size floor lives in the metrics pass, not this rule

## Known non-firing cases (tested)

- a large Read that passed `limit` (already targeted, whatever its size)
- a full read just under the 80KB threshold
