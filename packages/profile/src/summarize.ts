import type { Finding, Session } from "@damame/ir";
import { totalTokens } from "@damame/ir";
import type { MetricsBundle } from "@damame/metrics";
import { detectTechniques } from "./techniques.js";
import { SKILLS, skillForRule, type SkillId } from "./taxonomy.js";

/**
 * The compact per-session vector everything cross-session is computed from.
 * ~1KB — this is the disk-cacheable unit, so a 212MB transcript is parsed once
 * and the profile stays instant forever after.
 */
export interface SkillTally {
  /** Times the skill was used when the work called for it (technique uses). */
  uses: number;
  /** Missed opportunities: findings from this skill's miss_rules. */
  misses: number;
  /** dedupe_keys of the miss findings (evidence deep-links). */
  miss_keys: string[];
  /** Measured waste attached to the misses. */
  missed_tokens: number;
  missed_wall_ms: number;
}

export interface SessionSummary {
  schema: 2;
  session_id: string;
  path: string;
  title?: string;
  cwd?: string;
  started_at?: string;
  ended_at?: string;
  total_tokens: number;
  human_turns: number;
  tool_calls: number;
  skills: Record<SkillId, SkillTally>;
  techniques: Record<string, number>;
  /** Distinct tool names + skill names available that session (for coverage). */
  tools_used: string[];
  skills_available: number;
  skills_invoked: number;
  /** Infra noise marker so recommendations can contextualize. */
  api_error_bursts: number;
}

export function summarizeSession(session: Session, metrics: MetricsBundle, findings: Finding[]): SessionSummary {
  const techniques = detectTechniques(session, metrics);

  const skills = Object.fromEntries(
    SKILLS.map((s) => [s.id, { uses: 0, misses: 0, miss_keys: [] as string[], missed_tokens: 0, missed_wall_ms: 0 }]),
  ) as unknown as Record<SkillId, SkillTally>;

  // uses: ONE per technique per session (binary), so rates compare like units:
  // a session that ran 400 Greps used search-first once as a practice, not 400
  // times — otherwise raw event counts swamp the miss side and every skill
  // reads "practiced well" next to megatokens of measured waste.
  for (const skill of SKILLS) {
    for (const techniqueId of skill.use_techniques) {
      if ((techniques[techniqueId] ?? 0) > 0) skills[skill.id].uses += 1;
    }
  }

  // misses: findings mapped to skills (infra findings never map — fairness)
  for (const finding of findings) {
    const skillId = skillForRule(finding.rule.id);
    if (!skillId) continue;
    const tally = skills[skillId];
    tally.misses += 1;
    tally.miss_keys.push(finding.dedupe_key);
    tally.missed_tokens += finding.savings?.tokens?.value ?? 0;
    tally.missed_wall_ms += finding.savings?.wall_clock_ms?.value ?? 0;
  }

  return {
    schema: 2,
    session_id: session.id,
    path: (session.metadata?.transcript_path as string) ?? "",
    ...(session.title ? { title: session.title } : {}),
    ...(session.project?.cwd ? { cwd: session.project.cwd } : {}),
    ...(session.started_at ? { started_at: session.started_at } : {}),
    ...(session.ended_at ? { ended_at: session.ended_at } : {}),
    total_tokens: totalTokens(session.usage_totals),
    human_turns: metrics.totals.human_turn_count,
    tool_calls: metrics.totals.tool_call_count,
    skills,
    techniques,
    tools_used: session.environment?.core_tools_observed ?? [],
    skills_available: session.environment?.skills.length ?? 0,
    skills_invoked: session.environment?.invoked_skills.length ?? 0,
    api_error_bursts: metrics.api_error_runs.length,
  };
}
