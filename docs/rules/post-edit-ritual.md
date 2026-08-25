# post-edit-ritual

**The same command habitually follows file edits — a reflex that could be a hook.**

## What it detects

Pairs of *file edit → first Bash command in the same turn*, with commands reduced to a normalized
family (leading `cd <path>`/`export` prefixes stripped, whitespace collapsed, digit runs masked,
first three tokens kept) so the same ritual run in different folders counts as one habit. A family
fires at **10+** post-edit occurrences.

## Why 10 — measured, not guessed

Calibrated on three real sessions from unrelated domains before shipping. In all three, habitual
check families (a task oracle, `uv run python` smoke checks, `npm run typecheck`) sat at 10–48
post-edit occurrences while the noise tail of incidental commands stayed at ≤6. The threshold sits
in that measured gap. Pairing is deliberately conservative: only the first Bash after an edit, one
pair per edit, live branches only.

## What it claims — and refuses to claim

Severity is always **minor** and **no savings are claimed**: the command runs either way. What a
hook adds is *guarantee* (a reflex in settings cannot be forgotten under context pressure the way a
prose instruction can) and the removal of ask-and-run turns. Who initiated each run — the human
asking or Claude deciding — is deliberately ignored: the regularity itself is the signal, and the
recommendation is identical.

## Recommendation

`config: hooks-post-edit` — the registry recipe with the exact `PostToolUse` settings snippet
(matcher `Write|Edit`) to adapt to the detected command.

## Corpus coverage

Positive archetype: 11–14 edit→same-ritual pairs across changing folders (must fire). Negative:
12 edits each followed by a genuinely different command (must stay silent), plus the standard
just-under-threshold unit test at 9.
