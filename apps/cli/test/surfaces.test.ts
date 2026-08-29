import { describe, expect, it } from "vitest";
import { fixture } from "@damame/testkit";
import { parseTranscriptFile } from "@damame/adapter-claude-code";
import { computeMetrics } from "@damame/metrics";
import { runRules } from "@damame/rules";
import { buildSurfaces } from "../src/surfaces.js";

async function surfacesFor(path: string) {
  const { session } = await parseTranscriptFile(path);
  const findings = runRules(session, computeMetrics(session));
  return { surfaces: buildSurfaces(session, findings), findings, session };
}

/** A session with a post-edit ritual (fixable), compaction rework (coach), and a retry storm (infra). */
function richFixture() {
  const b = fixture().human("start");
  // ritual: same command after 11 edits
  for (let i = 0; i < 11; i++) {
    b.editOk(`/proj/f${i}.ts`);
    b.bashOk("npm test", "ok");
  }
  // compaction rework: 3 reads, compaction, identical re-reads
  for (let i = 0; i < 3; i++) b.readOk(`/proj/src/m${i}.ts`, 30_000);
  b.assistantText("loaded").compactBoundary().human("continue");
  for (let i = 0; i < 3; i++) b.readOk(`/proj/src/m${i}.ts`, 30_000);
  // infra: transient API errors
  for (let i = 0; i < 3; i++) b.apiError(i + 1, 4000);
  b.assistantText("done").lastPrompt();
  return b.writeTemp();
}

describe("buildSurfaces", () => {
  it("routes fixable rules to fixes[], groups coach votes, and separates infra", async () => {
    const { surfaces } = await surfacesFor(richFixture());
    // ritual is tier-1 fixable, not a coach card
    expect(surfaces.fixes.some((f) => f.rule_id === "post-edit-ritual")).toBe(true);
    expect(surfaces.fixes[0]!.destination).toContain("hook");
    // compaction-rework votes into the session-hygiene coach card
    const hygiene = surfaces.coach.find((c) => c.id === "session-hygiene");
    expect(hygiene).toBeDefined();
    expect(hygiene!.votes).toContain("compaction-rework");
    expect(hygiene!.recipe?.ref).toBe("session-per-task-bootstrap");
    expect(["quality", "time", "limits"]).toContain(hygiene!.impact);
    // infra stays out of receipts and coach, lands in not_yours
    expect(surfaces.receipts.some((r) => r.rule_id === "retry-storm")).toBe(false);
    expect(surfaces.not_yours.length).toBeGreaterThan(0);
    // coach capped at 3
    expect(surfaces.coach.length).toBeLessThanOrEqual(3);
  });

  it("every receipt carries a currency and a proof line with the rule version", async () => {
    const { surfaces } = await surfacesFor(richFixture());
    for (const r of surfaces.receipts) {
      expect(["quality", "time", "limits"]).toContain(r.currency);
      expect(r.proof).toContain(`${r.rule_id}@`);
    }
  });

  it("coach recipes resolve to registry entries with provenance", async () => {
    const { surfaces } = await surfacesFor(richFixture());
    for (const c of [...surfaces.coach, ...surfaces.coach_more]) {
      expect(c.recipe).not.toBeNull();
      expect(["verified", "candidate"]).toContain(c.recipe!.status);
    }
  });
});
