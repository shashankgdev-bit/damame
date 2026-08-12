import { describe, expect, it } from "vitest";
import { fixture } from "@damame/testkit";
import { parseTranscriptFile } from "@damame/adapter-claude-code";
import { computeMetrics } from "@damame/metrics";
import { editFailLoop } from "../src/detectors/edit-fail-loop.js";
import type { Finding } from "@damame/ir";

async function run(builderResult: string): Promise<Finding[]> {
  const { session } = await parseTranscriptFile(builderResult);
  const metrics = computeMetrics(session);
  return editFailLoop.detect({ session, metrics, env: session.environment, config: { ...editFailLoop.defaults } });
}

describe("edit-fail-loop", () => {
  it("fires on 3 consecutive edit failures on the same file (with interleaved Reads)", async () => {
    const path = fixture()
      .human("fix the bug in api.ts")
      .editFail("/home/user/project/api.ts")
      .readOk("/home/user/project/api.ts") // diagnostic read must NOT break the run
      .editFail("/home/user/project/api.ts")
      .editFail("/home/user/project/api.ts")
      .editOk("/home/user/project/api.ts")
      .writeTemp();
    const findings = await run(path);
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.rule.id).toBe("edit-fail-loop");
    expect(f.confidence.source).toBe("deterministic");
    expect(f.evidence.metrics?.consecutive_failures).toBe(3);
    expect(f.evidence.events.length).toBeGreaterThanOrEqual(3);
    expect(f.savings?.basis).toBe("measured");
    // retries after the first failure spent measurable tokens
    expect(f.savings?.tokens?.value).toBeGreaterThan(0);
    expect(f.dedupe_key).toHaveLength(16);
  });

  it("does NOT fire at 2 failures (just under threshold)", async () => {
    const path = fixture()
      .human("fix the bug")
      .editFail("/home/user/project/api.ts")
      .editFail("/home/user/project/api.ts")
      .editOk("/home/user/project/api.ts")
      .writeTemp();
    expect(await run(path)).toHaveLength(0);
  });

  it("does NOT fire on failures against different files (look-alike)", async () => {
    const path = fixture()
      .human("fix the bugs")
      .editFail("/home/user/project/a.ts")
      .editFail("/home/user/project/b.ts")
      .editFail("/home/user/project/c.ts")
      .writeTemp();
    expect(await run(path)).toHaveLength(0);
  });

  it("is idempotent: same session → same dedupe keys", async () => {
    const path = fixture()
      .human("fix")
      .editFail("/x.ts")
      .editFail("/x.ts")
      .editFail("/x.ts")
      .writeTemp();
    const [a, b] = [await run(path), await run(path)];
    expect(a.map((f) => f.dedupe_key)).toEqual(b.map((f) => f.dedupe_key));
  });
});
