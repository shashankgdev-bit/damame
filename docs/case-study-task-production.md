# Case study — profiling an agent-task production pipeline

This is damame turned on a real, long-running pipeline that produced AI agent tasks and
graders over a summer. It doubles as a worked example of what "platform analytics for
agent work" looks like: cost, bottlenecks, and behavior change, measured from the sessions
themselves. **Numbers only — no task content, prompts, or file contents.**

## The pipeline, measured

- **80 days**, one project, **4.34 billion tokens** of session history (190M fresh work;
  the rest cache reads).
- **962 turns**, 758 human, 7,719 tool calls, **87 subagent delegations**.

## Bottlenecks damame found

- **The human as data courier.** 170 near-identical result blocks were entered by hand
  across the run (1.64 MB, 8 distinct templates) — grader output relayed into the chat one
  paste at a time, each verification cycle stalling until the next delivery. *This is the
  single biggest throughput leak in an environment-production loop: the verifier's output
  can't reach the agent without a human in the middle.* Fix: give the agent direct access
  to the grader (a CLI, a connector) so the check-fix loop runs continuously.
- **Context carried too long.** One 80-day session accumulated **26 compactions**; one of
  them measurably forced **32 byte-identical re-reads** (62 KB re-purchased) — the summary
  kept the file names but not their contents. Fix: per-task sessions briefed by a notes
  file; durable facts in project memory, not conversation memory.
- **Re-improvised work.** The same probe delegation was hand-written **5 times** instead of
  frozen into a reusable skill/workflow — each retelling drifting a little.

## Behavior that was already good (measured, credited)

The pipeline was not naive: **220 background tasks**, **89 slash commands**, **87 subagent
delegations**, **358 targeted reads**. damame credits exercised capabilities; it only
flags an opportunity as missed when the transcript proves the opportunity existed.

## The outcome — practice improving, measured

Across the summer's sessions, the operator's damame score rose **42 → 68 → 79** as
delegation, background execution, and targeted reading replaced manual grind. That trend
is computed independently in the companion Python package (`damame-py`) from the versioned
export — the tool measuring its own user getting better, from behavior, not opinion.

## Why this matters for building agent environments

The same machinery that finds "you hand-relayed the grader 170 times" is verifier-shaped
thinking: deterministic detection of a pattern, evidence-linked, with a measured cost and a
labeled confidence. Profiling *how environments get produced* — where the SME time goes,
which steps are manual, whether a fix actually stuck — is exactly the platform-analytics
problem of scaling environment creation.
