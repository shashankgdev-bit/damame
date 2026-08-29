# The freeze feature — design & evaluation plan

> "You've written this procedure N times — freeze it." damame detects repetition in the
> user's own transcript, recommends freezing it at the right rung of the automation ladder,
> and (in the fix-agent phase) drafts the frozen artifact from the user's own instances.
> This plan fixes the decision procedure and the evaluation for every stage. House rule
> throughout: no stage grades itself.

## The automation ladder

| Rung | What's frozen | Evidence shape that selects it |
|---|---|---|
| Hook | one trigger → one action | same normalized command following edits (post-edit-ritual) |
| Slash command | a prompt template | same request re-typed, trivial execution |
| Skill | a procedure (knowledge; execution varies) | same task family, instances **varying but related** |
| Workflow | a script (fixed steps over changing inputs) | same task family, instances **near-identical** |

## Stage 1 — trigger: should we suggest freezing at all?

Deterministic detectors only: repeated-delegation, post-edit-ritual (future signatures enter
via the measure-first protocol; see docs/parked.md for repeated-prompt-template's no-ship).
**Eval:** the existing corpus gate — plants must fire, near-miss negatives must not.

## Stage 2 — rung choice: which form?

Deterministic decision table above. The one open quantity — "near-identical vs varying"
for workflow-vs-skill — is a measurable text-similarity threshold across the family's
instances, to be **calibrated on real families first** (first datum: the cold-opus-probe
family's internal similarity), placed in a measured gap, never guessed.

**Eval:** per-rung corpus archetypes — a planted ritual must yield "hook," planted
near-identical spawns must yield "workflow," planted varying-but-related spawns must yield
"skill" — recommendation-level recall 1.00 and zero cross-rung confusions, in CI.

## Stage 3 — the draft (fix-agent phase; LLM writes SKILL.md from the instances)

Two opposite failure modes, two mechanical gates, judgment reserved for the human:

- **Invention** (content the user never wrote) → **traceability gate**: every section of
  the draft must reference the instance it derives from; unreferenced content is flagged
  before the diff is shown. (Citation-gate family.)
- **Omission** (a rule from version 3 silently dropped) → **canary check**: mechanically
  extract each instance's most distinctive lines; every canary must appear (verbatim or by
  reference) in the draft. Invention bounded by citations, omission by canaries — both are
  dumb string checks.
- **Judgment** (is it good?) → the human approves the diff. Always human-gated; the
  drafter proposes, never writes directly.
- The **description line** (the advertisement that drives future auto-invocation) is the
  highest-leverage line in the draft; its quality is graded behaviorally in Stage 4.

## Stage 4 — outcome: the fully deterministic funnel

Every step of a freeze's afterlife is visible in later transcripts:

1. **Adopted?** — the skill/workflow appears in later sessions' environment listings.
2. **Invoked?** — invoked-skills / spawn records show it in use.
3. **Worked?** — the trigger family goes silent: recurrence machinery auto-retires the
   card ("your skill is working").
4. **Right?** — applicable?/dismiss feedback builds per-card precision, like every rule.

Funnel gaps are diagnoses, not dead ends: **adopted-but-never-invoked = bad advertisement
line** → its own follow-up recommendation ("sharpen the description"), measured the same
way on the next cycle.

## Build order

1. Rung decision table + similarity measurement on real families (with Stage 2 archetypes).
2. The card UI: instances viewer ("show my N versions"), rung recommendation, the one-prompt
   fix (v1 needs no drafting agent — the fix is a copy-paste prompt).
3. Fix-agent phase: the drafter + traceability gate + canary check + human diff approval.
4. Stage 4 wiring: funnel states surfaced on the card; retirement via recurrence (exists).
