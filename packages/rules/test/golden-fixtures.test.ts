import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseTranscriptFile } from "@damame/adapter-claude-code";
import { computeMetrics } from "@damame/metrics";
import { runRules } from "../src/index.js";

/**
 * Golden regression suite over real (sanitized) session fixtures. These catch
 * cross-package drift no unit test sees: adapter changes that shift event ids,
 * metrics changes that alter run boundaries, rule changes that alter findings.
 * Regenerate deliberately with `npx tsx scripts/gen-goldens.ts` and review the
 * diff — goldens change only when a versioned behavior change explains it.
 */
const fixturesRoot = join(import.meta.dirname, "..", "..", "..", "fixtures", "claude-code");

const fixtureNames = existsSync(fixturesRoot)
  ? readdirSync(fixturesRoot).filter((n) => existsSync(join(fixturesRoot, n, "expected.json")))
  : [];

describe("golden fixtures", () => {
  it("fixtures exist", () => {
    expect(fixtureNames.length).toBeGreaterThan(0);
  });

  for (const name of fixtureNames) {
    it(`${name}: findings and facts match the golden`, async () => {
      const dir = join(fixturesRoot, name);
      const golden = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8"));
      const { session } = await parseTranscriptFile(join(dir, "transcript.jsonl"));
      const metrics = computeMetrics(session);
      const findings = runRules(session, metrics);

      expect({
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
      }).toEqual(golden.facts);
      expect(findings).toEqual(golden.findings);
    });
  }
});
