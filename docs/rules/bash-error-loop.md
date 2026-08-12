# bash-error-loop

**Category:** error-loop · **Since:** 0.1.0 · **Confidence:** deterministic

## What it detects

Three or more consecutive failures of the same Bash command (normalized:
whitespace-collapsed, truncated) with a retryable-looking signature
(`exit_code_nonzero`, `command_timeout`). Interleaved calls with *other* tools
do not break the run — only a successful Bash result ends it, so
Bash-fail → Read → Bash-fail cycles are covered. Severity escalates from
moderate to major at 5 consecutive failures (`major_at_failures`).

## Evidence it keys on

- `tool_result.is_error: true` with `tool_name: "Bash"` and a normalized
  `error_signature` of `exit_code_nonzero` or `command_timeout`
- same normalized `tool_call.input.command` across the run
- run boundaries from the deterministic metrics pass (`error_runs`)

## Savings method (measured)

Sum of deduped assistant usage (grouped by API `message.id`) between the first
failure in the run and the run's end — tokens demonstrably spent on
re-attempts. Wall-clock is the timestamp span of the run. Nothing is modeled;
the first attempt is never counted.

## How to fix it

Diagnose before retrying. Read the error output of the failed command; if the
cause is unclear, re-run once with verbose or debug flags rather than
verbatim. Inspect the state the command depends on (file paths, environment
variables, service or process status) so the next invocation is a corrected
command, not a repeat. For timeouts, check whether the command is interactive,
waiting on a lock, or simply needs a longer explicit timeout.

## Known non-firing cases (tested)

- 2 consecutive failures (just under threshold)
- 3 failures of different commands (different normalized targets)
- a successful Bash call between failures, which ends the run
