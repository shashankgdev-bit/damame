import { describe, expect, it } from "vitest";
import { evaluateCorpus, generateCorpus } from "../src/index.js";

/**
 * THE ground-truth gate. Detectors are deterministic and every planted
 * pattern is above threshold by construction, so this corpus tolerates
 * nothing: recall 1.0 on every planted rule, zero false positives anywhere.
 * A failure here names the archetype+seed to reproduce it exactly.
 */
describe("synthetic ground-truth corpus", () => {
  it("60-session seeded corpus: perfect recall on planted patterns, zero false positives", async () => {
    const corpus = generateCorpus(4, 42); // 4 per archetype × 15 archetypes
    const result = await evaluateCorpus(corpus);
    expect(result.sessions).toBeGreaterThanOrEqual(56);

    const detail = result.failures
      .map((f) => `${f.kind}: ${f.rule} in ${f.archetype}#${f.seed}`)
      .join("\n");
    expect(result.failures, detail).toHaveLength(0);

    for (const score of result.scores) {
      if (score.expected_sessions > 0) expect(score.recall, score.rule_id).toBe(1);
      expect(score.false_positives, score.rule_id).toBe(0);
    }
  });

  it("corpus generation is deterministic (same seed → identical sessions)", () => {
    const a = generateCorpus(2, 7);
    const b = generateCorpus(2, 7);
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(a[i]!.jsonl).toBe(b[i]!.jsonl);
      expect(a[i]!.manifest).toEqual(b[i]!.manifest);
    }
  });
});
