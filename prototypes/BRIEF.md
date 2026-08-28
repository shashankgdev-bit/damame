# damame frontend restructure — design brief

Distilled from the design discussions of 2026-08-26 → 28. This brief is the contract for
every prototype variant: **information architecture is fixed; visual identity is the variable.**

## The one-sentence product

The engine proves, the agent fixes, the coach upgrades. The page's job: show a user what
happened, what damame can fix *for* them, and the few things worth adopting — in the
currencies they actually care about (output quality, time, usage limits) — with tokens
demoted to the proof line.

## Fixed information architecture (every variant implements ALL zones, in this order)

### Header
Session identity (project name, date span), the **score** (big, 0–100) with its five
parameters available (compact — bars, dial, or table), and a one-line story of what the
session was.

### Zone A — "damame can fix N things" (Tier 1, the fix surface)
The machine-applicable fixes, presented as a *batch*: each item shows what + destination
(hook in settings.json / CLAUDE.md line / config), one line each. ONE primary action for
the whole zone: "Review the diff" (mock action in prototypes). Sub-note: after applying,
results are measured in later sessions (the fix ledger). This zone should feel like it
*empties* — these items are leaving the user's attention, not homework.

### Zone B — "Worth adopting" (Tier 2, the coach — THE VOICE OF THE PAGE)
Max 3 cards. Each card:
- Headline written in its **impact currency** (quality / time / limits) — a plain human
  sentence, never token counts in the headline.
- An impact tag chip: `quality` | `time` | `limits`.
- Grouped evidence: one card can carry votes from multiple detectors ("3 signals point
  here"), with the token/count evidence as the small proof line.
- Provenance chip: `verified` / `candidate` + source.
- Actions: primary adopt-style action, quiet "not relevant" dismiss.
This zone gets the visual priority of the page. One of the three cards is the
**freeze-your-own-pattern** card (see data) — treat it as the flagship.

### Zone C — Receipts (the ledger)
All findings as compact receipt rows: severity mark, currency-tagged one-line headline,
proof line (tokens/counts, small, muted), evidence affordance ("show me where" — mock).
Collapsible or de-emphasized relative to Zones A/B. Include a link/affordance to the score
breakdown. Honest empty-state language if a category is clean ("nothing caught — not proof
of perfection").

### Zone D — "Not your inefficiency"
Infra findings in their own visually separate room: provider retries, resume-orphaned
branches. Explicit copy that these never count against the user. This separation is a
trust feature — make it *visibly* a different room.

### Footer
Capabilities exercised (n/7, recognition only), grading versions line (damame 0.6.0 ·
score@1 · adapter/rules versions), privacy line ("local-only — nothing leaves your
machine").

## Rules that always apply (from the design discussions)

1. **Nobody reads paragraphs.** Progressive disclosure: one-line card → details on demand.
   Lead with the fix itself, not the explanation.
2. **Tokens are proof, not headline.** Currency-first sentences; numbers in the proof line.
3. **One recommendation, once.** Grouped by root cause; never the same advice as three cards.
4. **Honesty furniture**: provenance chips, measured-vs-modeled labels where savings show,
   infra separated, dismiss affordances. These are product identity, not decoration.
5. **Accessibility floor**: skip link, focus-visible, reduced-motion respected, color never
   the only signal for severity, tabular numerals for data.
6. **Self-contained**: single HTML file, zero external requests (system font stacks only),
   works from file://. Data embedded inline from data.json.
7. NO Anthropic/Claude logos or trademarks. damame's own identity only.

## What varies per variant

Palette, typography, layout geometry, density, motion, metaphor. Each variant has an
assigned style direction (see the workflow prompts). Same data, same zones, same rules —
five different souls. Deliberate, opinionated, non-generic design per direction.
