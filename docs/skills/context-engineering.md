# Context Engineering

Keeping the context window and prompt cache healthy.

Everything an agent reads rides along in every later request, and a churned
prompt cache repays nothing. Sessions that stay lean run longer before
compaction, cost less per turn, and keep the model's attention on the work
instead of on stale file dumps.

## How damame measures it

Opportunity-aware: rate = uses / (uses + misses).

- **Misses:** findings from four rules count — `cache-thrash`,
  `compaction-burn`, `oversized-context-reads`, and `duplicate-tool-call`.
  Each is a deterministic finding that context was spent where it didn't
  need to be.
- **Uses:** one use per technique per session for `targeted-reads`,
  `search-before-read`, and `prompt-cache-stability`.

## Techniques

### Targeted file reads

Reading a whole large file pushes every byte into the context window, where
every later request re-carries it. Reading the relevant region
(offset/limit) or grepping first keeps context lean. When you know what
you're after, say so — "read the parse function, not the whole file" steers
the agent toward a bounded read.

### Search before reading

Grep and Glob locate the right place cheaply; Read then opens only what
matters. Search-first is the difference between carrying a codebase in
context and carrying an answer. Delegating a broad search to a subagent
compounds the saving: even the search hits stay out of the main window.

### Stable prompt cache

The prompt cache only pays off when earlier context stays byte-identical
between requests. Avoid toggling tools or MCP servers mid-session —
configure once at the start. If you know a session will need an MCP server,
enable it before the first message rather than midway through.

## What this never means

- No findings and no uses reads as "not needed recently" — short sessions
  rarely stress the context window, and that's fine.
- The rate measures observed practice, not understanding of how context
  works.
- No cross-person comparison.
