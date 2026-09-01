# cache-thrash

**Category:** context-hygiene · **Since:** 0.1.0 · **Confidence:** deterministic

## What it detects

Prompt-cache misses reported by the API itself. Each affected response carries a
`cache_miss_reason` and the exact number of input tokens that were re-processed
at full input price instead of being served from cache
(`cache_missed_input_tokens` in `message.diagnostics`). Misses are grouped by
reason; one finding is emitted per reason group whose summed missed tokens reach
`min_missed_tokens` (default 100,000). Severity is `moderate`, escalating to
`major` at `major_missed_tokens` (default 1,000,000).

Reasons `previous_message_not_found` and `unavailable` are typically
infrastructure-side (an expired or evicted cache entry), not a result of how the
session was driven — those groups are reported at severity `info` for cost
visibility, never as a behavior finding.

This is the tool's highest-precision signal: nothing is inferred. The provider
recorded both the miss and its token cost.

## Evidence it keys on

- `assistant_message.cache_miss.reason` and `.missed_input_tokens`, surfaced by
  the deterministic metrics pass (`cache_misses`)
- misses without a reported token count are excluded from both the threshold sum
  and the evidence (only responses whose cost the API quantified are cited)
- misses on abandoned branches are skipped

## Savings method (measured)

Sum of `cache_missed_input_tokens` reported by the API in
`message.diagnostics` for the cited responses. Nothing is modeled; the token
count comes directly from the provider's own accounting of the miss.

## How to fix it

For `tools_changed`: keep the set of enabled MCP servers and tools stable for
the whole session. Each mid-session toggle changes the tools block at the top of
the prompt and invalidates the cache for everything after it — configure the
tool set before starting work instead of toggling servers mid-session.

For `previous_message_not_found` / `unavailable`: no session-side change
reliably prevents these; they originate on the API side. Long pauses between
requests make cache expiry more likely.

For other reasons: keep earlier context byte-stable across requests — the prompt
cache keys on an exact prefix match, so any change to earlier content
invalidates every cached block after it.

## Known non-firing cases (tested)

- summed misses just under `min_missed_tokens` (99,999 across one reason)
- misses that cross the threshold only in aggregate across *different* reasons
  (no single reason group reaches the threshold)

## Changelog

- **0.2.0** — provider-side miss reasons (`previous_message_not_found`, `unavailable`) now carry category `infra`: they route to "not your inefficiency," are excluded from the score, and can never read as the user's fault — the same treatment retry-storm and resume-orphaned branches get. Found by adversarial review of the surfaces layer: the old info-severity findings were voting into the session-hygiene coach card as if the user had caused them.
- **0.1.0** — initial rule.
