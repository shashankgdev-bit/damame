# permission-churn

**Category:** interaction-friction · **Since:** 0.1.0 · **Confidence:** deterministic

## What it detects

Three or more permission denials in a single session (default `min_denials: 3`;
severity escalates from minor to moderate at twice the threshold). A denial is
the user declining a proposed tool call at the permission prompt — the model
constructed and sent a call, the user rejected it, and the model had to re-plan
around the rejection. Recurring denials, especially for the same tool,
indicate the session's permission settings do not match the workflow. One
finding is emitted per session, with a per-tool breakdown.

## Evidence it keys on

- `permission_denial` events from the deterministic metrics pass
  (`permission_denials`), each carrying the denied tool's name
- denials on abandoned branches are excluded
- per-tool counts reported in `evidence.metrics.denials_by_tool`

## Savings method (none claimed)

This rule omits `savings` deliberately. The token cost of a denied call is
trivial (one short tool_use block plus a rejection result), and the dominant
real cost — human wait and attention time at each permission prompt — is not
defensibly measurable from the transcript in v1: the gap between prompt and
denial mixes the user's reaction time with whatever else they were doing.
Rather than model an assumption-heavy number, the rule claims nothing.

## How to fix it

If the `fewer-permission-prompts` skill is available (the rule checks the
session's own environment snapshot and recommends it only when present), run
`/fewer-permission-prompts`: it scans transcripts for routinely-approved calls
and adds a prioritized allowlist to `.claude/settings.json`. Otherwise, add
`permissions.allow` entries to `.claude/settings.json` for the calls you
routinely approve — starting with the most-denied tool in the session — and
use plan mode first for exploratory phases so proposed actions are reviewed as
a batch instead of prompt-by-prompt.

## Known non-firing cases (tested)

- 2 denials (just under threshold)
- ordinary tool failures (e.g. Bash exit-code errors) — errors, not denials
