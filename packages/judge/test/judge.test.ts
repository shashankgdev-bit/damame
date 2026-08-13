import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixture } from "@damame/testkit";
import { parseTranscriptFile } from "@damame/adapter-claude-code";
import { computeMetrics } from "@damame/metrics";
import { runRules } from "@damame/rules";
import {
  auditFindings,
  auditorHealth,
  buildExcerpts,
  humanAgreement,
  lastAudits,
  makeHoneypots,
  MockDriver,
  quoteAppears,
} from "../src/index.js";

async function errorLoopSession() {
  const path = fixture()
    .human("fix the parser")
    .editFail("/x.ts")
    .editFail("/x.ts")
    .editFail("/x.ts")
    .editOk("/x.ts")
    .human("now the tests")
    .bashOk("npm test", "all passed")
    .assistantText("done, tests pass")
    .writeTemp();
  const { session } = await parseTranscriptFile(path);
  const metrics = computeMetrics(session);
  const findings = runRules(session, metrics);
  return { session, findings };
}

/** A mock response whose quote really appears in the excerpts of any case. */
const HONEST_YES = (quote: string) =>
  JSON.stringify({ accurate: true, applicable: true, quotes: [quote], reasoning: "supported" });
const HONEST_NO = (quote: string) =>
  JSON.stringify({ accurate: false, applicable: false, quotes: [quote], reasoning: "unsupported" });

describe("judge orchestration (mock driver — no live model)", () => {
  beforeEach(() => {
    process.env.DAMAME_DATA_DIR = mkdtempSync(join(tmpdir(), "damame-judge-"));
  });
  afterEach(() => {
    delete process.env.DAMAME_DATA_DIR;
  });

  it("unanimous valid runs → high-confidence verdict; honeypots injected and scored", async () => {
    const { session, findings } = await errorLoopSession();
    expect(findings.length).toBeGreaterThan(0);
    // Quote something present in every excerpt built from this session:
    const driver = new MockDriver("mock-model", (prompt) =>
      prompt.includes("hp-") || /10|30/.test(prompt.slice(prompt.indexOf("Title:"), prompt.indexOf("Description:")))
        ? HONEST_NO("String to replace not found in file")
        : HONEST_YES("String to replace not found in file"),
    );
    const result = await auditFindings(driver, session, findings, { runs: 3 });
    expect(result.honeypots_total).toBeGreaterThanOrEqual(2);
    const real = result.records.filter((r) => !r.honeypot);
    expect(real.length).toBe(findings.length);
    for (const record of real.filter((r) => r.rule_id === "edit-fail-loop")) {
      expect(record.accurate.answer).toBe(true);
      expect(record.accurate.confidence).toBe("high");
      expect(record.accurate.votes_true).toBe(3);
    }
  });

  it("quote gate discards runs whose quotes are not in the evidence", async () => {
    const { session, findings } = await errorLoopSession();
    const driver = new MockDriver("mock-model", () =>
      JSON.stringify({ accurate: true, applicable: true, quotes: ["this text was never in any transcript"], reasoning: "x" }),
    );
    const result = await auditFindings(driver, session, findings.slice(0, 1), { runs: 3, honeypotEvery: 999 });
    const record = result.records.find((r) => !r.honeypot)!;
    expect(record.runs.every((run) => !run.valid && run.invalid_reason === "quote_gate")).toBe(true);
    expect(record.accurate.answer).toBeNull(); // no valid runs → abstain
  });

  it("2-1 split → low confidence; garbage output → abstention; escalation adds a run", async () => {
    const { session, findings } = await errorLoopSession();
    let call = 0;
    const split = new MockDriver("cheap", () => {
      call += 1;
      if (call % 3 === 0) return HONEST_NO("String to replace not found in file");
      return HONEST_YES("String to replace not found in file");
    });
    const result = await auditFindings(split, session, findings.slice(0, 1), {
      runs: 3,
      honeypotEvery: 999,
      escalateModel: "strong",
    });
    const record = result.records.find((r) => !r.honeypot)!;
    expect(record.escalated).toBe(true);
    expect(record.runs.length).toBe(4); // 3 + escalation
    expect(record.runs[3]!.model).toBe("strong");

    const garbage = new MockDriver("cheap", () => "I think this looks fine to me!");
    const g = await auditFindings(garbage, session, findings.slice(0, 1), { runs: 3, honeypotEvery: 999 });
    expect(g.records.find((r) => !r.honeypot)!.accurate.answer).toBeNull();
  });

  it("honeypot mutations are deterministic and wrong by construction", async () => {
    const { session, findings } = await errorLoopSession();
    const a = makeHoneypots(session, findings, 2);
    const b = makeHoneypots(session, findings, 2);
    expect(JSON.stringify(a.map((h) => h.honeypot_key))).toBe(JSON.stringify(b.map((h) => h.honeypot_key)));
    for (const hp of a) {
      expect(hp.honeypot_key.startsWith("hp-")).toBe(true);
      if (hp.type === "evidence_swap") {
        // swapped evidence must not include the original cited events
        const original = findings.find((f) => f.dedupe_key === hp.base_key)!;
        const originalIds = new Set(original.evidence.events.map((e) => e.event_id));
        expect(hp.finding.evidence.events.every((e) => !originalIds.has(e.event_id))).toBe(true);
      }
    }
  });

  it("health + human agreement compute from stored audits", async () => {
    const { session, findings } = await errorLoopSession();
    const driver = new MockDriver("mock-model", (prompt) =>
      prompt.includes("Title:") && /\b30\b/.test(prompt) ? HONEST_NO("String to replace not found in file") : HONEST_YES("String to replace not found in file"),
    );
    await auditFindings(driver, session, findings, { runs: 3 });

    const health = auditorHealth();
    expect(health).toHaveLength(1);
    expect(health[0]!.series).toBe("mock-model@audit@1");
    expect(health[0]!.audits).toBeGreaterThan(0);
    expect(health[0]!.invalid_run_rate).toBe(0);

    const target = findings[0]!;
    const agreement = humanAgreement(
      new Map([[target.dedupe_key, { accurate: true, applicable: false }]]),
    );
    const row = agreement.find((r) => r.rule_id === target.rule.id)!;
    expect(row.compared_questions).toBe(2);
    expect(row.agreed_questions).toBe(1); // human says applicable=false, mock said true

    expect(lastAudits().get(target.dedupe_key)).toBeDefined();
  });
});

describe("quote gate normalization", () => {
  it("tolerates whitespace differences, rejects short or absent quotes", () => {
    const excerpts = "   #4 [tool_result Edit ERROR sig=edit_string_not_found] Error: String to replace not found in file.";
    expect(quoteAppears("String to replace   not found in file", excerpts)).toBe(true);
    expect(quoteAppears("STRING TO REPLACE NOT FOUND", excerpts)).toBe(true);
    expect(quoteAppears("Error:", excerpts)).toBe(false); // too short to prove anything
    expect(quoteAppears("completely different text", excerpts)).toBe(false);
  });
});

describe("excerpt builder", () => {
  it("marks cited events and includes surrounding context", async () => {
    const { session, findings } = await errorLoopSession();
    const excerpts = buildExcerpts(session, findings[0]!);
    expect(excerpts).toContain(">> ");
    expect(excerpts).toContain("edit_string_not_found");
    expect(excerpts.length).toBeLessThan(10_000);
  });
});
