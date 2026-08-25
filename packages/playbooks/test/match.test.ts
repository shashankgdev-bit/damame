import { describe, expect, it } from "vitest";
import type { Finding } from "@damame/ir";
import { matchPlaybooks, PLAYBOOKS } from "../src/index.js";

function finding(ruleId: string, key: string): Finding {
  return {
    rule: { id: ruleId, version: "0.1.0" },
    category: "context-hygiene",
    severity: "moderate",
    confidence: { source: "deterministic" },
    title: "t",
    description: "d",
    evidence: { events: [{ session_id: "s", event_id: "e1" }] },
    recommendation: { resource: { kind: "prompting_pattern", ref: "x" }, rationale: "r" },
    dedupe_key: key,
  } as Finding;
}

describe("playbook matching", () => {
  it("ships schema-valid playbooks", () => {
    expect(PLAYBOOKS.length).toBeGreaterThanOrEqual(1);
    expect(PLAYBOOKS[0]!.id).toBe("repetitive-task-production");
  });

  it("matches by exact tag and renders only evidenced entries", () => {
    const findings = [finding("paste-relay", "k1")];
    const matches = matchPlaybooks(["repetitive-task-production"], findings);
    expect(matches).toHaveLength(1);
    const m = matches[0]!;
    expect(m.matched_by).toEqual(["tags"]);
    expect(m.evidenced).toHaveLength(1);
    expect(m.evidenced[0]!.entry.id).toBe("automate-verdict-ingestion");
    expect(m.evidenced[0]!.finding_keys).toEqual(["k1"]);
    // narrative + unfired-signature entries stay reference-only
    expect(m.unevidenced.length).toBe(PLAYBOOKS[0]!.entries.length - 1);
  });

  it("matches by keyword-containing tag", () => {
    const findings = [finding("eternal-session", "k2")];
    const matches = matchPlaybooks(["nightly-benchmark-pipeline"], findings);
    expect(matches).toHaveLength(1);
  });

  it("matches with no tags at all via the two-signature quorum", () => {
    const findings = [finding("paste-relay", "a"), finding("repeated-delegation", "b")];
    const matches = matchPlaybooks([], findings);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.matched_by).toEqual(["signatures"]);
    expect(matches[0]!.evidenced).toHaveLength(2);
  });

  it("does not match on one fired signature without a tag (no quorum)", () => {
    const findings = [finding("paste-relay", "a")];
    expect(matchPlaybooks([], findings)).toHaveLength(0);
  });

  it("does not match a tagged session with zero evidenced entries", () => {
    expect(matchPlaybooks(["repetitive-task-production"], [])).toHaveLength(0);
  });

  it("never surfaces a narrative entry as evidenced", () => {
    const findings = PLAYBOOKS[0]!.entries.flatMap((e) =>
      e.evidence.kind === "signature" ? [finding(e.evidence.rule_id, e.id)] : [],
    );
    const matches = matchPlaybooks(["repetitive-task-production"], findings);
    const evidencedIds = matches[0]!.evidenced.map((e) => e.entry.id);
    expect(evidencedIds).not.toContain("precheck-script-from-rejections");
    expect(evidencedIds).not.toContain("submission-queue-file");
  });
});
