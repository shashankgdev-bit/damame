import { describe, expect, it } from "vitest";
import type { Finding } from "@damame/ir";
import { computeScore, SCORE_VERSION } from "../src/index.js";

function f(ruleId: string, severity: Finding["severity"], tokens?: number, category = "context-hygiene"): Finding {
  return {
    rule: { id: ruleId, version: "0.1.0" },
    category: category as Finding["category"],
    severity,
    confidence: { source: "deterministic" },
    title: "t",
    description: "d",
    evidence: { events: [{ session_id: "s", event_id: "e" }] },
    ...(tokens ? { savings: { tokens: { value: tokens }, method: "m", basis: "measured" as const } } : {}),
    recommendation: { resource: { kind: "prompting_pattern", ref: "x" }, rationale: "r" },
    dedupe_key: `${ruleId}-${severity}-${tokens ?? 0}`,
  } as Finding;
}

describe("computeScore (score@1)", () => {
  it("clean session scores 100 everywhere", () => {
    const s = computeScore([], 1_000_000);
    expect(s.version).toBe(SCORE_VERSION);
    expect(s.overall).toBe(100);
    expect(s.buckets).toHaveLength(5);
    for (const b of s.buckets) expect(b.score).toBe(100);
    expect(s.capabilities.exercised).toEqual([]);
    expect(s.capabilities.total).toBe(7);
  });

  it("is deterministic: exact expected numbers for a known mix", () => {
    const findings = [
      f("cache-thrash", "major", 200_000),        // hygiene: 25 + min(15, 20)=15 → 40; cost: 20 pts wasted-share
      f("paste-relay", "moderate"),               // redundant: 12
      f("post-edit-ritual", "minor"),             // missed: 5
    ];
    const s = computeScore(findings, 1_000_000);
    const by = Object.fromEntries(s.buckets.map((b) => [b.id, b.score]));
    expect(by["cost-efficiency"]).toBe(80);       // 100 × (1 − 200k/1M)
    expect(by["context-hygiene"]).toBe(60);       // 100 − 40
    expect(by["redundant-work"]).toBe(88);
    expect(by["missed-capabilities"]).toBe(95);
    expect(by["prompting-recovery"]).toBe(100);
    expect(s.overall).toBe(Math.round((80 + 60 + 88 + 95 + 100) / 5));
  });

  it("excludes infra findings entirely", () => {
    const s = computeScore([f("retry-storm", "info", 500_000, "infra"), f("abandoned-work", "info", 400_000, "infra")], 1_000_000);
    expect(s.overall).toBe(100);
  });

  it("floors buckets at 0 and never lets waste exceed 100%", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ ...f("cache-thrash", "major", 300_000), dedupe_key: "k" + i }));
    const s = computeScore(many, 1_000_000);
    const by = Object.fromEntries(s.buckets.map((b) => [b.id, b.score]));
    expect(by["cost-efficiency"]).toBe(0);
    expect(by["context-hygiene"]).toBe(0);
  });

  it("credits capabilities from technique counts without scoring them", () => {
    const s = computeScore([], 1000, { "subagent-delegation": 3, "workflow-orchestration": 1, "unrelated": 5 });
    expect(s.capabilities.exercised).toEqual(["subagents", "workflows"]);
    expect(s.overall).toBe(100); // capabilities never move the overall
  });
});
