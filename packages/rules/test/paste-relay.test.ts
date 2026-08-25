import { describe, expect, it } from "vitest";
import { fixture, type TranscriptBuilder } from "@damame/testkit";
import { parseTranscriptFile } from "@damame/adapter-claude-code";
import { computeMetrics } from "@damame/metrics";
import { pasteRelay } from "../src/detectors/paste-relay.js";
import type { Finding } from "@damame/ir";

async function run(builderResult: string): Promise<Finding[]> {
  const { session } = await parseTranscriptFile(builderResult);
  const metrics = computeMetrics(session);
  return pasteRelay.detect({
    session,
    metrics,
    env: session.environment,
    config: { ...pasteRelay.defaults },
  });
}

/** n hand-pasted verdict blocks sharing a template prefix, each ~(33 + bytesEach) chars. */
function pastes(b: TranscriptBuilder, n: number, bytesEach = 2_600): TranscriptBuilder {
  for (let i = 0; i < n; i++) {
    b.human(`Difficulty: ${i + 1} | Reviewer verdict\n` + "x".repeat(bytesEach));
    b.assistantText("Recorded that block.");
  }
  return b;
}

describe("paste-relay", () => {
  it("fires at 6 similar large pastes crossing the total-bytes threshold", async () => {
    const path = pastes(fixture().human("I'll paste each verdict as I collect it"), 6).writeTemp();
    const findings = await run(path);
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.rule.id).toBe("paste-relay");
    expect(f.category).toBe("missed-resource");
    expect(f.confidence.source).toBe("deterministic");
    expect(f.severity).toBe("moderate");
    expect(f.evidence.events).toHaveLength(6);
    expect(f.evidence.metrics?.occurrences).toBe(6);
    expect(f.evidence.metrics?.total_bytes).toBe(6 * (2_600 + 33));
    expect(typeof f.evidence.metrics?.signature).toBe("string");
    // No savings block: human ferrying time is not defensibly measurable.
    expect(f.savings).toBeUndefined();
    expect(f.recommendation.resource.kind).toBe("prompting_pattern");
    expect(f.recommendation.resource.ref).toBe("automate-data-ingestion");
    expect(f.dedupe_key).toHaveLength(16);
  });

  it("groups pastes whose numbers differ in digit width (digit runs normalize to #)", async () => {
    const b = fixture().human("verdicts incoming");
    for (const n of [1, 23, 456, 7_890, 5, 12]) {
      b.human(`Difficulty: ${n} | Reviewer verdict\n` + "x".repeat(2_600));
      b.assistantText("Recorded that block.");
    }
    const findings = await run(b.writeTemp());
    expect(findings).toHaveLength(1);
    expect(findings[0]!.evidence.metrics?.occurrences).toBe(6);
  });

  it("escalates to major at 3x min_occurrences and caps evidence at 8 events", async () => {
    const path = pastes(fixture().human("relay session"), 18).writeTemp();
    const findings = await run(path);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("major");
    expect(findings[0]!.evidence.events).toHaveLength(8);
    expect(findings[0]!.evidence.metrics?.occurrences).toBe(18);
  });

  it("does NOT fire at 5 similar pastes (one under min_occurrences)", async () => {
    const path = pastes(fixture().human("relay session"), 5, 3_200).writeTemp();
    expect(await run(path)).toHaveLength(0);
  });

  it("does NOT fire when 6 similar pastes stay under min_total_bytes", async () => {
    // 6 x ~833 bytes ≈ 5k total — each over min_paste_bytes, sum well under 15k.
    const path = pastes(fixture().human("relay session"), 6, 800).writeTemp();
    expect(await run(path)).toHaveLength(0);
  });

  it("does NOT fire on unrelated large pastes with no shared shape (look-alike)", async () => {
    const b = fixture().human("here comes assorted context");
    const openers = [
      "Stack trace from prod",
      "Customer email thread",
      "Config dump from staging",
      "Meeting notes for review",
      "Raw CSV export sample",
      "Terraform plan output",
    ];
    for (const opener of openers) {
      b.human(`${opener}:\n` + "x".repeat(3_000));
      b.assistantText("Got it.");
    }
    expect(await run(b.writeTemp())).toHaveLength(0);
  });

  it("does NOT count repeated small messages toward a group", async () => {
    const b = fixture().human("short updates");
    for (let i = 0; i < 10; i++) {
      b.human(`Difficulty: ${i + 1} | Reviewer verdict\n` + "x".repeat(100));
      b.assistantText("Noted.");
    }
    expect(await run(b.writeTemp())).toHaveLength(0);
  });

  it("is idempotent: same session → same dedupe keys", async () => {
    const path = pastes(fixture().human("relay"), 7).writeTemp();
    const [a, b] = [await run(path), await run(path)];
    expect(a.map((f) => f.dedupe_key)).toEqual(b.map((f) => f.dedupe_key));
  });
});
