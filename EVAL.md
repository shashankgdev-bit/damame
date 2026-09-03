# Evaluation — how damame knows its detectors are right

damame's detectors are deterministic, so "correct" cannot mean "repeatable" — a bug
produces the same wrong answer every time. Correctness is established against **ground
truth we manufacture**, because on a real session there is no answer key: nobody knows the
objectively correct findings for a 4-billion-token transcript.

## The method

A seeded generator (`@damame/corpus`) builds complete Claude Code transcripts with known
stories:

- **Planted defects.** 16 archetypes each construct a session containing exactly one waste
  pattern — an edit-fail loop, a cache-thrash burst, a compaction that forces re-reads —
  and an answer sheet: *this rule must fire; every other rule must stay silent.*
- **Near-miss negatives.** 11 archetypes are innocent look-alikes built **one unit under a
  threshold** — 2 consecutive edit failures where 3 fire, 5 pastes where 6 fire, a single
  compaction where 2 are needed. These test the decision *boundary*, where false positives
  are actually born, not the easy cases.
- **The real pipeline.** Every generated session is run through the production parser →
  metrics → detectors — not a shortcut path — and the output is diffed against the answer
  sheet in both directions (a missed plant *and* a forbidden-rule firing both fail).
- **Reproducible by construction.** A failure prints `missed: <rule> in <archetype>#<seed>`,
  and that seed regenerates the byte-identical failing session (mulberry32 PRNG).

Detectors that legitimately co-occur (an oversized read that is also a duplicate; an
eternal session that also burns compactions) are exempted per-archetype via explicit
forbidden-list carve-outs, so the zero-false-positive gate is never loosened globally.

## Current result

```
$ damame eval --per 20 --seed 7
corpus: 540 sessions (20/archetype, seed 7)
```

| rules | recall | precision |
|---|---|---|
| all 16 | **1.00** | **1.00** |

540 generated sessions (20 × 27 archetypes), zero missed plants, zero false positives.
The gate runs in CI at 4 sessions/archetype on every build — one miss fails the build.
Building this gate immediately caught two real detector-quality bugs (double-reporting of
failed repeats across two detectors; noise on tiny diagnostic re-reads) before any user
saw them.

## Run it

```
damame eval                 # 10/archetype, seed 42 (CI default cadence)
damame eval --per 20 --seed 7
```

## The rest of the trust architecture

The corpus grades the deterministic detectors. Every *other* layer is graded by a
different mechanism, so no component grades its own homework — the LLM auditor by
honeypot findings corrupted by construction (adversarial testing of the judge itself), the
AI-written brief by mechanical citation deletion, the score by CI ordering gates, and the
whole tool by user feedback plus behavioral recurrence. See [README](README.md) ·
[docs/judge.md](docs/judge.md) · [docs/score.md](docs/score.md).

**Measured no-ships are results too:** rules that were designed, measured against real
transcripts, and deliberately not shipped are recorded in [docs/parked.md](docs/parked.md)
with their revival triggers.
