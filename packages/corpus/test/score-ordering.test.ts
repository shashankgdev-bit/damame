import { describe, expect, it } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTranscriptFile } from "@damame/adapter-claude-code";
import { computeMetrics } from "@damame/metrics";
import { runRules } from "@damame/rules";
import { computeScore } from "@damame/score";
import { generateCorpus } from "../src/index.js";

/**
 * THE score validity gate: a score is only trustworthy if planted waste
 * provably lowers it and innocence provably doesn't. Every positive archetype
 * must score below the clean archetype overall; clean and negative archetypes
 * must stay high. A failure names the archetype+seed to reproduce.
 */
describe("score ordering on the ground-truth corpus (score@1)", () => {
  it("planted waste scores below clean; innocence stays high", async () => {
    const corpus = generateCorpus(2, 7);
    const dir = mkdtempSync(join(tmpdir(), "damame-score-"));
    const scores = new Map<string, number[]>();

    for (const item of corpus) {
      const path = join(dir, `${item.manifest.archetype}-${item.manifest.seed}.jsonl`);
      writeFileSync(path, item.jsonl);
      const { session } = await parseTranscriptFile(path);
      const metrics = computeMetrics(session);
      const findings = runRules(session, metrics);
      const fresh =
        (metrics.totals.usage.input_tokens ?? 0) +
        (metrics.totals.usage.output_tokens ?? 0) +
        (metrics.totals.usage.cache_creation_input_tokens ?? 0);
      const score = computeScore(findings, fresh);
      const list = scores.get(item.manifest.archetype) ?? [];
      list.push(score.overall);
      scores.set(item.manifest.archetype, list);
    }

    const worstOf = (archetype: string) => Math.min(...(scores.get(archetype) ?? [100]));
    const cleanWorst = worstOf("clean");
    expect(cleanWorst, "clean archetype must score ≥ 95").toBeGreaterThanOrEqual(95);

    // Rules whose findings are provider-side (category "infra") are excluded
    // from the score BY DESIGN — archetypes planting only those must stay
    // high, not low: scoring them down would blame infrastructure.
    const INFRA_RULES = new Set(["retry-storm"]);
    for (const item of corpus) {
      const { archetype, expected } = item.manifest;
      if (archetype === "clean") continue;
      const worst = worstOf(archetype);
      const plantsUserWaste = expected.some((r) => !INFRA_RULES.has(r));
      if (plantsUserWaste) {
        expect(worst, `positive archetype ${archetype} must score below clean`).toBeLessThan(cleanWorst);
      } else {
        expect(worst, `${archetype} (negative or infra-only) must stay ≥ 90`).toBeGreaterThanOrEqual(90);
      }
    }
  });
});
