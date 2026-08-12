import { describe, expect, it } from "vitest";
import { fixture } from "@damame/testkit";
import { parseTranscriptFile } from "@damame/adapter-claude-code";
import { computeMetrics } from "@damame/metrics";
import { retryStorm } from "../src/detectors/retry-storm.js";
import type { Finding } from "@damame/ir";

async function run(builderResult: string): Promise<Finding[]> {
  const { session } = await parseTranscriptFile(builderResult);
  const metrics = computeMetrics(session);
  return retryStorm.detect({ session, metrics, env: session.environment, config: { ...retryStorm.defaults } });
}

describe("retry-storm", () => {
  it("fires on 3 api_error events with measured backoff wait", async () => {
    const path = fixture()
      .human("run the migration")
      .apiError(1, 5000)
      .apiError(2, 10000)
      .apiError(3, 20000)
      .assistantText("done after retries")
      .writeTemp();
    const findings = await run(path);
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.rule.id).toBe("retry-storm");
    expect(f.severity).toBe("info");
    expect(f.confidence.source).toBe("deterministic");
    expect(f.evidence.events.length).toBe(3);
    expect(f.evidence.metrics?.api_error_count).toBe(3);
    expect(f.savings?.basis).toBe("measured");
    // measured wall clock = sum of recorded retryInMs waits
    expect(f.savings?.wall_clock_ms?.value).toBe(35000);
    expect(f.savings?.tokens).toBeUndefined();
    expect(f.recommendation.resource.kind).toBe("config");
    expect(f.recommendation.resource.ref).toBe("none-required");
    expect(f.dedupe_key).toHaveLength(16);
  });

  it("fires on a single terminal error placeholder even below min_api_errors, without a savings claim", async () => {
    const path = fixture()
      .human("summarize the repo")
      .assistant([{ type: "text", text: "API Error: overloaded" }], { model: "<synthetic>" })
      .writeTemp();
    const findings = await run(path);
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.rule.id).toBe("retry-storm");
    expect(f.severity).toBe("info");
    expect(f.confidence.source).toBe("deterministic");
    expect(f.evidence.events.length).toBe(1);
    expect(f.evidence.metrics?.error_placeholder_count).toBe(1);
    // no retryInMs was recorded, so no wall-clock claim is made
    expect(f.savings).toBeUndefined();
  });

  it("emits ONE finding when api errors and a placeholder both occur, citing both", async () => {
    const path = fixture()
      .human("build the report")
      .apiError(1, 5000)
      .apiError(2, 10000)
      .apiError(3, 20000)
      .assistant([{ type: "text", text: "API Error: overloaded" }], { model: "<synthetic>" })
      .writeTemp();
    const findings = await run(path);
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.evidence.events.length).toBe(4);
    expect(f.evidence.metrics?.api_error_count).toBe(3);
    expect(f.evidence.metrics?.error_placeholder_count).toBe(1);
    expect(f.savings?.wall_clock_ms?.value).toBe(35000);
  });

  it("does NOT fire at 2 api_error events (just under threshold)", async () => {
    const path = fixture()
      .human("run the migration")
      .apiError(1, 5000)
      .apiError(2, 5000)
      .assistantText("done")
      .writeTemp();
    expect(await run(path)).toHaveLength(0);
  });

  it("does NOT fire on repeated tool errors (look-alike storm that is not API-side)", async () => {
    const path = fixture()
      .human("run the tests")
      .bashFail("npm test", "1 test failed")
      .bashFail("npm test", "1 test failed")
      .bashFail("npm test", "1 test failed")
      .assistantText("the suite is broken")
      .writeTemp();
    expect(await run(path)).toHaveLength(0);
  });

  it("is idempotent: same session → same dedupe keys", async () => {
    const path = fixture()
      .human("go")
      .apiError(1, 5000)
      .apiError(2, 5000)
      .apiError(3, 5000)
      .assistantText("done")
      .writeTemp();
    const [a, b] = [await run(path), await run(path)];
    expect(a.map((f) => f.dedupe_key)).toEqual(b.map((f) => f.dedupe_key));
  });
});
