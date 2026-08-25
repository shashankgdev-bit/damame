import { describe, expect, it } from "vitest";
import { fixture, type TranscriptBuilder } from "@damame/testkit";
import { parseTranscriptFile } from "@damame/adapter-claude-code";
import { computeMetrics } from "@damame/metrics";
import { idleGapNotifications } from "../src/detectors/idle-gap-notifications.js";
import type { Finding } from "@damame/ir";

async function run(builderResult: string): Promise<Finding[]> {
  const { session } = await parseTranscriptFile(builderResult);
  const metrics = computeMetrics(session);
  return idleGapNotifications.detect({
    session,
    metrics,
    env: session.environment,
    config: { ...idleGapNotifications.defaults },
  });
}

/**
 * Builds `gaps + 1` human turns separated by `gapMs` idle pauses. Each
 * emitted line advances the fixture clock by 250ms, so the measured gap is
 * slightly larger than `gapMs`; tests use gap sizes far enough from the
 * thresholds that the slop cannot flip an outcome.
 */
function turnsWithGaps(gaps: number, gapMs: number): TranscriptBuilder {
  const b = fixture();
  b.human("start task 0").assistantText("Task 0 done.");
  for (let i = 1; i <= gaps; i++) {
    b.tick(gapMs);
    b.human(`start task ${i}`).assistantText(`Task ${i} done.`);
  }
  return b;
}

describe("idle-gap-notifications", () => {
  it("fires on 6 gaps of 10 minutes (over count and total thresholds)", async () => {
    const findings = await run(turnsWithGaps(6, 600_000).writeTemp());
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.rule.id).toBe("idle-gap-notifications");
    expect(f.rule.version).toBe("0.2.0");
    expect(f.category).toBe("missed-resource");
    expect(f.severity).toBe("minor");
    expect(f.confidence.source).toBe("deterministic");
    expect(f.title).toContain("waited unnoticed");
    // Never blames the human for being away.
    expect(f.title).not.toContain("idle");
    expect(f.description).toContain("no notification signal");
    expect(f.evidence.events).toHaveLength(1);
    expect(f.evidence.metrics?.gap_count).toBe(6);
    expect(f.evidence.metrics?.total_idle_ms as number).toBeGreaterThanOrEqual(6 * 600_000);
    expect(f.evidence.metrics?.largest_gap_ms as number).toBeGreaterThanOrEqual(600_000);
    // Away-time is not recoverable waste — no savings claimed.
    expect(f.savings).toBeUndefined();
    expect(f.recommendation.resource.kind).toBe("config");
    expect(f.recommendation.resource.ref).toBe("enable-notifications");
    expect(f.recommendation.rationale).toContain("notif");
    expect(f.dedupe_key).toHaveLength(16);
  });

  it("does NOT fire on 4 gaps of 6 minutes (under the gap-count threshold)", async () => {
    expect(await run(turnsWithGaps(4, 360_000).writeTemp())).toHaveLength(0);
  });

  it("does NOT fire on 6 gaps of 2 minutes (each under the minimum gap size)", async () => {
    expect(await run(turnsWithGaps(6, 120_000).writeTemp())).toHaveLength(0);
  });

  it("does NOT fire when enough long gaps exist but their sum is under min_total_ms", async () => {
    // 5 gaps of ~5.2 minutes each qualify individually (>= 300_000ms) but sum
    // to ~26 minutes, under the 30-minute total threshold.
    expect(await run(turnsWithGaps(5, 310_000).writeTemp())).toHaveLength(0);
  });

  it("does NOT count many short pauses toward the total (look-alike: busy back-and-forth)", async () => {
    // 20 sub-threshold pauses sum to well over 30 minutes, but none is a
    // "finished work sat waiting" gap — the human was actively responding.
    expect(await run(turnsWithGaps(20, 120_000).writeTemp())).toHaveLength(0);
  });

  it("is idempotent: same session → same dedupe keys", async () => {
    const path = turnsWithGaps(6, 600_000).writeTemp();
    const [a, b] = [await run(path), await run(path)];
    expect(a.map((f) => f.dedupe_key)).toEqual(b.map((f) => f.dedupe_key));
  });
});

describe("idle-gap-notifications v0.2.0 scheduling suppression", () => {
  it("stays silent on a session that schedules its own wake-ups", async () => {
    const b = fixture().human("run the overnight loop");
    b.assistantText("Working autonomously.");
    const { id } = b.toolCall("ScheduleWakeup", { delaySeconds: 1200, reason: "loop tick" });
    b.toolResult(id);
    for (let i = 0; i < 6; i++) {
      b.tick(700_000);
      b.human(`continue ${i + 1}`);
      b.assistantText(`Tick ${i + 1} done.`);
    }
    const path = b.writeTemp();
    const { session } = await parseTranscriptFile(path);
    const metrics = computeMetrics(session);
    const findings = idleGapNotifications.detect({
      session, metrics, env: session.environment, config: { ...idleGapNotifications.defaults },
    });
    expect(findings).toHaveLength(0);
  });
});
