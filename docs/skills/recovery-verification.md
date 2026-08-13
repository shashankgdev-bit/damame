# Recovery & Verification

Breaking error loops and verifying what the AI produced.

Agents fail in loops: the same edit retried against stale file content, the
same command re-run into the same error. The skill is noticing the loop
early, changing the input instead of retrying it, and treating "the AI says
it's done" as a claim to check rather than a fact. The tokens burned inside
a loop are the most measurable waste in a transcript.

## How damame measures it

Opportunity-aware: rate = uses / (uses + misses).

- **Misses:** findings from the `edit-fail-loop` and `bash-error-loop`
  rules — three or more consecutive same-signature failures against the
  same target. Wasted tokens are measured from the actual re-attempts,
  never modeled (see docs/rules/edit-fail-loop.md for the method).
- **Uses:** one use per session where `verify-with-tests` is observed.

With fewer than 2 total opportunities the state is "getting started"; a
rate of 0.7 or above with enough opportunities reads as "practiced well".

## Techniques

### Verifying with tests

After the AI edits code, a test run is the cheapest truth serum. Sessions
that run tests after edit bursts catch breakage while the context to fix it
is still loaded. Detected from Bash calls invoking a known test runner
(vitest, jest, pytest, go test, cargo test, and similar). Asking for "run
the tests before you tell me it's done" makes verification part of the
task; a post-edit hook that runs the suite makes it the default instead of
a habit.

## What this never means

- No error loops and no test runs can simply mean the sessions were short
  or not code-editing work — "not needed recently" is neutral.
- The rate measures observed recovery practice, not debugging skill.
- No cross-person comparison; every opportunity comes from your own
  sessions.
