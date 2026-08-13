# Prompt Engineering

Writing requests the AI can execute in one pass.

A precise request costs a minute to write; a vague one costs a correction
loop to repair. The skill is stating the goal, the constraints, and the
definition of done before the agent starts, so the first attempt is usually
the right one. Most "the AI got it wrong" sessions trace back to a request
that left the real decision unstated.

## How damame measures it

Opportunity-aware, like every skill in the profile: rate = uses /
(uses + misses), computed only from your own sessions.

- **Misses:** none in v1 — no rule currently produces missed opportunities
  for this skill, so the miss side of the rate is empty.
- **Uses:** one use per technique per session where `structured-questions`
  is observed.

v1 measurement is deliberately light: it reads only shallow signals such as
interruptions and clarification requests. Deep prompt-quality measurement
arrives with the judge layer, and anything the judge produces stays labeled
as interpretation — it is never presented as a deterministic finding.

## Techniques

### Letting the AI ask structured questions

When the AI asks a structured question (multiple choice), answering it is far
cheaper than a wrong guess. Encouraging clarify-then-execute beats a long
correction loop afterward. In Claude Code this surfaces as the
AskUserQuestion tool; if your request contains a genuinely open decision,
say so and invite the question instead of forcing a guess. A ten-second
answer to a well-posed question routinely saves a multi-turn redo.

## What this never means

- Zero opportunities reads as "not needed recently" — a neutral state,
  never a deficit. damame does not nag about skills the work didn't call
  for.
- The rate measures observed practice in your transcripts, not ability —
  and on v1's light signals it is weak evidence by design.
- Numbers are never compared across people. Your profile is measured only
  against opportunities detected in your own sessions.
