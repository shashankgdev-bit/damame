# idle-gap-notifications

**Category:** missed-resource · **Since:** 0.1.0 · **Confidence:** deterministic

## What it detects

Sessions where finished work repeatedly sat waiting because nothing announced it was done. The rule counts the idle gaps between a turn ending and the next human prompt that are at least `min_gap_ms` (default 300000ms, 5 minutes). It fires once per session when at least `min_gaps` such gaps occurred (default 5) **and** their sum reaches `min_total_ms` (default 1800000ms, 30 minutes).

The framing matters: being away from the terminal is fine and normal — the human may be in a meeting, working elsewhere, or deliberately multitasking. The inefficiency this rule surfaces is the absence of a notification signal, which lets completed work age silently instead of interrupting the human the moment it's ready. Severity is always `minor` — this is a gentle nudge, never a criticism.

## Evidence it keys on

- `metrics.idle_gaps_ms` — human think-time gaps, computed as the wall-clock delta between the previous turn's last event and the next human-origin turn's first event. Only turns with `origin === "human"` produce a gap.
- The metric carries no event ids (it is a bare array of millisecond values), so the session's first event is cited as the single schema-required evidence anchor.
- `evidence.metrics` records `gap_count` (qualifying gaps), `total_idle_ms` (their sum), and `largest_gap_ms`.

## Savings method (none)

No savings block is emitted, deliberately. Away-time is not recoverable token or compute waste — the human may have been doing other productive work during every gap — and claiming the summed idle time as "savings" would be dishonest. The rule reports the pattern and the fix, nothing more.

## How to fix it

Enable a notification channel so waiting work interrupts you instead of silently aging:

- Run `/config` in Claude Code and turn on the terminal bell or system notification for turn completion / input needed.
- Where available, enable mobile push notifications so long-running turns can reach you away from the machine.

## Known non-firing cases (tested)

- 4 gaps of 6 minutes — under the `min_gaps` count threshold, even though each gap individually qualifies.
- 6 gaps of 2 minutes — every gap is under `min_gap_ms`; brief pauses are normal think time.
- 5 gaps of ~5 minutes summing to under 30 minutes — count met, but total idle time under `min_total_ms`.
- Many short pauses summing past 30 minutes — sub-threshold pauses never count toward the total; an actively responding human is not a missed notification.
