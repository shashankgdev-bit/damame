import { describe, expect, it } from "vitest";
import { fixture } from "@damame/testkit";
import { parseTranscriptFile } from "@damame/adapter-claude-code";
import { computeMetrics } from "@damame/metrics";
import { oversizedContextReads } from "../src/detectors/oversized-context-reads.js";
import type { Finding } from "@damame/ir";

async function run(builderResult: string): Promise<Finding[]> {
  const { session } = await parseTranscriptFile(builderResult);
  const metrics = computeMetrics(session);
  return oversizedContextReads.detect({
    session,
    metrics,
    env: session.environment,
    config: { ...oversizedContextReads.defaults },
  });
}

describe("oversized-context-reads", () => {
  it("fires on a 100KB full-file Read with no offset/limit", async () => {
    const path = fixture()
      .human("explore the codebase")
      .readOk("/home/user/project/generated/schema.ts", 100_000)
      .writeTemp();
    const findings = await run(path);
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.rule.id).toBe("oversized-context-reads");
    expect(f.confidence.source).toBe("deterministic");
    expect(f.severity).toBe("minor");
    expect(f.evidence.events.length).toBeGreaterThanOrEqual(1);
    expect(f.evidence.metrics?.read_count).toBe(1);
    expect(f.evidence.metrics?.total_output_bytes).toBe(100_000);
    expect(f.savings?.basis).toBe("modeled");
    // (100_000 − 8_000 assumed targeted bytes) / 4 bytes-per-token
    expect(f.savings?.tokens?.value).toBe(23_000);
    expect(f.savings?.method).toContain("4");
    expect(f.savings?.method).toContain("8000");
    expect(f.recommendation.resource.kind).toBe("prompting_pattern");
    expect(f.dedupe_key).toHaveLength(16);
  });

  it("groups repeated full reads of the same file into one moderate finding", async () => {
    const path = fixture()
      .human("look at the schema, twice")
      .readOk("/home/user/project/generated/schema.ts", 100_000)
      .bashOk("npm test", "ok")
      .readOk("/home/user/project/generated/schema.ts", 100_000)
      .writeTemp();
    const findings = await run(path);
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.severity).toBe("moderate");
    expect(f.evidence.metrics?.read_count).toBe(2);
    expect(f.savings?.tokens?.value).toBe(46_000);
  });

  it("mentions the Explore subagent in the rationale when the session had it, but keeps kind prompting_pattern", async () => {
    const path = fixture()
      .agentListing(["Explore"])
      .human("explore")
      .readOk("/home/user/project/big.ts", 100_000)
      .writeTemp();
    const findings = await run(path);
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.recommendation.resource.kind).toBe("prompting_pattern");
    expect(f.recommendation.rationale).toContain("Explore");
  });

  it("does NOT fire on a large Read that used a limit (look-alike)", async () => {
    const path = fixture()
      .human("read part of the big file")
      .readOk("/home/user/project/big.ts", 100_000, { limit: 500 })
      .writeTemp();
    expect(await run(path)).toHaveLength(0);
  });

  it("does NOT fire on a small full read (just under the size threshold)", async () => {
    const path = fixture()
      .human("read the file")
      .readOk("/home/user/project/medium.ts", 79_999)
      .writeTemp();
    expect(await run(path)).toHaveLength(0);
  });

  it("is idempotent: same session → same dedupe keys", async () => {
    const path = fixture()
      .human("explore")
      .readOk("/home/user/project/big.ts", 100_000)
      .writeTemp();
    const [a, b] = [await run(path), await run(path)];
    expect(a.map((f) => f.dedupe_key)).toEqual(b.map((f) => f.dedupe_key));
  });
});
