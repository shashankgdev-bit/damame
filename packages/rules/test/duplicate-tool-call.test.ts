import { describe, expect, it } from "vitest";
import { fixture } from "@damame/testkit";
import { parseTranscriptFile } from "@damame/adapter-claude-code";
import { computeMetrics } from "@damame/metrics";
import { duplicateToolCall } from "../src/detectors/duplicate-tool-call.js";
import type { Finding } from "@damame/ir";

async function run(builderResult: string): Promise<Finding[]> {
  const { session } = await parseTranscriptFile(builderResult);
  const metrics = computeMetrics(session);
  return duplicateToolCall.detect({
    session,
    metrics,
    env: session.environment,
    config: { ...duplicateToolCall.defaults },
  });
}

describe("duplicate-tool-call", () => {
  it("fires on 3 identical Reads with identical output and no state change between", async () => {
    const path = fixture()
      .human("what does api.ts do")
      .readOk("/home/user/project/api.ts", 800)
      .assistantText("looking at it")
      .readOk("/home/user/project/api.ts", 800)
      .readOk("/home/user/project/api.ts", 800)
      .writeTemp();
    const findings = await run(path);
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.rule.id).toBe("duplicate-tool-call");
    expect(f.confidence.source).toBe("deterministic");
    expect(f.severity).toBe("minor"); // 1600 repeated bytes < min_repeated_bytes
    expect(f.evidence.events).toHaveLength(3);
    expect(f.evidence.metrics?.occurrences).toBe(3);
    expect(f.evidence.metrics?.repeated_output_bytes).toBe(1600);
    expect(f.savings?.basis).toBe("modeled");
    expect(f.savings?.tokens?.value).toBe(400); // 1600 bytes / 4
    expect(f.savings?.method).toContain("4 bytes/token");
    expect(f.recommendation.resource.kind).toBe("prompting_pattern");
    expect(f.recommendation.resource.ref).toBe("reference-earlier-output");
    expect(f.dedupe_key).toHaveLength(16);
  });

  it("fires at 2 occurrences when repeated bytes cross min_repeated_bytes (moderate)", async () => {
    const path = fixture()
      .human("summarize the big file")
      .readOk("/home/user/project/big.txt", 30_000)
      .assistantText("summarizing")
      .readOk("/home/user/project/big.txt", 30_000)
      .writeTemp();
    const findings = await run(path);
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.severity).toBe("moderate");
    expect(f.evidence.metrics?.occurrences).toBe(2);
    expect(f.savings?.basis).toBe("modeled");
    expect(f.savings?.tokens?.value).toBe(7500); // 30_000 bytes / 4
  });

  it("does NOT fire at 2 small-output occurrences (just under both thresholds)", async () => {
    const path = fixture()
      .human("check the config")
      .readOk("/home/user/project/config.ts", 500)
      .assistantText("checking")
      .readOk("/home/user/project/config.ts", 500)
      .writeTemp();
    expect(await run(path)).toHaveLength(0);
  });

  it("does NOT fire when a state change happened between occurrences (look-alike: re-read after edit)", async () => {
    // Would satisfy both the occurrence and byte thresholds, but re-running a
    // call after an edit is correct behavior, not redundant work.
    const path = fixture()
      .human("refactor big.txt")
      .readOk("/home/user/project/big.txt", 30_000)
      .editOk("/home/user/project/big.txt")
      .readOk("/home/user/project/big.txt", 30_000)
      .editOk("/home/user/project/big.txt")
      .readOk("/home/user/project/big.txt", 30_000)
      .writeTemp();
    expect(await run(path)).toHaveLength(0);
  });

  it("does NOT fire when outputs differ across occurrences", async () => {
    const path = fixture()
      .human("watch the file")
      .readOk("/home/user/project/api.ts", 800)
      .readOk("/home/user/project/api.ts", 900)
      .readOk("/home/user/project/api.ts", 1000)
      .writeTemp();
    expect(await run(path)).toHaveLength(0);
  });

  it("does NOT fire on repeated TodoWrite calls (legitimately repeated tool)", async () => {
    const todos = { todos: [{ content: "step 1", status: "pending", activeForm: "doing step 1" }] };
    const path = fixture()
      .human("do the task")
      .tool("TodoWrite", todos, { content: "x".repeat(30_000), toolUseResult: { ok: true } })
      .tool("TodoWrite", todos, { content: "x".repeat(30_000), toolUseResult: { ok: true } })
      .tool("TodoWrite", todos, { content: "x".repeat(30_000), toolUseResult: { ok: true } })
      .writeTemp();
    expect(await run(path)).toHaveLength(0);
  });

  it("is idempotent: same session → same dedupe keys", async () => {
    const path = fixture()
      .human("look")
      .readOk("/x.ts", 800)
      .readOk("/x.ts", 800)
      .readOk("/x.ts", 800)
      .writeTemp();
    const [a, b] = [await run(path), await run(path)];
    expect(a.length).toBeGreaterThan(0);
    expect(a.map((f) => f.dedupe_key)).toEqual(b.map((f) => f.dedupe_key));
  });
});
