import type { Finding, Session } from "@damame/ir";
import type { MetricsBundle } from "@damame/metrics";
import { detectTechniques } from "./techniques.js";
import { TECHNIQUE_BY_ID } from "./techniques.js";
import { SKILLS, skillForRule, type SkillId } from "./taxonomy.js";

/**
 * The per-session skills lens: for THIS session, which skills were exercised,
 * which had scope that went unused ("this session could have been better
 * if…"), and which simply weren't called for. Sentences are plain language;
 * every miss links back to its finding card via dedupe_key.
 */
export interface SessionSkillEntry {
  skill: SkillId;
  title: string;
  /** "used" | "missed" | "mixed" | "not_needed" */
  verdict: "used" | "missed" | "mixed" | "not_needed";
  sentence: string;
  used_techniques: Array<{ id: string; title: string; count: number }>;
  miss_keys: string[];
}

export function sessionSkills(session: Session, metrics: MetricsBundle, findings: Finding[]): SessionSkillEntry[] {
  const techniques = detectTechniques(session, metrics);
  const out: SessionSkillEntry[] = [];

  for (const def of SKILLS) {
    const used = def.use_techniques
      .map((id) => ({ id, title: TECHNIQUE_BY_ID.get(id)?.title ?? id, count: techniques[id] ?? 0 }))
      .filter((t) => t.count > 0);
    const misses = findings.filter((f) => skillForRule(f.rule.id) === def.id);
    const missKeys = misses.map((f) => f.dedupe_key);

    let verdict: SessionSkillEntry["verdict"];
    let sentence: string;
    if (used.length > 0 && misses.length === 0) {
      verdict = "used";
      sentence = `${def.title} was exercised here: ${used.map((t) => `${t.title.toLowerCase()} (${t.count}×)`).join(", ")}.`;
    } else if (used.length > 0 && misses.length > 0) {
      verdict = "mixed";
      sentence = `${def.title} was partly used, but ${misses.length} ${misses.length === 1 ? "opportunity" : "opportunities"} went unused — see the linked ${misses.length === 1 ? "finding" : "findings"}.`;
    } else if (misses.length > 0) {
      verdict = "missed";
      sentence = betterIfSentence(def.id, misses);
    } else {
      verdict = "not_needed";
      sentence = `Nothing in this session called for ${def.title.toLowerCase()} — that's fine.`;
    }

    out.push({ skill: def.id, title: def.title, verdict, sentence, used_techniques: used, miss_keys: missKeys });
  }

  // Order: missed/mixed first (actionable), then used, then not_needed.
  const order = { missed: 0, mixed: 1, used: 2, not_needed: 3 } as const;
  return out.sort((a, b) => order[a.verdict] - order[b.verdict]);
}

/** The "this session could have been better if…" line, from the actual findings. */
function betterIfSentence(skill: SkillId, misses: Finding[]): string {
  const tokens = misses.reduce((s, f) => s + (f.savings?.tokens?.value ?? 0), 0);
  const wallMs = misses.reduce((s, f) => s + (f.savings?.wall_clock_ms?.value ?? 0), 0);
  const cost =
    tokens > 0
      ? ` (about ${tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : `${Math.round(tokens / 1_000)}k`} tokens measured)`
      : wallMs > 60_000
        ? ` (about ${Math.round(wallMs / 60_000)} minutes measured)`
        : "";
  const first = misses[0]!;
  switch (skill) {
    case "agent-orchestration":
      return `This session could have been better with delegation: bulk reading/searching stayed on the main thread when a subagent was available${cost}.`;
    case "context-engineering":
      return `This session could have been better with context care: ${misses.length === 1 ? "one avoidable context cost" : `${misses.length} avoidable context costs`} (cache misses, compactions, or oversized reads)${cost}.`;
    case "planning-decomposition":
      return `This session could have been better with up-front scoping: work was discarded on a rewind${cost} — plan mode would have surfaced the direction change first.`;
    case "recovery-verification":
      return `This session could have been better with error discipline: the same failure repeated instead of being diagnosed once${cost}.`;
    case "workflow-automation":
      return `This session could have been better with configuration: repeated permission prompts interrupted the flow — an allowlist entry removes them.`;
    default:
      return `${first.title}${cost} — see the linked finding.`;
  }
}
