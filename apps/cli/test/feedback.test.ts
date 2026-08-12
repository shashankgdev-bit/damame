import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Finding, Session } from "@damame/ir";
import { feedbackStats, indexFindings, recordFeedback } from "../src/feedback.js";

function fakeSession(id = "s1"): Session {
  return {
    id,
    ir_version: "0.1.0",
    source: { tool: "claude-code", adapter: "claude-code", adapter_version: "0.1.0" },
    turns: [],
    events: [],
  };
}

function fakeFinding(key: string, ruleId = "edit-fail-loop", version = "0.1.0"): Finding {
  return {
    rule: { id: ruleId, version },
    category: "error-loop",
    severity: "moderate",
    confidence: { source: "deterministic" },
    title: `finding ${key}`,
    description: "d",
    evidence: { events: [{ session_id: "s1", event_id: "e1" }] },
    recommendation: { resource: { kind: "prompting_pattern", ref: "x" }, rationale: "r" },
    dedupe_key: key,
  };
}

describe("feedback loop", () => {
  beforeEach(() => {
    process.env.DAMAME_DATA_DIR = mkdtempSync(join(tmpdir(), "damame-feedback-"));
  });
  afterEach(() => {
    delete process.env.DAMAME_DATA_DIR;
  });

  it("indexes findings idempotently", () => {
    const session = fakeSession();
    const findings = [fakeFinding("aaaa000000000001"), fakeFinding("bbbb000000000002")];
    expect(indexFindings(session, findings)).toBe(2);
    expect(indexFindings(session, findings)).toBe(0); // re-analyze → no dupes
  });

  it("records a verdict via unique key prefix and computes precision", () => {
    indexFindings(fakeSession(), [
      fakeFinding("aaaa000000000001"),
      fakeFinding("bbbb000000000002"),
      fakeFinding("bbbb000000000003", "cache-thrash"),
    ]);
    const ok = recordFeedback("aaaa", "helpful");
    expect(ok.ok).toBe(true);

    const ambiguous = recordFeedback("bbbb", "wrong");
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) expect(ambiguous.error).toContain("ambiguous");

    expect(recordFeedback("bbbb000000000002", "wrong").ok).toBe(true);
    expect(recordFeedback("zzzz", "helpful").ok).toBe(false);

    const stats = feedbackStats();
    const efl = stats.find((s) => s.rule_id === "edit-fail-loop")!;
    expect(efl.emitted).toBe(2);
    expect(efl.helpful).toBe(1);
    expect(efl.wrong).toBe(1);
    expect(efl.precision).toBe(0.5);
    const ct = stats.find((s) => s.rule_id === "cache-thrash")!;
    expect(ct.precision).toBeNull(); // unjudged
  });

  it("last verdict wins and not-actionable is excluded from precision", () => {
    indexFindings(fakeSession(), [fakeFinding("cccc000000000001")]);
    recordFeedback("cccc", "wrong");
    recordFeedback("cccc", "helpful"); // user changed their mind
    let stats = feedbackStats().find((s) => s.rule_id === "edit-fail-loop")!;
    expect(stats.precision).toBe(1);

    recordFeedback("cccc", "not-actionable");
    stats = feedbackStats().find((s) => s.rule_id === "edit-fail-loop")!;
    expect(stats.precision).toBeNull();
    expect(stats.not_actionable).toBe(1);
  });

  it("separates precision series across rule minor versions", () => {
    indexFindings(fakeSession(), [
      fakeFinding("dddd000000000001", "edit-fail-loop", "0.1.0"),
      fakeFinding("eeee000000000002", "edit-fail-loop", "0.2.0"),
    ]);
    recordFeedback("dddd", "helpful");
    recordFeedback("eeee", "wrong");
    const stats = feedbackStats().filter((s) => s.rule_id === "edit-fail-loop");
    expect(stats).toHaveLength(2);
    expect(stats.find((s) => s.rule_series === "0.1")!.precision).toBe(1);
    expect(stats.find((s) => s.rule_series === "0.2")!.precision).toBe(0);
  });
});
