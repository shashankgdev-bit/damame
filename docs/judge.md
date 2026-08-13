# The auditor — damame's LLM evaluation layer

`damame audit` gives every deterministic finding an independent LLM second
opinion. The design principle: **verification, not generation** — the model
never free-reads a session; it receives one specific claim plus the exact
evidence and is asked to refute it. Every known LLM-judge failure mode has a
countermeasure, and the auditor's own accuracy is measured continuously.

## The protocol (prompt template `audit@1`)

Per finding, the auditor receives: the claim (title, description, savings,
recommendation), the rule's documented definition, and numbered transcript
excerpts around the cited events (±2 events, byte-capped — never the whole
session). It answers the same two questions the human reviewer answers:

- **accurate?** — do the excerpts clearly show the claimed events
- **applicable?** — would the recommendation have fit the situation shown

Framed adversarially: *"try to prove the claim wrong; when uncertain, answer
false."* An unsupported claim must not pass.

## Countermeasures

| Failure mode | Countermeasure |
|---|---|
| Hallucinated justification | **Quote gate**: verdicts must quote verbatim spans; quotes are string-matched against the excerpts by code, and any run with a non-matching quote is discarded automatically |
| Run-to-run flip-flopping | 3 runs per finding; unanimous → high confidence; 2-1 → low; otherwise **abstain** ("uncertain" is a recorded answer, never a guess) |
| Sycophancy toward the tool | Refute-framing with a false-default |
| Cheap-model weakness on hard cases | Splits and abstentions escalate once to a stronger model (default haiku → sonnet) |
| "Who audits the auditor?" | **Honeypots**: each batch silently includes findings wrong by construction (evidence swapped to unrelated events, or numbers inflated 10×). The refutation rate on honeypots is a live, label-free accuracy score. Catch rate < 80% (≥5 honeypots) → the UI shows a degraded-trust banner |
| Unvalidated-judge syndrome | Wherever the human answered the same finding, per-rule agreement is tracked and shown; every human answer also grades the auditor |
| Silent methodology drift | Verdicts record `{model, prompt_version, runs, votes}`; changing model or prompt starts a fresh calibration series |

## Boundaries

- The auditor **cannot delete, downgrade, or edit findings** — it is an
  opinion rendered beside the evidence, stored separately from human answers.
- Opt-in, with a scope/cost preview before any run. Only evidence excerpts are
  sent; verdicts are stored locally in `~/.damame/audits.jsonl`.
- Backends: Claude Code headless (`claude -p`, uses your existing auth;
  `--no-session-persistence` keeps audit runs out of your transcript history)
  or the Anthropic API (`--backend api` with `ANTHROPIC_API_KEY`).

## The gate for generation

Judge-*generated* findings (clarification churn, counterfactual prompts) stay
disabled until the auditor demonstrates, on this user's data: honeypot catch
rate ≥ 0.9 and human agreement ≥ 0.8 on *accurate?*. Checking is easier than
discovering; the judge earns the harder job by proving the easier one.
