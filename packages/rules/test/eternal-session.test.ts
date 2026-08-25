import { describe, expect, it } from "vitest";
import { fixture, type TranscriptBuilder } from "@damame/testkit";
import { parseTranscriptFile } from "@damame/adapter-claude-code";
import { computeMetrics } from "@damame/metrics";
import { eternalSession } from "../src/detectors/eternal-session.js";
import type { Finding } from "@damame/ir";

async function run(builderResult: string): Promise<Finding[]> {
  const { session } = await parseTranscriptFile(builderResult);
  const metrics = computeMetrics(session);
  return eternalSession.detect({
    session,
    metrics,
    env: session.environment,
    config: { ...eternalSession.defaults },
  });
}

const START_MS = Date.parse("2026-08-01T10:00:00.000Z");

/**
 * Push `count` additional resume boundaries: raw user lines with
 * parentUuid: null, which the adapter records in chain_root_event_ids.
 * The first builder line is already a chain root, so a fixture built with
 * addResumes(b, n) has n + 1 resume boundaries in total.
 */
function addResumes(b: TranscriptBuilder, count: number): TranscriptBuilder {
  for (let i = 0; i < count; i++) {
    b.push({
      uuid: `manual-root-${i + 1}`,
      parentUuid: null,
      sessionId: b.sessionId,
      timestamp: new Date(START_MS + 60_000 + i * 1_000).toISOString(),
      cwd: "/home/user/project",
      gitBranch: "main",
      version: "2.1.200",
      userType: "external",
      entrypoint: "cli",
      isSidechain: false,
      slug: "fixture-session",
      type: "user",
      message: { role: "user", content: [{ type: "text", text: `resume ${i + 1}` }] },
      origin: { kind: "human" },
    });
  }
  return b;
}

function eternal(
  opts: { resumes?: number; compactions?: number; spanDays?: number; stateFile?: string } = {},
): string {
  const { resumes = 15, compactions = 3, spanDays = 7, stateFile } = opts;
  const b = fixture();
  b.human("keep working on the long project");
  if (stateFile) b.readOk(stateFile);
  b.assistantText("Picking up where we left off.");
  addResumes(b, resumes - 1);
  for (let i = 0; i < compactions; i++) b.compactBoundary();
  b.tick(spanDays * 86_400_000);
  b.assistantText("Done for today.");
  return b.writeTemp();
}

describe("eternal-session", () => {
  it("fires at exact thresholds (15 resumes, 3 compactions, 7-day span) with state files present", async () => {
    const findings = await run(eternal({ stateFile: "/home/user/project/LEDGER.md" }));
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.rule.id).toBe("eternal-session");
    expect(f.category).toBe("context-hygiene");
    expect(f.confidence.source).toBe("deterministic");
    expect(f.severity).toBe("moderate");
    expect(f.evidence.events).toHaveLength(3);
    expect(f.evidence.metrics?.resumes).toBe(15);
    expect(f.evidence.metrics?.compactions).toBe(3);
    expect(f.evidence.metrics?.span_days as number).toBeGreaterThanOrEqual(7);
    expect(f.evidence.metrics?.state_files).toEqual(["LEDGER.md"]);
    // 3 compactions × the builder's default 120_000ms recorded duration each
    expect(f.savings?.wall_clock_ms?.value).toBe(3 * 120_000);
    expect(f.savings?.basis).toBe("measured");
    expect(f.recommendation.resource.kind).toBe("prompting_pattern");
    expect(f.recommendation.resource.ref).toBe("session-per-task-bootstrap");
    expect(f.recommendation.rationale).toContain("LEDGER.md");
    expect(f.recommendation.rationale).toContain("already carry the memory");
    expect(f.dedupe_key).toHaveLength(16);
  });

  it("escalates to major at 10 compactions and caps evidence at 8 events", async () => {
    const findings = await run(eternal({ compactions: 10 }));
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.severity).toBe("major");
    expect(f.evidence.events).toHaveLength(8);
    expect(f.evidence.metrics?.compactions).toBe(10);
  });

  it("recommends creating a state file when none was touched", async () => {
    const findings = await run(eternal());
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.evidence.metrics?.state_files).toEqual([]);
    expect(f.recommendation.rationale).toContain("Create a state/briefing file first");
    expect(f.recommendation.rationale).not.toContain("already carry the memory");
  });

  it("does NOT fire at 14 resumes (just under threshold)", async () => {
    expect(await run(eternal({ resumes: 14 }))).toHaveLength(0);
  });

  it("does NOT fire at 2 compactions (just under threshold)", async () => {
    expect(await run(eternal({ compactions: 2 }))).toHaveLength(0);
  });

  it("does NOT fire on a 2-day session with 1 compaction and 5 resumes (normal multi-sitting task)", async () => {
    expect(await run(eternal({ resumes: 5, compactions: 1, spanDays: 2 }))).toHaveLength(0);
  });

  it("does NOT fire on a long span alone when resumes and compactions are low", async () => {
    expect(await run(eternal({ resumes: 5, compactions: 2, spanDays: 30 }))).toHaveLength(0);
  });

  it("is idempotent: same session → same dedupe keys", async () => {
    const path = eternal({ stateFile: "/home/user/project/NOTES.md" });
    const [a, b] = [await run(path), await run(path)];
    expect(a.map((f) => f.dedupe_key)).toEqual(b.map((f) => f.dedupe_key));
  });
});
