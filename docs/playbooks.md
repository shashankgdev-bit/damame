# Playbooks — curated session knowledge, and how it grows

A **playbook** is damame's unit of curated knowledge about one *kind* of session (a use case): the
mistakes that kind of work usually makes, and the fixes that are known to help. Playbooks live in
[`packages/playbooks/src/playbooks/`](../packages/playbooks/src/playbooks/) — in the open repo, so
their provenance, their evolution, and every claim in them is public and reviewable.

## The honesty contract

Recommendations are **retrieved, never improvised**. At analysis time damame does exactly two things:

1. **Match the playbook** to the session — by the brief's use-case tags, or by a deterministic
   quorum (≥2 of the playbook's signature rules fired). Either path alone is enough; the quorum
   path works with no LLM at all.
2. **Render only evidenced entries** — an entry appears as a recommendation *only if its signature
   rule actually fired in this session*. Everything else in the playbook stays behind a
   "more in this playbook" reference. A session with no evidence gets no recommendations, no
   matter how well the playbook's topic matches. (The same opportunity-honesty rule the skills
   profile follows.)

Entries whose knowledge has no deterministic detector yet are marked `evidence: narrative` and
`status: candidate` — they are documentation, never auto-recommendations, until a detector and
corpus gate exist for them.

## What it takes for an entry to exist (the admission gauntlet)

Every entry must carry, at authoring time:

| Requirement | Enforced by |
|---|---|
| A real transcript it was learned from (named in the playbook's `source`) | review |
| A deterministic signature rule, with positive **and** negative corpus archetypes (recall 1.0, zero false positives, in CI) | `packages/corpus` gate |
| `verified_by` provenance: `corpus` (signature gated), `recurrence` (measured behavior change), or `manual` (curated, pending the others) | schema |
| Plain-language mistake / fix / rationale — readable by someone who has never heard of MCP | review |

After shipping, two feedback streams keep score: the accurate?/applicable? answers on rendered
cards, and **behavioral recurrence** — whether the signature's frequency actually drops in the
user's later sessions after the recommendation surfaced. An entry that users mark inapplicable or
whose signature never budges is a candidate for demotion; the numbers are visible in the rules view.

## Contributing a pattern (the flywheel)

When a session shows a *better* practice than the playbook knows — or a use case damame has no
playbook for — the path in is a **pattern card**: an abstraction, never transcript content.

### Pattern card template

```markdown
## Pattern: <short name>
**Use case:** <kind of session this applies to>
**Mistake it prevents:** <what goes wrong without it, plain language>
**The practice:** <what the user/session actually does, abstracted — no project names,
no file contents, no prompt text>
**Observable signature:** <what a transcript with this mistake/practice looks like in
countable terms — event kinds, counts, thresholds. This becomes the detector spec.>
**Evidence it helps:** <measured effect in the source session — tokens, wall-clock,
compaction count, error rate. Numbers, not impressions.>
**Suggested resources:** <skills / MCP servers / workflow shapes that implement the fix>
```

Submitted as a PR against `packages/playbooks/`. A card is merged only after it passes the same
gauntlet as seed entries: signature detector + corpus archetypes (or explicit `narrative` status),
plain-language review, and provenance recorded in the playbook's `source`. Reviewers may ask the
contributor to run `damame` against their own session and paste the (numbers-only) signature
metrics — never the transcript.

### Why this is safe to run in public

- Cards carry structure and numbers, not content — nothing private can enter the repo.
- The corpus gate makes wrong detectors unmergeable, not merely discouraged.
- Every entry's origin story is in git history; trust is auditable, like everything else here.

## Current playbooks

| id | grounded in | entries (evidenced/narrative) |
|---|---|---|
| `repetitive-task-production` | a real 71-day TerminalBench task-factory transcript | 4 / 2 |

The second playbook is deliberately unwritten: it will be curated from the next real outside
transcript (Codex sessions from an early tester / the first user tests), the same way the first
came from a real one. Playbooks invented from imagination are how trust dies.
