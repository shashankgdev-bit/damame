import { describe, expect, it } from "vitest";
import { fixture, type TranscriptBuilder } from "@damame/testkit";
import { parseTranscriptFile } from "@damame/adapter-claude-code";
import { computeMetrics } from "@damame/metrics";
import { repeatedDelegation } from "../src/detectors/repeated-delegation.js";
import type { Finding } from "@damame/ir";

async function run(builderResult: string): Promise<Finding[]> {
  const { session } = await parseTranscriptFile(builderResult);
  const metrics = computeMetrics(session);
  return repeatedDelegation.detect({
    session,
    metrics,
    env: session.environment,
    config: { ...repeatedDelegation.defaults },
  });
}

function spawns(b: TranscriptBuilder, descriptions: string[], offset = 0): TranscriptBuilder {
  descriptions.forEach((description, i) => {
    b.tool(
      "Task",
      { subagent_type: "general-purpose", description, prompt: `carry out: ${description}` },
      { content: "done", toolUseResult: { agentId: `agent-fixture-${offset + i}`, status: "completed" } },
    );
  });
  return b;
}

describe("repeated-delegation", () => {
  it("fires at 5 spawns of the same task family (digits normalized)", async () => {
    const b = fixture().human("run the probes");
    spawns(b, [
      "Cold-Opus probe 1",
      "Cold-Opus probe 2",
      "Cold-Opus  probe 3", // extra whitespace collapses
      "cold-opus PROBE 4", // case-insensitive
      "Cold-Opus probe 12 with extra tail words", // tail beyond 3 tokens ignored
    ]);
    const findings = await run(b.writeTemp());
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.rule.id).toBe("repeated-delegation");
    expect(f.category).toBe("missed-resource");
    expect(f.confidence.source).toBe("deterministic");
    expect(f.severity).toBe("moderate");
    expect(f.evidence.events).toHaveLength(5);
    expect(f.evidence.metrics?.occurrences).toBe(5);
    expect(f.evidence.metrics?.family).toBe("cold-opus probe #");
    expect(f.evidence.metrics?.sample_descriptions).toHaveLength(3);
    expect(f.savings).toBeUndefined();
    expect(f.recommendation.resource.kind).toBe("prompting_pattern");
    expect(f.recommendation.resource.ref).toBe("save-as-named-workflow");
    expect(f.dedupe_key).toHaveLength(16);
  });

  it("does NOT fire at 4 spawns of the same family (just under threshold)", async () => {
    const b = fixture().human("run the probes");
    spawns(b, ["Cold-Opus probe 1", "Cold-Opus probe 2", "Cold-Opus probe 3", "Cold-Opus probe 4"]);
    expect(await run(b.writeTemp())).toHaveLength(0);
  });

  it("escalates to major at 3x the threshold and caps evidence at 8 events", async () => {
    const b = fixture().human("run all the probes");
    spawns(
      b,
      Array.from({ length: 15 }, (_, i) => `Cold-Opus probe ${i + 1}`),
    );
    const findings = await run(b.writeTemp());
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.severity).toBe("major");
    expect(f.evidence.metrics?.occurrences).toBe(15);
    expect(f.evidence.events).toHaveLength(8);
  });

  it("does NOT fire on 6 spawns with unrelated descriptions (look-alike)", async () => {
    const b = fixture().human("do several different things");
    spawns(b, [
      "Review auth module",
      "Summarize test failures",
      "Refactor billing code",
      "Investigate flaky deploy",
      "Draft release notes",
      "Audit dependency tree",
    ]);
    expect(await run(b.writeTemp())).toHaveLength(0);
  });

  it("skips spawns whose call has no description input", async () => {
    const b = fixture().human("run the probes");
    for (let i = 0; i < 6; i++) {
      b.tool(
        "Task",
        { subagent_type: "general-purpose", prompt: "probe the target" },
        { content: "done", toolUseResult: { agentId: `agent-nodesc-${i}`, status: "completed" } },
      );
    }
    expect(await run(b.writeTemp())).toHaveLength(0);
  });

  it("is idempotent: same session → same dedupe keys", async () => {
    const b = fixture().human("run the probes");
    spawns(
      b,
      Array.from({ length: 6 }, (_, i) => `Cold-Opus probe ${i + 1}`),
    );
    const path = b.writeTemp();
    const [a, c] = [await run(path), await run(path)];
    expect(a.map((f) => f.dedupe_key)).toEqual(c.map((f) => f.dedupe_key));
  });
});
