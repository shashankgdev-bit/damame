# abandoned-work

**Category:** prompting · **Since:** 0.1.0 · **Confidence:** deterministic

## What it detects

A branch of the session that was abandoned by a rewind (escape / re-prompt)
after at least 200k tokens of recorded assistant usage were spent on it. The
adapter resolves forks structurally — a transcript line with more than one
child means the session was rewound and exactly one child continued — so the
rule adds no inference of its own; it only thresholds the adapter's per-branch
usage summary. One finding fires per qualifying branch; severity escalates to
major at 1M abandoned tokens.

The rule is deliberately conservative: rewinds are often intentional
exploration, so the default threshold is high and the wording claims only what
is recorded — the tokens were spent and the path did not continue.

## Evidence it keys on

- `session.metadata.abandoned_branches` (surfaced as
  `metrics.abandoned_branches`): the adapter's fork-resolution summaries
  `{fork_parent_uuid, root_event_id, event_count, usage_tokens}`
- the branch's `root_event_id` is the cited evidence event (branches without
  one are skipped)
- `usage_tokens` and `event_count` are echoed in `evidence.metrics`

## Savings method (measured)

The branch's `usage_tokens` verbatim: deduped input+output+cache-write usage of
assistant responses on the abandoned branch (grouped by API `message.id`);
cache reads excluded. These tokens were demonstrably spent on work that was
discarded — nothing is modeled and no counterfactual baseline is assumed.

## How to fix it

Recommends the `plan-mode-first` prompting pattern: state the intended scope up
front, or start in plan mode so the approach is agreed before execution. When
the direction change is foreseeable, that surfaces it before the spend rather
than after.

## Known non-firing cases (tested)

- an abandoned branch whose recorded usage is just under the threshold (198k)
- a sequential direction change ("actually, different approach") with no
  rewind — no fork exists, so no work was discarded
