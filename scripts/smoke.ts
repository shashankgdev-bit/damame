/**
 * Dev smoke script: parse a real transcript, print headline facts.
 * Usage: npx tsx scripts/smoke.ts <transcript.jsonl>
 */
import { parseSessionWithChildren } from "@damame/adapter-claude-code";
import { computeMetrics } from "@damame/metrics";
import { SessionSchema } from "@damame/ir";

const path = process.argv[2];
if (!path) {
  console.error("usage: tsx scripts/smoke.ts <transcript.jsonl> [--validate]");
  process.exit(1);
}

const t0 = performance.now();
const analyzed = await parseSessionWithChildren(path);
const parseMs = Math.round(performance.now() - t0);
const { session, children } = analyzed;

if (process.argv.includes("--validate")) {
  const result = SessionSchema.safeParse(session);
  console.log("schema valid:", result.success);
  if (!result.success) console.log(result.error.issues.slice(0, 5));
}

const m = computeMetrics(session);
const mem = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);

console.log(
  JSON.stringify(
    {
      parse_ms: parseMs,
      heap_mb: mem,
      session: {
        id: session.id,
        title: session.title,
        versions: [session.source.tool_version_min, session.source.tool_version_max],
        events: session.events.length,
        turns: session.turns.length,
        human_turns: m.totals.human_turn_count,
        children: children.length,
        chain_roots: session.chain_root_event_ids?.length,
        unknown_line_types: session.unknown_line_types ?? {},
        malformed_lines: session.metadata?.malformed_lines,
      },
      usage_totals: session.usage_totals,
      metrics: {
        total_tokens: m.totals.total_tokens,
        tool_calls: m.totals.tool_call_count,
        tool_errors: m.totals.tool_error_count,
        per_model: Object.fromEntries(
          Object.entries(m.per_model).map(([k, v]) => [k, { msgs: v.message_count, out: v.usage.output_tokens }]),
        ),
        top_tools: Object.entries(m.per_tool)
          .sort((a, b) => b[1].calls - a[1].calls)
          .slice(0, 8)
          .map(([name, s]) => `${name}:${s.calls}(${s.errors}err)`),
        duplicates: m.duplicate_tool_calls.length,
        error_runs: m.error_runs.map((r) => `${r.signature}x${r.length}@${r.target ?? "?"}`).slice(0, 10),
        api_error_runs: m.api_error_runs.length,
        compactions: m.compactions.length,
        denials: m.permission_denials.length,
        interruptions: m.interruption_count,
        abandoned: m.abandoned_branches,
        cache_misses: m.cache_misses.length,
        subagents: m.subagent_runs.length,
        longest_readonly_runs: m.read_only_runs
          .map((r) => r.length)
          .sort((a, b) => b - a)
          .slice(0, 5),
        large_full_reads: m.large_full_reads.length,
        env: {
          skills: session.environment?.skills.length,
          agents: session.environment?.agents.length,
          deferred_tools: session.environment?.deferred_tools.length,
          observed_tools: session.environment?.core_tools_observed.length,
        },
      },
    },
    null,
    2,
  ),
);
