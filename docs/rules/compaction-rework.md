# compaction-rework

**Category:** context-hygiene · **Since:** 0.1.0 · **Confidence:** deterministic

## What it detects

Re-purchasing forced by a context compaction: reads *after* a compaction whose input
fingerprint matches a successful read *before* it — and whose result came back
**byte-identical** (matching output hashes). Nothing about the content changed; the only
thing that changed was the summary dropping it. Fires per qualifying compaction when at
least `min_rereads` (3) identical re-reads total `min_reread_bytes` (20KB) or more;
`moderate` severity at 100KB or 10 re-reads.

This rule is the measured receipt for the claim the other hygiene rules can only state as
mechanism: *compaction loses fidelity*. Here the loss has a byte count and line-level
evidence.

## Evidence it keys on

- The compaction event itself (trigger, pre/post token counts).
- Up to 6 of the re-read tool calls; `evidence.metrics` records `reread_count` and
  `reread_bytes` in full.
- Pairing requires: same `input_hash` (identical read arguments), both reads successful,
  identical `output_hash` on both results, a compaction strictly between them. Each
  re-read is attributed to the latest compaction before it (the proximate cause).

## Why output identity is the guard

An earlier design excluded pairs with any state-changing tool attempt between them —
mirroring duplicate-tool-call — and it measured **zero recall** on real sessions: real
work runs Bash constantly, so every long-distance pair was vetoed. Output identity is
strictly stronger and needs no timing heuristics: if an edit, a Bash side effect, or the
user had changed the content, the hashes would differ and the pair excludes itself. The
claim "this re-read added nothing new" is proven, not inferred.

## Ownership (one crime, one bill)

Cross-compaction repeats are excluded from **duplicate-tool-call** (its duplicate groups
are computed per compaction *era*). The cause of these repeats is the compaction, so this
rule owns them; billing them as redundant work too would double-count the same tokens.
Enforced by the corpus: the compaction-rework archetype forbids duplicate-tool-call.

## Savings method (modeled — a floor)

`reread_bytes / 4` bytes-per-token, with identity proven by hashes. Explicitly a **floor,
not an estimate**: a post-compaction re-read with *different* arguments (an offset/limit
slice of a file previously read whole) has a different input fingerprint and is invisible
to this rule. The undercount is the honest direction to be wrong in.

## Thresholds — measured, not guessed

Calibrated on the real sessions available (28 live compactions across two multi-week
transcripts): the noise tail was 1–2 identical re-reads totaling ≤19KB per compaction;
the one genuine incident was 32 re-reads / 62KB after a single compaction. `min_rereads: 3`
and `min_reread_bytes: 20_000` sit in the measured gap on both axes.

## How to fix it

The re-purchases are a symptom of one session carrying too much. Smaller per-task sessions
briefed by a notes file rarely compact at all — and durable file knowledge survives in the
files themselves instead of a summary. See the `session-per-task-bootstrap` recipe.

## Known non-firing cases (tested)

- Re-reads whose content **changed** across the compaction (different output hashes) —
  re-reading changed content is correct behavior (corpus: `compaction-refresh-changed`).
- Identical re-reads with **no compaction** between them — that is duplicate-tool-call's
  crime, not this rule's (unit-tested for both directions of the ownership split).
- 1–2 small identical re-reads after a compaction — under the calibrated floors; a brief
  re-orientation is normal post-compaction behavior, not a pattern.
