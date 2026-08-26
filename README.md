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

## How damame validates itself

The hardest problem in a tool that judges AI sessions is not parsing — it's **trust**: who
validates the validator? Damame's answer is that every layer is graded by a *different* mechanism,
and no layer ever grades its own homework:

- **Detectors are graded by planted crimes.** A synthetic ground-truth corpus generates sessions
  with inefficiencies *planted by construction*, plus innocent look-alikes engineered to sit just
  under thresholds. CI demands perfect recall on plants and zero false positives on innocents —
  one miss fails the build. The gate has caught real detector bugs before any user saw them.
- **The LLM judge is graded by counterfeits.** When an LLM audits findings, every batch silently
  includes *honeypots* — findings corrupted by construction (evidence swapped, counts inflated)
  that the judge must refute. Its catch-rate is a live, label-free accuracy score; verdicts also
  pass a mechanical quote gate (citations that don't literally appear are discarded), majority
  voting with abstention, and calibration against human answers.
- **The AI-written brief is graded by citations.** The session story generator never sees the raw
  transcript — only a measured digest — and every claim must cite digest items. A dumb string
  check deletes uncited claims before render.
- **The score is graded by ordering.** Sessions with planted waste must score strictly below clean
  ones; innocents and provider-caused problems must stay high — enforced in CI. Formulas are
  published in [docs/score.md](docs/score.md) and versioned; any change resets comparability.
- **Everything is graded by you, twice.** Two narrow feedback questions per finding (accurate? /
  applicable?) build public per-rule precision — and *behavioral recurrence* measures whether
  flagged patterns actually shrink in your later sessions, which no opinion can fake. Rules have
  been changed by this loop (resume-orphaned branches were being blamed as rewinds; a user's
  transcript proved otherwise; the rule was fixed and its record reset).

Full methodology: [docs/judge.md](docs/judge.md) · [docs/score.md](docs/score.md) ·
[docs/playbooks.md](docs/playbooks.md)

## Principles

- **Local-first, zero telemetry.** Your transcripts never leave your machine.
- **Deterministic core.** Same session in, same findings out. v1 contains no LLM
  judgment at all; when a judgment layer arrives it will be opt-in, clearly labeled,
  and shipped together with its validation harness.
- **Findings first; scores only as validated lenses.** Early damame shipped no
  composite grade at all — a number you can't verify is worse than no number. The
  session score exists now *because* it could finally be validated: published formulas,
  versioned like rules, corpus-gated (planted waste must lower it, innocence must not),
  and every point traceable to a finding you can check. The findings remain the truth;
  the score only summarizes them.
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

### The session brief — what was this chat, in plain language

Opening a session auto-generates a short **brief**: what the session was
about, how the human and Claude worked together, and how the work was done
mechanically — written for someone who has never heard of MCP. The generator
(your local `claude` login; cached after first open) never sees the raw
transcript: it receives a **structured digest** of sampled prompts and
measured stats, and **every claim must cite digest items** — citations are
verified mechanically and uncited claims are dropped. Hover any claim's ◦
marker to see exactly what it rests on.

### Playbooks — recommendations that are retrieved, never improvised

Curated knowledge about kinds of sessions lives in
[`packages/playbooks/`](packages/playbooks/) — known mistakes and fixes,
grounded in real transcripts, each backed by a deterministic **signature
detector** with its own corpus gate. A session sees a playbook entry only when
its signature *actually fired there* (matching works by brief tags or by a
two-signature quorum — the quorum path needs no LLM at all). Entries without a
detector yet are reference-only, never auto-recommended. How the library
grows — including the community pattern-card pipeline — is documented in
[docs/playbooks.md](docs/playbooks.md).

### Your AI skills profile

The **your skills** view (sidebar → more) tracks seven AI-development competencies —
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

### damame-py — analytics across sessions (Python)

`npx damame export --out export.json` dumps every session's analysis (scores, findings,
feedback, recurrence — never transcript content) in a stable versioned schema, and the
[`python/`](python/) package loads it into pandas: score trends over time, wasted tokens per
rule, habit-fading curves, cache-efficiency per session, and the tool's own precision under
your feedback. See [python/README.md](python/README.md).

### The session score — validated, not vibes

Each session opens with a score: **overall 0–100 plus five parameters** (cost efficiency,
context hygiene, redundant work, missed capabilities, prompting & recovery), with a
"capabilities exercised n/7" strip that is recognition only — never averaged in. Every formula
is published in [docs/score.md](docs/score.md); clicking the score shows every penalty and the
finding behind it. Validity is enforced in CI: sessions with planted waste must score below
clean ones, innocent look-alikes must stay high, and provider-side problems can never lower
your score. Formula changes bump `score@N` and reset comparability — scores are versioned like
rules.

### Measured accuracy — the ground-truth corpus

Every detector is continuously evaluated against a **synthetic ground-truth
corpus**: generated sessions with inefficiencies *planted by construction*
(plus clean look-alike sessions where any finding is automatically a false
positive). Because detectors are deterministic, the CI gate demands perfection
— one missed plant or one false positive fails the build.

Current result over 480 generated sessions (20 per each of 24 archetypes — 15 planting
one waste pattern each, 9 innocent near-misses built one unit under a threshold — seeded):

| rule | recall | precision |
|---|---|---|
| all 15 rules | **1.00** | **1.00** |

Run it yourself: `npx tsx scripts/corpus-eval.ts 20 7`. Building this gate
immediately caught two real detector-quality bugs (double-reporting of failed
repeats, noise on tiny diagnostic re-reads) before any user saw them — that
is what it exists for. Synthetic recall proves detectors catch what they
claim; the feedback loop and recurrence tracking below cover whether findings
matter in real sessions.

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

v0.6: Claude Code JSONL adapter → normalized session IR → deterministic
metrics → 15 detectors → local web dashboard + terminal / HTML / JSON reports,
the validated session score, citation-gated session briefs, playbooks, the
opt-in honeypot-calibrated LLM auditor, the local feedback + recurrence loop,
and the versioned export consumed by damame-py. Validated against real 200MB+
transcripts; token accounting cross-checked against ccusage (<0.2% delta).

## Layout

- `packages/ir` — normalized Session IR + Finding schemas (Zod; the core contract)
- `packages/adapter-claude-code` — streaming transcript parser → IR
- `packages/metrics` — deterministic per-session metrics bundle
- `packages/rules` — versioned detectors ("session smells")
- `packages/report-html` — self-contained HTML report renderer
- `apps/cli` — the `damame` command
- `docs/rules` — one documented rationale page per rule
- `fixtures` — scrubbed/synthetic transcripts with golden expected outputs
