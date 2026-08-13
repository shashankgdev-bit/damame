# damame

**A profiler for your AI coding sessions.**

damame reads the session transcripts Claude Code already saves on your machine
and shows you, with receipts, how each session went: wasted retries, cache
thrash, abandoned work, manual grinding an available subagent would have
handled — plus what each cost and the specific fix.

```sh
npx damame
```

That opens a local dashboard (127.0.0.1 only — nothing ever leaves your
machine): your sessions, each drawn as a waveform of its turns, findings with
clickable evidence down to the transcript line, and one-click feedback that
builds a measured per-rule precision score over time.

For scripting: `damame list`, `damame analyze --latest [--json|--html out.html]`,
`damame rules`, `damame feedback <key> helpful|wrong`.

## Principles

- **Local-first, zero telemetry.** Transcripts are read in place; nothing uploads.
- **Deterministic.** Same session in, same findings out. No LLM judgment in v1.
- **Findings, not scores.** Every claim cites transcript evidence; every savings
  number is labeled *measured* (counted from records) or *modeled* (estimate,
  with the assumption stated). No composite grade, no leaderboards.
- **Honest baselines.** "You had X and didn't use it" is checked against what
  was available *in that session's own transcript*, not your current config.

Full source, rule documentation, and methodology: https://github.com/shashankgdev-bit/damame
