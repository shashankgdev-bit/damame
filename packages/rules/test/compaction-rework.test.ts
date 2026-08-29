import { describe, expect, it } from "vitest";
import { fixture } from "@damame/testkit";
import { parseTranscriptFile } from "@damame/adapter-claude-code";
import { computeMetrics } from "@damame/metrics";
import { compactionRework } from "../src/detectors/compaction-rework.js";
import { duplicateToolCall } from "../src/detectors/duplicate-tool-call.js";
import type { Finding } from "@damame/ir";

async function run(path: string): Promise<Finding[]> {
  const { session } = await parseTranscriptFile(path);
  const metrics = computeMetrics(session);
  return compactionRework.detect({
    session,
    metrics,
    env: session.environment,
    config: { ...compactionRework.defaults },
  });
}

/** Three ~30KB reads, a compaction, then byte-identical re-reads. */
function reworkFixture(rereadSizes: [number, number, number] = [30_000, 30_000, 30_000]) {
  const b = fixture().human("load the modules");
  for (let i = 0; i < 3; i++) b.readOk(`/proj/src/m${i}.ts`, 30_000);
  b.assistantText("loaded").compactBoundary().human("continue");
  rereadSizes.forEach((size, i) => b.readOk(`/proj/src/m${i}.ts`, size));
  return b.assistantText("re-oriented");
}

describe("compaction-rework", () => {
  it("fires when identical content is re-read across a compaction", async () => {
    const findings = await run(reworkFixture().writeTemp());
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.rule.id).toBe("compaction-rework");
    expect(f.severity).toBe("minor");
    expect(f.savings?.basis).toBe("modeled");
    expect(f.evidence.metrics?.reread_count).toBe(3);
    expect(f.evidence.metrics?.reread_bytes).toBe(90_000);
  });

  it("does NOT fire when the re-read content changed (output-identity guard)", async () => {
    // Different sizes -> different output hashes: re-reading changed
    // content is correct behavior, not waste.
    const findings = await run(reworkFixture([31_000, 29_000, 32_000]).writeTemp());
    expect(findings).toHaveLength(0);
  });

  it("does NOT fire without a compaction between the reads — and duplicate-tool-call owns that case", async () => {
    const b = fixture().human("load the modules");
    for (let i = 0; i < 3; i++) b.readOk(`/proj/src/m${i}.ts`, 30_000);
    b.assistantText("loaded").human("continue");
    for (let i = 0; i < 3; i++) b.readOk(`/proj/src/m${i}.ts`, 30_000);
    const path = b.assistantText("done").writeTemp();
    expect(await run(path)).toHaveLength(0);
    // ownership: the same session IS duplicate-tool-call's crime
    const { session } = await parseTranscriptFile(path);
    const metrics = computeMetrics(session);
    const dup = duplicateToolCall.detect({
      session,
      metrics,
      env: session.environment,
      config: { ...duplicateToolCall.defaults },
    });
    expect(dup.length).toBeGreaterThan(0);
  });

  it("does NOT fire under the calibrated floors (2 small re-reads)", async () => {
    const b = fixture().human("load");
    b.readOk("/proj/a.ts", 6_000).readOk("/proj/b.ts", 6_000);
    b.assistantText("ok").compactBoundary().human("continue");
    b.readOk("/proj/a.ts", 6_000).readOk("/proj/b.ts", 6_000);
    const findings = await run(b.assistantText("done").writeTemp());
    expect(findings).toHaveLength(0);
  });
});
