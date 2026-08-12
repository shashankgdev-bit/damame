import { describe, expect, it } from "vitest";
import { fixture } from "@damame/testkit";
import { parseTranscriptFile } from "@damame/adapter-claude-code";
import { computeMetrics } from "@damame/metrics";
import { cacheThrash } from "../src/detectors/cache-thrash.js";
import type { Finding } from "@damame/ir";

async function run(builderResult: string): Promise<Finding[]> {
  const { session } = await parseTranscriptFile(builderResult);
  const metrics = computeMetrics(session);
  return cacheThrash.detect({ session, metrics, env: session.environment, config: { ...cacheThrash.defaults } });
}

describe("cache-thrash", () => {
  it("fires when tools_changed misses sum past the threshold", async () => {
    const path = fixture()
      .human("refactor the parser")
      .assistant([{ type: "text", text: "working on it" }], {
        cacheMiss: { reason: "tools_changed", tokens: 60_000 },
      })
      .human("continue")
      .assistant([{ type: "text", text: "done" }], {
        cacheMiss: { reason: "tools_changed", tokens: 55_000 },
      })
      .writeTemp();
    const findings = await run(path);
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.rule.id).toBe("cache-thrash");
    expect(f.confidence.source).toBe("deterministic");
    expect(f.severity).toBe("moderate");
    expect(f.evidence.events).toHaveLength(2);
    expect(f.evidence.metrics?.reason).toBe("tools_changed");
    expect(f.evidence.metrics?.total_missed_input_tokens).toBe(115_000);
    expect(f.savings?.basis).toBe("measured");
    expect(f.savings?.tokens?.value).toBe(115_000);
    expect(f.recommendation.resource.kind).toBe("config");
    expect(f.recommendation.resource.ref).toBe("stable-tool-availability");
    expect(f.dedupe_key).toHaveLength(16);
  });

  it("escalates to major when the missed total is huge", async () => {
    const path = fixture()
      .human("big refactor")
      .assistant([{ type: "text", text: "ok" }], {
        cacheMiss: { reason: "tools_changed", tokens: 1_200_000 },
      })
      .writeTemp();
    const findings = await run(path);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("major");
  });

  it("reports infrastructure-side reasons at severity info with a fairness description", async () => {
    const path = fixture()
      .human("resume where we left off")
      .assistant([{ type: "text", text: "resuming" }], {
        cacheMiss: { reason: "previous_message_not_found", tokens: 150_000 },
      })
      .writeTemp();
    const findings = await run(path);
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.category).toBe("context-hygiene");
    expect(f.severity).toBe("info");
    expect(f.description).toMatch(/infrastructure-side/);
    expect(f.recommendation.resource.kind).toBe("prompting_pattern");
    expect(f.savings?.basis).toBe("measured");
    expect(f.savings?.tokens?.value).toBe(150_000);
  });

  it("does NOT fire when the summed misses are just under the threshold", async () => {
    const path = fixture()
      .human("small task")
      .assistant([{ type: "text", text: "ok" }], {
        cacheMiss: { reason: "tools_changed", tokens: 60_000 },
      })
      .human("continue")
      .assistant([{ type: "text", text: "ok" }], {
        cacheMiss: { reason: "tools_changed", tokens: 39_999 },
      })
      .writeTemp();
    expect(await run(path)).toHaveLength(0);
  });

  it("does NOT fire when misses cross the threshold only across different reasons (look-alike)", async () => {
    const path = fixture()
      .human("mixed session")
      .assistant([{ type: "text", text: "ok" }], {
        cacheMiss: { reason: "tools_changed", tokens: 60_000 },
      })
      .human("continue")
      .assistant([{ type: "text", text: "ok" }], {
        cacheMiss: { reason: "previous_message_not_found", tokens: 60_000 },
      })
      .writeTemp();
    // 120k total, but no single reason group reaches 100k.
    expect(await run(path)).toHaveLength(0);
  });

  it("is idempotent: same session → same dedupe keys", async () => {
    const path = fixture()
      .human("go")
      .assistant([{ type: "text", text: "ok" }], {
        cacheMiss: { reason: "tools_changed", tokens: 120_000 },
      })
      .writeTemp();
    const [a, b] = [await run(path), await run(path)];
    expect(a.map((f) => f.dedupe_key)).toEqual(b.map((f) => f.dedupe_key));
  });
});
