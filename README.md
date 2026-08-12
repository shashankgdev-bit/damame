# damame

**A profiler for your AI coding sessions.**

damame analyzes agentic coding sessions — Claude Code transcripts first — and produces
evidence-linked findings about how the session went: wasted retries, cache thrash,
abandoned work, manual grinding that an available subagent would have handled, and
resources (skills, agents, tools) that were available but unused.

Think **Lighthouse/ESLint for AI-assisted development**: named, versioned, documented
rules; every finding cites the exact transcript events it keys on; every savings number
states whether it was **measured** (tokens actually spent on identified waste) or
**modeled** (a stated-assumption estimate).

## Principles

- **Local-first, zero telemetry.** Your transcripts never leave your machine.
- **Deterministic core.** Same session in, same findings out. v1 contains no LLM
  judgment at all; when a judgment layer arrives it will be opt-in, clearly labeled,
  and shipped together with its validation harness.
- **Findings, not scores.** There is no composite grade, no leaderboard, and no plan
  for either until per-rule precision is measured and published. A finding you can
  verify beats a number you can't.
- **Honest baselines.** "You had X available and didn't use it" is checked against the
  availability recorded *in that session's own transcript*, not your current config —
  because your installed tools change over time.
- **High precision over recall.** A rule that cannot demonstrate its false-positive
  posture with non-firing fixtures does not ship.

## Non-goals

- Ranking or comparing developers. This is a coaching tool, not a surveillance tool.
- Grading exploratory work as "inefficient." Probing, dead ends, and direction changes
  are often the right way to work; rules are designed around unambiguous waste.
- Pretending counterfactuals are facts. "This could have been one prompt" is a
  hypothesis; damame only ships hypothesis-grade claims labeled as such.

## Status

Early development. v1 scope: Claude Code JSONL adapter → normalized session IR →
deterministic metrics → ~10 detectors → terminal / HTML / JSON reports.

## Layout

- `packages/ir` — normalized Session IR + Finding schemas (Zod; the core contract)
- `packages/adapter-claude-code` — streaming transcript parser → IR
- `packages/metrics` — deterministic per-session metrics bundle
- `packages/rules` — versioned detectors ("session smells")
- `packages/report-html` — self-contained HTML report renderer
- `apps/cli` — the `damame` command
- `docs/rules` — one documented rationale page per rule
- `fixtures` — scrubbed/synthetic transcripts with golden expected outputs
