import { describe, expect, it } from "vitest";
import { fixture } from "../../testkit/src/index.js";
import { parseTranscriptFile } from "@damame/adapter-claude-code";
import { computeMetrics } from "@damame/metrics";
import type { Finding, GradingVersion } from "@damame/ir";
import { renderHtmlReport } from "../src/index.js";

const grading: GradingVersion = {
  damame_version: "0.1.0",
  ir_version: "0.1.0",
  adapter: "claude-code",
  adapter_version: "0.1.0",
  rule_versions: { "edit-fail-loop": "0.1.0" },
};

describe("renderHtmlReport", () => {
  it("renders facts, findings with method/basis, escaped content, and grading", async () => {
    const path = fixture()
      .skillListing(["dataviz"])
      .human("hello <script>alert(1)</script>")
      .assistantText("hi")
      .editFail("/x.ts")
      .writeTemp();
    const { session } = await parseTranscriptFile(path);
    session.title = "Fixture <script>bad</script> session";
    const metrics = computeMetrics(session);
    const finding: Finding = {
      rule: { id: "edit-fail-loop", version: "0.1.0" },
      category: "error-loop",
      severity: "moderate",
      confidence: { source: "deterministic" },
      title: "Example finding <script>x</script>",
      description: "The mechanism.",
      evidence: { events: [{ session_id: session.id, event_id: session.events[0]!.event_id }] },
      savings: { tokens: { value: 1234 }, method: "sum of deduped retry usage", basis: "measured" },
      recommendation: { resource: { kind: "prompting_pattern", ref: "read-before-edit" }, rationale: "why" },
      dedupe_key: "abcd1234abcd1234",
    };

    const html = renderHtmlReport({ session, metrics, findings: [finding], grading });
    expect(html.toLowerCase()).toContain("<!doctype html>");
    expect(html).toContain("sum of deduped retry usage");
    expect(html).toContain("measured");
    expect(html).toContain("read-before-edit");
    expect(html).toContain("damame 0.1.0");
    // untrusted content must be escaped
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<script>bad</script>");
    expect(html).not.toContain("<script>x</script>");
  });

  it("renders an empty state when no findings fire", async () => {
    const path = fixture().human("hi").assistantText("hello").writeTemp();
    const { session } = await parseTranscriptFile(path);
    const html = renderHtmlReport({ session, metrics: computeMetrics(session), findings: [], grading });
    expect(html.toLowerCase()).toContain("no rule fired");
  });
});
