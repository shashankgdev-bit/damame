import { describe, expect, it } from "vitest";
import { fixture } from "@damame/testkit";
import { parseTranscriptFile } from "@damame/adapter-claude-code";
import { computeMetrics } from "@damame/metrics";
import { permissionChurn } from "../src/detectors/permission-churn.js";
import type { Finding } from "@damame/ir";

async function run(builderResult: string): Promise<Finding[]> {
  const { session } = await parseTranscriptFile(builderResult);
  const metrics = computeMetrics(session);
  return permissionChurn.detect({
    session,
    metrics,
    env: session.environment,
    config: { ...permissionChurn.defaults },
  });
}

describe("permission-churn", () => {
  it("fires on 3 denials with per-tool counts and a config recommendation", async () => {
    const path = fixture()
      .human("clean up the repo")
      .permissionDenied("Bash", { command: "rm -rf dist" })
      .permissionDenied("Bash", { command: "git push --force" })
      .permissionDenied("Write", { file_path: "/etc/hosts", content: "x" })
      .writeTemp();
    const findings = await run(path);
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.rule.id).toBe("permission-churn");
    expect(f.confidence.source).toBe("deterministic");
    expect(f.severity).toBe("minor");
    expect(f.evidence.events).toHaveLength(3);
    expect(f.evidence.metrics?.total_denials).toBe(3);
    expect(f.evidence.metrics?.denials_by_tool).toEqual({ Bash: 2, Write: 1 });
    // Denied-call cost is trivial and human wait time is unmeasurable: no savings claim.
    expect(f.savings).toBeUndefined();
    // No fewer-permission-prompts skill in this session's env → config recommendation.
    expect(f.recommendation.resource.kind).toBe("config");
    expect(f.recommendation.resource.ref).toBe("permissions-allowlist");
    expect(f.recommendation.rationale).toContain("Bash");
    expect(f.dedupe_key).toHaveLength(16);
  });

  it("recommends the fewer-permission-prompts skill when the session env has it", async () => {
    const path = fixture()
      .skillListing(["fewer-permission-prompts"])
      .human("clean up the repo")
      .permissionDenied("Bash", { command: "rm -rf dist" })
      .permissionDenied("Bash", { command: "git push --force" })
      .permissionDenied("Bash", { command: "npm publish" })
      .writeTemp();
    const findings = await run(path);
    expect(findings).toHaveLength(1);
    const rec = findings[0]!.recommendation;
    expect(rec.resource.kind).toBe("skill");
    expect(rec.resource.ref).toBe("fewer-permission-prompts");
    expect(rec.resource.available_in_session).toBe(true);
  });

  it("escalates to moderate at 2x the threshold", async () => {
    const b = fixture().human("do things");
    for (let i = 0; i < 6; i++) b.permissionDenied("Bash", { command: `cmd-${i}` });
    const findings = await run(b.writeTemp());
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("moderate");
  });

  it("does NOT fire at 2 denials (just under threshold)", async () => {
    const path = fixture()
      .human("clean up")
      .permissionDenied("Bash", { command: "rm -rf dist" })
      .permissionDenied("Bash", { command: "git push --force" })
      .writeTemp();
    expect(await run(path)).toHaveLength(0);
  });

  it("does NOT fire on ordinary tool failures (look-alike, not denials)", async () => {
    const path = fixture()
      .human("run the build")
      .bashFail("npm run build")
      .bashFail("npm run build")
      .bashFail("npm test")
      .writeTemp();
    expect(await run(path)).toHaveLength(0);
  });

  it("is idempotent: same session → same dedupe keys", async () => {
    const path = fixture()
      .human("go")
      .permissionDenied("Bash", { command: "a" })
      .permissionDenied("Bash", { command: "b" })
      .permissionDenied("Bash", { command: "c" })
      .writeTemp();
    const [a, b] = [await run(path), await run(path)];
    expect(a.map((f) => f.dedupe_key)).toEqual(b.map((f) => f.dedupe_key));
  });
});
