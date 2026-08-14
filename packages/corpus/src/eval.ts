import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTranscriptFile } from "@damame/adapter-claude-code";
import { computeMetrics } from "@damame/metrics";
import { runRules } from "@damame/rules";
import { ARCHETYPES, rng, type GeneratedSession, type Manifest } from "./archetypes.js";

/**
 * Session-level ground-truth eval: for each generated session, did every
 * expected rule fire (recall) and did every forbidden rule stay silent
 * (precision)? Detectors are deterministic, so the CI gate demands perfection
 * on this corpus — a single miss or false positive is a regression.
 */
export interface RuleScore {
  rule_id: string;
  expected_sessions: number;
  fired_when_expected: number;
  forbidden_sessions: number;
  false_positives: number;
  recall: number | null;
  precision: number | null;
}

export interface CorpusEvalResult {
  sessions: number;
  scores: RuleScore[];
  failures: Array<{ archetype: string; seed: number; kind: "missed" | "false_positive"; rule: string }>;
}

export function generateCorpus(perArchetype: number, baseSeed = 1): GeneratedSession[] {
  const out: GeneratedSession[] = [];
  const seeder = rng(baseSeed);
  for (const [name, make] of Object.entries(ARCHETYPES)) {
    for (let i = 0; i < perArchetype; i++) {
      out.push(make(Math.floor(seeder() * 1_000_000) + i));
      void name;
    }
  }
  return out;
}

export async function evaluateCorpus(corpus: GeneratedSession[]): Promise<CorpusEvalResult> {
  const dir = mkdtempSync(join(tmpdir(), "damame-corpus-"));
  const perRule = new Map<string, RuleScore>();
  const failures: CorpusEvalResult["failures"] = [];

  const score = (rule: string): RuleScore => {
    const existing = perRule.get(rule);
    if (existing) return existing;
    const fresh: RuleScore = {
      rule_id: rule,
      expected_sessions: 0,
      fired_when_expected: 0,
      forbidden_sessions: 0,
      false_positives: 0,
      recall: null,
      precision: null,
    };
    perRule.set(rule, fresh);
    return fresh;
  };

  for (let i = 0; i < corpus.length; i++) {
    const generated = corpus[i]!;
    const path = join(dir, `s${i}.jsonl`);
    writeFileSync(path, generated.jsonl);
    const { session } = await parseTranscriptFile(path);
    const findings = runRules(session, computeMetrics(session));
    const fired = new Set(findings.map((f) => f.rule.id));
    const manifest: Manifest = generated.manifest;

    for (const rule of manifest.expected) {
      const s = score(rule);
      s.expected_sessions += 1;
      if (fired.has(rule)) s.fired_when_expected += 1;
      else failures.push({ archetype: manifest.archetype, seed: manifest.seed, kind: "missed", rule });
    }
    for (const rule of manifest.forbidden) {
      const s = score(rule);
      s.forbidden_sessions += 1;
      if (fired.has(rule)) {
        s.false_positives += 1;
        failures.push({ archetype: manifest.archetype, seed: manifest.seed, kind: "false_positive", rule });
      }
    }
  }

  for (const s of perRule.values()) {
    s.recall = s.expected_sessions > 0 ? s.fired_when_expected / s.expected_sessions : null;
    const negatives = s.forbidden_sessions;
    s.precision =
      s.fired_when_expected + s.false_positives > 0
        ? s.fired_when_expected / (s.fired_when_expected + s.false_positives)
        : negatives > 0 && s.false_positives === 0
          ? 1
          : null;
  }

  return {
    sessions: corpus.length,
    scores: [...perRule.values()].sort((a, b) => a.rule_id.localeCompare(b.rule_id)),
    failures,
  };
}
