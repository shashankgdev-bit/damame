# retry-storm

**Category:** infra · **Since:** 0.1.0 · **Confidence:** deterministic

## What it detects

Provider-side API trouble during the session: three or more transient
`api_error` system events (each recording the client's automatic `retryInMs`
backoff wait), or any assistant message that is a synthetic error placeholder
(`model: "<synthetic>"`) emitted after a request failed terminally.

This rule exists for fairness. The delay it measures was caused by API
availability, not by anything the user or the agent did, and it must never
count against the session. The finding's job is to contextualize wall-clock
numbers in *other* findings — severity is always `info` and the recommendation
prescribes no change.

## Evidence it keys on

- runs of consecutive `system_event` events with `subtype: "api_error"` from
  the deterministic metrics pass (`api_error_runs`), including each run's
  summed `retryInMs`
- `assistant_message` events with `is_error_placeholder: true` (placeholders on
  abandoned branches are ignored)

## Savings method (measured)

Sum of the `retryInMs` backoff waits recorded on `api_error` system events —
wall-clock time the client demonstrably spent waiting on provider-side errors.
No token claim is made: the transcript records no usage for failed requests.
When only a terminal placeholder exists and no backoff wait was recorded, the
finding omits `savings` entirely rather than model one.

## How to fix it

Nothing to fix in the session itself — transient API errors are outside its
control. If large operations repeatedly hit overload errors, re-running them
off-peak can help. Primarily, subtract the reported retry wait when judging
wall-clock-based findings elsewhere in the report.

## Known non-firing cases (tested)

- 2 `api_error` events with no terminal placeholder (just under threshold)
- repeated *tool* failures (e.g. a failing test command run three times) — a
  look-alike storm that is session behavior, not API infrastructure
