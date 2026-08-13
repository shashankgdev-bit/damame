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

## Usage

```sh
npm install
npx tsx apps/cli/src/main.ts        # opens the dashboard — prints a clickable local link
```

That's the main flow: a local web dashboard (127.0.0.1 only, nothing leaves your
machine) with your session list, each session drawn as a waveform of its turns,
findings with clickable evidence, and one-click feedback on every finding.

For scripting and CI there's a full CLI:

```sh
npx tsx apps/cli/src/main.ts list                 # sessions on this machine, newest first
npx tsx apps/cli/src/main.ts analyze --latest     # terminal report for the most recent session
npx tsx apps/cli/src/main.ts analyze <id-prefix> --html report.html --json
npx tsx apps/cli/src/main.ts rules                # the detector registry
```

### Your AI skills profile

The dashboard opens on **your skills**: seven AI-development competencies —
Prompt Engineering, Planning & Decomposition, Agent Orchestration, Context
Engineering, Tooling Fluency, Workflow Automation, Recovery & Verification —
each assessed **only against real opportunities** found in your sessions.

The rule that makes it fair: *rate = uses ÷ (uses + missed opportunities)*,
where a "miss" is a deterministic finding proving the opportunity existed. If
your recent work never called for a skill, it reads **"not needed recently"**
— neutral, never a deficit. Each skill links named techniques (detected in
your transcripts: tried / never tried, with short lessons), and every session
gets a skills panel: "this session could have been better if the file survey
had gone to the Explore agent — it was available."

`damame profile` prints the same from the terminal. It measures **practice,
not ability** — and it compares you only to your own past.

### The feedback loop

Every finding prints a short key in its evidence line. Tell damame when a
finding was right or wrong — this is how per-rule precision gets measured
instead of asserted:

```sh
npx tsx apps/cli/src/main.ts feedback <key> accurate|inaccurate|applicable|not-applicable
npx tsx apps/cli/src/main.ts feedback stats       # factual precision + acted-on rates, local only
```

Feedback is two narrow questions instead of one fuzzy "helpful": **accurate?**
(did the cited events happen as described — checkable against the evidence)
and **applicable?** (was the suggestion usable there). The third dimension —
did it actually change anything — is never asked as an opinion: **recurrence
tracking** measures each flagged pattern's frequency in your sessions before
vs after damame first surfaced it. Behavior, not self-assessment.

Verdicts live in `~/.damame/` and are keyed by rule id + major.minor version,
so a rule whose thresholds change starts a fresh precision series. Nothing is
ever uploaded. A rule whose observed precision stays low gets demoted or
retired — that is a release commitment, not an aspiration.

## Status

v0.1: Claude Code JSONL adapter → normalized session IR → deterministic
metrics → 10 detectors → terminal / HTML / JSON reports, plus the local
feedback loop. Validated against real 200MB+ transcripts; token accounting
cross-checked against ccusage (<0.2% delta). Next: golden annotated corpus,
then an opt-in LLM-judge layer that ships together with its validation
harness (stability testing, human-agreement calibration, abstention).

## Layout

- `packages/ir` — normalized Session IR + Finding schemas (Zod; the core contract)
- `packages/adapter-claude-code` — streaming transcript parser → IR
- `packages/metrics` — deterministic per-session metrics bundle
- `packages/rules` — versioned detectors ("session smells")
- `packages/report-html` — self-contained HTML report renderer
- `apps/cli` — the `damame` command
- `docs/rules` — one documented rationale page per rule
- `fixtures` — scrubbed/synthetic transcripts with golden expected outputs
