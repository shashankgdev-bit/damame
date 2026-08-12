/**
 * Regenerates expected.json for every fixture under fixtures/claude-code/.
 * Run after intentionally changing a rule or the adapter; the diff IS the
 * review surface — an unexplained golden change is a regression, not an update.
 *
 * Usage: npx tsx scripts/gen-goldens.ts
 */
import { readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseTranscriptFile } from "@damame/adapter-claude-code";
import { computeMetrics } from "@damame/metrics";
import { runRules } from "@damame/rules";

const fixturesRoot = join(import.meta.dirname, "..", "fixtures", "claude-code");

for (const name of readdirSync(fixturesRoot)) {
  const transcript = join(fixturesRoot, name, "transcript.jsonl");
  if (!existsSync(transcript)) continue;
  const { session } = await parseTranscriptFile(transcript);
  const metrics = computeMetrics(session);
  const findings = runRules(session, metrics);
  const golden = {
    facts: {
      usage_totals: session.usage_totals,
      event_count: session.events.length,
      turn_count: session.turns.length,
      human_turn_count: metrics.totals.human_turn_count,
      tool_call_count: metrics.totals.tool_call_count,
      tool_error_count: metrics.totals.tool_error_count,
      compactions: metrics.compactions.length,
      cache_misses: metrics.cache_misses.length,
      abandoned_branches: metrics.abandoned_branches.length,
      chain_roots: session.chain_root_event_ids?.length ?? 0,
      unknown_line_types: session.unknown_line_types ?? {},
    },
    findings,
  };
  writeFileSync(join(fixturesRoot, name, "expected.json"), JSON.stringify(golden, null, 2) + "\n");
  console.log(`${name}: ${findings.length} findings, ${session.events.length} events`);
}
