# The session score — how it's computed, and how it's validated

The score is a **summary lens over the findings — never a replacement for them.** Every number here
is recomputable by hand from this page; every penalty links to a finding with line-level evidence;
and the score's validity is enforced mechanically in CI, not asserted.

Current version: **score@1** (shown in the UI and the grading footer; any change to formulas or
bucket membership bumps it, and comparability across versions resets — same discipline as rules).

## The five scored parameters

| parameter | formula |
|---|---|
| **Cost efficiency** | `100 × (1 − wasted_tokens ÷ total_tokens)`, clamped 0–100. `wasted` = sum of measured/modeled token savings across non-infra findings; `total_tokens` = fresh work only — input + output + cache writes, cache **reads excluded** (re-served context is not new work). Purely measured. |
| **Context hygiene** | findings-based (rules: cache-thrash, compaction-burn, eternal-session, oversized-context-reads) |
| **Redundant work** | findings-based (duplicate-tool-call, paste-relay) |
| **Missed capabilities** | findings-based (missed-delegation, repeated-delegation, idle-gap-notifications, post-edit-ritual) |
| **Prompting & recovery** | findings-based (abandoned-work rewinds, edit-fail-loop, bash-error-loop, permission-churn) |

**Findings-based buckets:** start at 100; each finding in the bucket subtracts
`major −25 · moderate −12 · minor −5 · info −0`, plus a magnitude term of up to −15 when the
finding carries measured token savings (`min(15, 100 × saved ÷ session_total)`). Floor 0.

**Overall = round(mean of the five parameters).**

A bucket with no findings scores 100 — worded conservatively in the UI: conservative detectors
found nothing, which is not proof of perfection.

## What never counts

- **Infra findings** (retry-storm, resume-orphaned branches): provider/lifecycle events are
  excluded from every parameter. Your score can never drop because the API had a bad day.
- **Capabilities exercised** (subagents, workflows, skills, plan mode, background tasks, memory
  files, hooks — "n of 7"): shown for recognition, **never averaged into the score.** A simple
  session that needed none of them is not a worse session, and positive credit must never become
  a penalty in disguise.

## How the score is validated (not vibes — gates)

1. **Determinism** — unit tests pin exact expected numbers for known finding mixes; same session
   always produces the same score.
2. **Corpus ordering** — a CI gate over the synthetic ground-truth corpus: every archetype with a
   planted user-waste pattern must score **strictly below** the clean archetype; clean must stay
   ≥ 95; negative look-alikes and infra-only archetypes must stay ≥ 90. Planted waste provably
   lowers the score; innocence provably doesn't.
3. **Transparency** — clicking the score in the UI lists every penalty (rule, severity, points)
   and this document is the single source of the formulas.

## Parameters considered and rejected (and why)

- **Verification discipline** ("did they test before accepting?") — requires content judgment;
  waits for the gated LLM tier.
- **Speed/latency** — dominated by provider infrastructure; unfair by construction.
- **Permission safety** — transcripts record too little (only denials) to score honestly.
- **Prompt quality** — judge territory, not deterministically measurable.

New parameters join only through the same gauntlet: published formula → corpus ordering gate →
`score@N` version bump.
