import { appendFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Finding, Session } from "@damame/ir";
import { fixture } from "@damame/testkit";
import { dataDir, feedbackStats, indexFindings, lastAnswers, recordAnswer } from "../src/feedback.js";
import { computeRecurrence } from "../src/recurrence.js";

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

describe("split feedback (accurate / applicable)", () => {
  beforeEach(() => {
    process.env.DAMAME_DATA_DIR = mkdtempSync(join(tmpdir(), "damame-feedback-"));
  });
  afterEach(() => {
    delete process.env.DAMAME_DATA_DIR;
  });

  it("indexes findings idempotently", () => {
    const findings = [fakeFinding("aaaa000000000001"), fakeFinding("bbbb000000000002")];
    expect(indexFindings(fakeSession(), findings)).toBe(2);
    expect(indexFindings(fakeSession(), findings)).toBe(0);
  });

  it("records per-question answers; questions are independent", () => {
    indexFindings(fakeSession(), [fakeFinding("aaaa000000000001")]);
    expect(recordAnswer("aaaa", "accurate", true).ok).toBe(true);
    expect(recordAnswer("aaaa", "applicable", false).ok).toBe(true);

    const state = lastAnswers().get("aaaa000000000001")!;
    expect(state.accurate).toBe(true);
    expect(state.applicable).toBe(false);

    const stats = feedbackStats().find((s) => s.rule_id === "edit-fail-loop")!;
    expect(stats.factual_precision).toBe(1);
    expect(stats.applicability_rate).toBe(0);
  });

  it("last answer per question wins; ambiguous prefixes rejected", () => {
    indexFindings(fakeSession(), [fakeFinding("cccc000000000001"), fakeFinding("cccc000000000002")]);
    const ambiguous = recordAnswer("cccc", "accurate", true);
    expect(ambiguous.ok).toBe(false);

    expect(recordAnswer("cccc000000000001", "accurate", false).ok).toBe(true);
    expect(recordAnswer("cccc000000000001", "accurate", true).ok).toBe(true); // changed their mind
    expect(lastAnswers().get("cccc000000000001")!.accurate).toBe(true);
  });

  it("legacy v1 verdicts map onto the question model", () => {
    indexFindings(fakeSession(), [
      fakeFinding("dddd000000000001"),
      fakeFinding("eeee000000000002"),
      fakeFinding("ffff000000000003"),
    ]);
    // hand-write legacy-format entries as the old version would have
    const legacy = [
      { dedupe_key: "dddd000000000001", rule_id: "edit-fail-loop", rule_series: "0.1", verdict: "helpful", at: "2026-08-01T00:00:00Z" },
      { dedupe_key: "eeee000000000002", rule_id: "edit-fail-loop", rule_series: "0.1", verdict: "wrong", at: "2026-08-01T00:00:00Z" },
      { dedupe_key: "ffff000000000003", rule_id: "edit-fail-loop", rule_series: "0.1", verdict: "not-actionable", at: "2026-08-01T00:00:00Z" },
    ];
    mkdirSync(dataDir(), { recursive: true });
    appendFileSync(join(dataDir(), "feedback.jsonl"), legacy.map((l) => JSON.stringify(l)).join("\n") + "\n");

    const answers = lastAnswers();
    expect(answers.get("dddd000000000001")).toEqual({ accurate: true, applicable: true });
    expect(answers.get("eeee000000000002")).toEqual({ accurate: false, applicable: null });
    expect(answers.get("ffff000000000003")).toEqual({ accurate: null, applicable: false });

    const stats = feedbackStats().find((s) => s.rule_id === "edit-fail-loop")!;
    expect(stats.accurate_yes).toBe(1);
    expect(stats.accurate_no).toBe(1);
    expect(stats.factual_precision).toBe(0.5);
  });
});

describe("recurrence (behavioral eval)", () => {
  beforeEach(() => {
    process.env.DAMAME_DATA_DIR = mkdtempSync(join(tmpdir(), "damame-recurrence-"));
  });
  afterEach(() => {
    delete process.env.DAMAME_DATA_DIR;
  });

  function candidate(path: string, id: string) {
    return { path, sessionId: id, projectDir: "p", sizeBytes: 1000, modifiedAt: new Date() };
  }

  it("pattern stops after surfacing → improving; needs history on both sides", async () => {
    // session A (before): edit-fail loop fires. Fixture clock starts 2026-08-01.
    const pathA = fixture("aaaaaaaa-0000-4000-8000-000000000001", "2026-08-01T10:00:00.000Z")
      .human("fix")
      .editFail("/x.ts")
      .editFail("/x.ts")
      .editFail("/x.ts")
      .writeTemp();
    // session B (after): clean, several human turns
    const pathB = fixture("bbbbbbbb-0000-4000-8000-000000000002", "2026-08-05T10:00:00.000Z")
      .human("next task")
      .assistantText("ok")
      .editOk("/x.ts")
      .human("more")
      .assistantText("done")
      .writeTemp();

    // surfaced between the two sessions
    mkdirSync(dataDir(), { recursive: true });
    appendFileSync(
      join(dataDir(), "findings-index.jsonl"),
      JSON.stringify({
        dedupe_key: "k000000000000001",
        rule_id: "edit-fail-loop",
        rule_version: "0.1.0",
        session_id: "aaaaaaaa-0000-4000-8000-000000000001",
        title: "t",
        first_seen: "2026-08-03T00:00:00Z",
      }) + "\n",
    );

    const result = await computeRecurrence([candidate(pathA, "a"), candidate(pathB, "b")]);
    const efl = result.find((r) => r.rule_id === "edit-fail-loop")!;
    expect(efl.sessions_before).toBe(1);
    expect(efl.sessions_after).toBe(1);
    expect(efl.rate_before).toBeGreaterThan(0);
    expect(efl.rate_after).toBe(0);
    expect(efl.verdict).toBe("improving");
    expect(efl.change_pct).toBe(-100);

    // only one side of history → insufficient
    const onlyAfter = await computeRecurrence([candidate(pathB, "b")]);
    expect(onlyAfter.find((r) => r.rule_id === "edit-fail-loop")!.verdict).toBe("insufficient_history");
  });
});
