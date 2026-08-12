import { describe, expect, it } from "vitest";
import { fixture } from "@damame/testkit";
import { parseTranscriptFile } from "@damame/adapter-claude-code";
import { computeMetrics } from "@damame/metrics";
import { bashErrorLoop } from "../src/detectors/bash-error-loop.js";
import type { Finding } from "@damame/ir";

async function run(builderResult: string): Promise<Finding[]> {
  const { session } = await parseTranscriptFile(builderResult);
  const metrics = computeMetrics(session);
  return bashErrorLoop.detect({ session, metrics, env: session.environment, config: { ...bashErrorLoop.defaults } });
}

describe("bash-error-loop", () => {
  it("fires on 3 consecutive failures of the same command", async () => {
    const path = fixture()
      .human("run the tests")
      .bashFail("npm test")
      .bashFail("npm test")
      .bashFail("npm test")
      .bashOk("npm test")
      .writeTemp();
    const findings = await run(path);
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.rule.id).toBe("bash-error-loop");
    expect(f.category).toBe("error-loop");
    expect(f.severity).toBe("moderate");
    expect(f.confidence.source).toBe("deterministic");
    expect(f.evidence.metrics?.consecutive_failures).toBe(3);
    expect(f.evidence.metrics?.signature).toBe("exit_code_nonzero");
    expect(f.evidence.events.length).toBeGreaterThanOrEqual(3);
    expect(f.savings?.basis).toBe("measured");
    // retries after the first failure spent measurable tokens and time
    expect(f.savings?.tokens?.value).toBeGreaterThan(0);
    expect(f.savings?.wall_clock_ms?.value).toBeGreaterThan(0);
    expect(f.recommendation.resource.kind).toBe("prompting_pattern");
    expect(f.recommendation.resource.ref).toBe("diagnose-before-retry");
    expect(f.dedupe_key).toHaveLength(16);
  });

  it("fires on command timeouts and escalates to major at 5 consecutive failures", async () => {
    const b = fixture().human("run the slow job");
    for (let i = 0; i < 5; i++) {
      b.tool(
        "Bash",
        { command: "./slow-job.sh" },
        { content: "Command timed out after 2m 0.0s", isError: true, toolUseResult: "Command timed out after 2m 0.0s" },
      );
    }
    const findings = await run(b.writeTemp());
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.severity).toBe("major");
    expect(f.evidence.metrics?.signature).toBe("command_timeout");
    expect(f.evidence.metrics?.consecutive_failures).toBe(5);
    expect(f.savings?.basis).toBe("measured");
  });

  it("does NOT fire at 2 failures (just under threshold)", async () => {
    const path = fixture()
      .human("run the tests")
      .bashFail("npm test")
      .bashFail("npm test")
      .bashOk("npm test")
      .writeTemp();
    expect(await run(path)).toHaveLength(0);
  });

  it("does NOT fire on 3 failures of different commands (look-alike)", async () => {
    const path = fixture()
      .human("try a few things")
      .bashFail("npm test")
      .bashFail("npm run build")
      .bashFail("ls /nonexistent")
      .writeTemp();
    expect(await run(path)).toHaveLength(0);
  });

  it("does NOT fire when a success of the same tool breaks the run (look-alike)", async () => {
    const path = fixture()
      .human("run the tests")
      .bashFail("npm test")
      .bashFail("npm test")
      .bashOk("echo diagnosing")
      .bashFail("npm test")
      .writeTemp();
    expect(await run(path)).toHaveLength(0);
  });

  it("is idempotent: same session → same dedupe keys", async () => {
    const path = fixture()
      .human("run")
      .bashFail("make check")
      .bashFail("make check")
      .bashFail("make check")
      .writeTemp();
    const [a, b] = [await run(path), await run(path)];
    expect(a.map((f) => f.dedupe_key)).toEqual(b.map((f) => f.dedupe_key));
  });
});
