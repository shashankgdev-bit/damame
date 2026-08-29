# Parked detectors — measured no-ships

Rules that were designed, measured against real transcripts, and deliberately NOT shipped.
A documented no-ship is a result: the measurement protocol (build the signature → run it on
real sessions → ship only if a signal/noise gap exists) is the same one that calibrated
post-edit-ritual's threshold — it just answered "no" here. Each entry records the trigger
that would revive it.

## repeated-prompt-template (measured 2026-08-29 — no-ship)

**The idea:** detect the user re-typing similar instructions (same shape, different
details) across a session — the trigger for recommending "freeze this into a skill/slash
command."

**The measurement:** paste-relay's shape normalization (digits masked, whitespace
collapsed, 60-char signature) applied to all human-entered prompts ≥80 bytes across the
three real sessions available (723 prompts total).

**The result, and why it's a no-ship:**

- The only large families found (44, 37, 28, 24, 17 members) were **pastes** — CI logs and
  grader verdicts — which paste-relay already owns. A second rule firing on them would
  double-bill one crime.
- The next-largest family was a **slash command** — a pattern the user had already frozen;
  recommending freezing it would be advice about a solved problem.
- Genuinely *typed* repeated instructions formed **zero families of 3+** in any session —
  typed phrasing varies too much for shape matching, and (per the transcript's own
  evidence: 89 slash-command uses in one session) users who repeat instructions tend to
  freeze them on their own.
- A "typed templates only" variant is not buildable honestly: the transcript cannot
  reliably distinguish typed from pasted input — "entered by hand" is the only proven claim.

**What carries the freeze recommendation instead:** repeated-delegation and
post-edit-ritual (shipped triggers), and the user-initiated mining path ("make a skill
from this session") planned for the fix-agent phase.

**Revival trigger:** transcripts from other users showing typed-instruction families that
shape-matching actually catches — re-run the measurement script before writing any rule.

## skills-matching watcher (measured earlier — no-ship)

**The idea:** flag sessions whose domain matched an installed skill that never fired.

**The result:** in every real session with domain churn, the relevant skill HAD been
invoked (auto-invocation working). Flagging installed-but-unused skills would have
produced only noise; the real gap is *not-installed* skills, which is a registry/
recommendation problem, not a detector.

**Revival trigger:** a real transcript showing an installed skill sleeping through a
session its description clearly matches.
