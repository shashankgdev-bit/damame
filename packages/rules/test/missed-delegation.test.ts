import { describe, expect, it } from "vitest";
import { fixture, type TranscriptBuilder } from "@damame/testkit";
import { parseTranscriptFile } from "@damame/adapter-claude-code";
import { computeMetrics } from "@damame/metrics";
import { missedDelegation } from "../src/detectors/missed-delegation.js";
import type { Finding } from "@damame/ir";

async function run(builderResult: string): Promise<Finding[]> {
  const { session } = await parseTranscriptFile(builderResult);
  const metrics = computeMetrics(session);
  return missedDelegation.detect({
    session,
    metrics,
    env: session.environment,
    config: { ...missedDelegation.defaults },
  });
}

function reads(b: TranscriptBuilder, n: number, offset = 0): TranscriptBuilder {
  for (let i = 0; i < n; i++) b.readOk(`/home/user/project/src/file-${offset + i}.ts`);
  return b;
}

describe("missed-delegation", () => {
  it("fires on 15 consecutive reads in one turn with Explore available", async () => {
    const path = reads(fixture().agentListing(["Explore"]).human("map the codebase"), 15).writeTemp();
    const findings = await run(path);
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.rule.id).toBe("missed-delegation");
    expect(f.confidence.source).toBe("deterministic");
    expect(f.severity).toBe("moderate");
    expect(f.evidence.events).toHaveLength(15);
    expect(f.evidence.metrics?.run_length).toBe(15);
    expect(f.savings?.basis).toBe("modeled");
    // 15 reads × 500 bytes each, at 4 bytes/token
    expect(f.savings?.tokens?.value).toBe(Math.round((15 * 500) / 4));
    expect(f.savings?.method).toContain("output_bytes/4");
    expect(f.recommendation.resource.kind).toBe("subagent");
    expect(f.recommendation.resource.ref).toBe("Explore");
    expect(f.recommendation.resource.available_in_session).toBe(true);
    expect(f.recommendation.example_invocation).toContain("Explore");
    expect(f.dedupe_key).toHaveLength(16);
  });

  it("escalates to major when a compaction falls inside the same turn", async () => {
    const b = fixture().agentListing(["Explore"]).human("map the codebase");
    reads(b, 8);
    b.compactBoundary();
    reads(b, 7, 8);
    const findings = await run(b.writeTemp());
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("major");
  });

  it("recommends general-purpose when Explore is not listed", async () => {
    const path = reads(fixture().agentListing(["general-purpose"]).human("map the codebase"), 15).writeTemp();
    const findings = await run(path);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.recommendation.resource.ref).toBe("general-purpose");
  });

  it("does NOT fire at 14 consecutive reads (just under threshold)", async () => {
    const path = reads(fixture().agentListing(["Explore"]).human("map the codebase"), 14).writeTemp();
    expect(await run(path)).toHaveLength(0);
  });

  it("does NOT fire when no delegable agent was listed in the session env", async () => {
    const path = reads(fixture().human("map the codebase"), 16).writeTemp();
    expect(await run(path)).toHaveLength(0);
  });

  it("does NOT fire when the turn already spawned a subagent (look-alike)", async () => {
    const b = fixture().agentListing(["Explore"]).human("map the codebase");
    reads(b, 15);
    b.tool(
      "Task",
      { subagent_type: "Explore", prompt: "survey the rest" },
      { content: "done", toolUseResult: { agentId: "agent-fixture-1", status: "completed" } },
    );
    expect(await run(b.writeTemp())).toHaveLength(0);
  });

  it("is idempotent: same session → same dedupe keys", async () => {
    const path = reads(fixture().agentListing(["Explore"]).human("map"), 15).writeTemp();
    const [a, b] = [await run(path), await run(path)];
    expect(a.map((f) => f.dedupe_key)).toEqual(b.map((f) => f.dedupe_key));
  });
});
