import { describe, expect, it } from "vitest";
import { fixture } from "@damame/testkit";
import { parseTranscriptFile } from "@damame/adapter-claude-code";
import { computeMetrics } from "@damame/metrics";
import { compactionBurn } from "../src/detectors/compaction-burn.js";
import type { Finding } from "@damame/ir";

async function run(builderResult: string): Promise<Finding[]> {
  const { session } = await parseTranscriptFile(builderResult);
  const metrics = computeMetrics(session);
  return compactionBurn.detect({
    session,
    metrics,
    env: session.environment,
    config: { ...compactionBurn.defaults },
  });
}

describe("compaction-burn", () => {
  it("fires on 2 compactions with measured duration savings and a subagent recommendation", async () => {
    const path = fixture()
      .agentListing(["Explore", "general-purpose"])
      .human("refactor the whole module")
      .readOk("/home/user/project/big.ts", 90_000)
      .compactBoundary({ durationMs: 90_000 })
      .readOk("/home/user/project/other.ts", 90_000)
      .compactBoundary({ durationMs: 30_000 })
      .assistantText("done")
      .writeTemp();
    const findings = await run(path);
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.rule.id).toBe("compaction-burn");
    expect(f.category).toBe("context-hygiene");
    expect(f.severity).toBe("moderate");
    expect(f.confidence.source).toBe("deterministic");
    // both compaction events cited as evidence
    expect(f.evidence.events).toHaveLength(2);
    expect(f.evidence.metrics?.compaction_count).toBe(2);
    // measured wall-clock = sum of recorded compaction durations; no token claim
    expect(f.savings?.basis).toBe("measured");
    expect(f.savings?.wall_clock_ms?.value).toBe(120_000);
    expect(f.savings?.tokens).toBeUndefined();
    // Explore was available in the session, so the recommendation cites it
    expect(f.recommendation.resource.kind).toBe("subagent");
    expect(f.recommendation.resource.ref).toBe("Explore");
    expect(f.recommendation.resource.available_in_session).toBe(true);
    expect(f.dedupe_key).toHaveLength(16);
  });

  it("escalates to major at 4 compactions and falls back to a prompting pattern without agents", async () => {
    const path = fixture()
      .human("do everything")
      .compactBoundary({ durationMs: 10_000 })
      .compactBoundary({ durationMs: 10_000 })
      .compactBoundary({ durationMs: 10_000 })
      .compactBoundary({ durationMs: 10_000 })
      .writeTemp();
    const findings = await run(path);
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.severity).toBe("major");
    expect(f.evidence.events).toHaveLength(4);
    // no agent listing in the session env → never claim they had a subagent
    expect(f.recommendation.resource.kind).toBe("prompting_pattern");
    expect(f.recommendation.resource.ref).toBe("delegate-bulk-exploration");
  });

  it("recommends the prompting pattern when the exploration agents were removed mid-session", async () => {
    const path = fixture()
      .agentListing(["Explore", "general-purpose"])
      .human("go")
      .attachment({
        type: "agent_listing_delta",
        isInitial: false,
        addedTypes: [],
        addedLines: [],
        removedTypes: ["Explore", "general-purpose"],
      })
      .compactBoundary({ durationMs: 5_000 })
      .compactBoundary({ durationMs: 5_000 })
      .writeTemp();
    const findings = await run(path);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.recommendation.resource.kind).toBe("prompting_pattern");
  });

  it("does NOT fire on a single compaction (just under threshold)", async () => {
    const path = fixture()
      .human("one big task")
      .readOk("/home/user/project/big.ts", 90_000)
      .compactBoundary({ durationMs: 120_000 })
      .assistantText("done")
      .writeTemp();
    expect(await run(path)).toHaveLength(0);
  });

  it("does NOT fire on a resumed compact summary and api errors without a compact boundary (look-alike)", async () => {
    const b = fixture()
      .human("keep going")
      .assistantText("working")
      .apiError(1)
      .apiError(2);
    // A compact-summary user message (as written when resuming a compacted
    // session) is not a compaction event in this transcript.
    b.push({
      uuid: "manual-compact-summary-uuid",
      parentUuid: b.currentUuid(),
      sessionId: b.sessionId,
      timestamp: "2026-08-01T11:00:00.000Z",
      type: "user",
      isCompactSummary: true,
      message: {
        role: "user",
        content: [
          { type: "text", text: "This session is being continued from a previous conversation..." },
        ],
      },
    });
    expect(await run(b.writeTemp())).toHaveLength(0);
  });

  it("is idempotent: same session → same dedupe keys", async () => {
    const path = fixture()
      .human("go")
      .compactBoundary({ durationMs: 60_000 })
      .compactBoundary({ durationMs: 60_000 })
      .writeTemp();
    const [a, b] = [await run(path), await run(path)];
    expect(a.map((f) => f.dedupe_key)).toEqual(b.map((f) => f.dedupe_key));
  });
});
