# damame-py

Session-over-session analytics for [damame](https://github.com/shashankgdev-bit/damame) exports —
your AI coding-session data as pandas DataFrames.

[damame](https://www.npmjs.com/package/damame) analyzes individual Claude Code sessions locally
(findings, validated scores, recommendations). **damame-py answers the questions that live *across*
sessions**: is my score trending up? which inefficiency patterns recur? did the pattern actually
fade after I adopted a fix? how is the tool's own precision holding up under my feedback?

## Usage

```sh
npx damame export --out export.json   # the TS CLI dumps all sessions (stable schema, local only)
pip install damame-py
```

```python
import damame_py as dm

data = dm.load("export.json")
data.sessions              # one row per session: score, parameters, tokens, dates
data.findings              # one row per finding, joined with session context
print(dm.summary(data))    # the 30-second read

data.score_trend()         # overall + per-parameter scores over time
data.waste_by_rule()       # measured wasted tokens per rule, ranked
data.rule_frequency()      # findings per rule per session — habits and their fading
data.cache_efficiency()    # cache-served share of each session's context
data.precision_over_time() # the tool's own report card from your accurate?/applicable? answers
```

Everything is plain DataFrames — plot, join, resample as you like. The export schema is versioned
(`export_schema: 1`); this package refuses newer schemas rather than misreading them.

## Privacy

The export contains **analysis outputs only** — scores, counts, rule ids, timestamps — never
transcript content. It is produced locally by damame and read locally by this package; nothing
is transmitted anywhere.
