# paste-relay

**Category:** missed-resource · **Since:** 0.1.0 · **Confidence:** deterministic

## What it detects

The human repeatedly pasting large, structurally-similar blocks into the chat — a manual data-ferrying loop. Every human `user_message` of at least `min_paste_bytes` (default 600) is assigned a normalized shape signature: the text is lowercased, whitespace is collapsed, every digit run becomes `#`, everything outside `[a-z0-9#]` is stripped, and the result is truncated to its first 48 characters. Normalization runs before truncation so varying number widths (`7/10` vs `10/10`) cannot shift the window and split one template into many groups.

A signature group fires when it contains at least `min_occurrences` pastes (default 6) whose summed size is at least `min_total_bytes` (default 15,000). One finding is emitted per qualifying group.

Severity is **moderate**, escalating to **major** when the group's occurrence count reaches `min_occurrences × major_occurrence_multiple` (default 3×, i.e. 18 pastes at default thresholds).

## Evidence it keys on

- `user_message` events with `origin === "human"`; meta messages (`is_meta`) and events on abandoned branches are skipped.
- Text length (UTF-16 code units, exact for ASCII-dominated pastes) as the byte measure for both the per-paste floor and the group total.
- The normalized 48-character prefix signature described above; pastes whose signature normalizes to nothing (pure punctuation or whitespace) are excluded rather than lumped into one accidental group.
- Up to 8 of the group's `user_message` events are cited as evidence; `evidence.metrics` carries `occurrences`, `total_bytes`, and the `signature`.

## Savings method (measured|modeled)

None — the finding deliberately carries no savings block. The dominant cost of a paste relay is human time spent hand-ferrying data, which cannot be measured defensibly from the transcript, and the per-paste context re-billing cannot be attributed without guessing what an automated alternative would have carried instead. The cost is described in the finding, not quantified.

## How to fix it

Automate the ingestion path instead of hand-carrying each block:

- Drop the data into a watched file (or folder) inside the project and ask Claude to read it — one `Read` replaces the whole relay.
- Let Claude reach the source directly: a browser MCP connection, a file drop, or a small script that fetches the data.
- If the blocks arrive over time, append them to a single file and have Claude re-read it on demand rather than pasting each increment.

Each manual paste also enters the context window and is re-billed as fresh input by every subsequent request, so automating ingestion helps token cost as well as human time.

## Known non-firing cases (tested)

- 5 structurally-similar large pastes — one under `min_occurrences` — even when their summed bytes exceed `min_total_bytes`.
- 6 similar pastes whose summed bytes stay under `min_total_bytes`.
- Large pastes with no shared shape (six unrelated dumps: stack trace, email thread, config dump, …) — each forms its own one-member group.
- Repeated small messages under `min_paste_bytes`, regardless of how similar or numerous.
- Pastes whose numbers differ in digit width still group together (digit runs normalize to `#`) — the rule fires; the non-firing risk of window shift is designed out.
