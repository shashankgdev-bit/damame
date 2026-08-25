import type { Finding } from "@damame/ir";

/**
 * The validated session score: a summary LENS over findings — never an input
 * to anything, never a replacement for the findings themselves. Every number
 * here is recomputable by hand from published formulas (docs/score.md), the
 * corpus ordering gate proves planted waste lowers it and innocence doesn't,
 * and any change to formulas or bucket membership bumps SCORE_VERSION
 * (comparability resets, same discipline as rules).
 */
export const SCORE_VERSION = "score@1";

/** Explicit, versioned bucket membership — never inferred. */
const BUCKET_RULES: Record<string, string[]> = {
  "context-hygiene": ["cache-thrash", "compaction-burn", "eternal-session", "oversized-context-reads"],
  "redundant-work": ["duplicate-tool-call", "paste-relay"],
  "missed-capabilities": ["missed-delegation", "repeated-delegation", "idle-gap-notifications", "post-edit-ritual"],
  "prompting-recovery": ["abandoned-work", "edit-fail-loop", "bash-error-loop", "permission-churn"],
};

const BUCKET_LABELS: Record<string, string> = {
  "cost-efficiency": "Cost efficiency",
  "context-hygiene": "Context hygiene",
  "redundant-work": "Redundant work",
  "missed-capabilities": "Missed capabilities",
  "prompting-recovery": "Prompting & recovery",
};

const SEVERITY_POINTS: Record<string, number> = { major: 25, moderate: 12, minor: 5, info: 0 };

/** The 7 leverage capabilities credited (never penalized) — technique ids
 * from the profile's detector, plus a plain label each. */
export const CAPABILITIES: Array<{ technique: string; label: string }> = [
  { technique: "subagent-delegation", label: "subagents" },
  { technique: "workflow-orchestration", label: "workflows" },
  { technique: "custom-skills", label: "skills" },
  { technique: "plan-mode-first", label: "plan mode" },
  { technique: "background-tasks", label: "background tasks" },
  { technique: "claude-md", label: "memory files" },
  { technique: "hooks", label: "hooks" },
];

export interface ScorePenalty {
  rule_id: string;
  severity: string;
  points: number;
  dedupe_key: string;
}

export interface ScoreBucket {
  id: string;
  label: string;
  score: number;
  penalties: ScorePenalty[];
}

export interface SessionScore {
  version: string;
  overall: number;
  buckets: ScoreBucket[];
  capabilities: { exercised: string[]; total: number };
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

export function computeScore(
  findings: Finding[],
  totalTokens: number,
  techniqueCounts: Record<string, number> = {},
): SessionScore {
  const scored = findings.filter((f) => f.category !== "infra");

  // Cost efficiency: pure measured formula, independent of severities.
  const wasted = scored.reduce((sum, f) => sum + (f.savings?.tokens?.value ?? 0), 0);
  const costEfficiency: ScoreBucket = {
    id: "cost-efficiency",
    label: BUCKET_LABELS["cost-efficiency"]!,
    score: totalTokens > 0 ? clamp(100 * (1 - wasted / totalTokens)) : 100,
    penalties: scored
      .filter((f) => (f.savings?.tokens?.value ?? 0) > 0)
      .map((f) => ({
        rule_id: f.rule.id,
        severity: f.severity,
        points: totalTokens > 0 ? Math.round((100 * (f.savings!.tokens!.value ?? 0)) / totalTokens) : 0,
        dedupe_key: f.dedupe_key,
      })),
  };

  const buckets: ScoreBucket[] = [costEfficiency];
  for (const [bucketId, ruleIds] of Object.entries(BUCKET_RULES)) {
    const members = scored.filter((f) => ruleIds.includes(f.rule.id));
    const penalties: ScorePenalty[] = members.map((f) => {
      const base = SEVERITY_POINTS[f.severity] ?? 0;
      const magnitude =
        f.savings?.tokens?.value && totalTokens > 0
          ? Math.min(15, Math.round((100 * f.savings.tokens.value) / totalTokens))
          : 0;
      return { rule_id: f.rule.id, severity: f.severity, points: base + magnitude, dedupe_key: f.dedupe_key };
    });
    buckets.push({
      id: bucketId,
      label: BUCKET_LABELS[bucketId]!,
      score: clamp(100 - penalties.reduce((s, p) => s + p.points, 0)),
      penalties,
    });
  }

  const overall = clamp(buckets.reduce((s, b) => s + b.score, 0) / buckets.length);
  const exercised = CAPABILITIES.filter((c) => (techniqueCounts[c.technique] ?? 0) > 0).map((c) => c.label);

  return {
    version: SCORE_VERSION,
    overall,
    buckets,
    capabilities: { exercised, total: CAPABILITIES.length },
  };
}
