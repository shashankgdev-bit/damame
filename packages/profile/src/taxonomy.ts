/**
 * The AI development skills taxonomy — the competencies of building software
 * where using AI well matters as much as writing code.
 *
 * THE CORE MECHANIC (opportunity-aware): a skill is only ever assessed against
 * detected opportunities. rate = uses / (uses + misses), where a "miss" is a
 * deterministic finding proving the opportunity existed and wasn't taken, and
 * a "use" proves it existed and was. Zero opportunities → "not needed
 * recently", a neutral state — never a deficit. We never nag about a skill the
 * work didn't call for.
 */

export type SkillId =
  | "prompt-engineering"
  | "planning-decomposition"
  | "agent-orchestration"
  | "context-engineering"
  | "tooling-fluency"
  | "workflow-automation"
  | "recovery-verification";

export type PracticeState = "practiced_well" | "opportunities_missed" | "not_needed" | "getting_started";

export interface SkillDef {
  id: SkillId;
  title: string;
  /** Layman one-liner shown on the card. */
  tagline: string;
  /** Rule ids whose findings count as missed opportunities for this skill. */
  miss_rules: string[];
  /** Technique ids whose observed use counts as taking the opportunity. */
  use_techniques: string[];
  /** Honest caveat when the deepest measurement is v2-judge territory. */
  measurement_note?: string;
  /**
   * "coverage" skills (tooling-fluency) are breadth-based: no miss concept,
   * states come from coverage counts instead of opportunity rates.
   */
  mode: "opportunity" | "coverage";
}

/** Documented thresholds — part of the published methodology. */
export const STATE_THRESHOLDS = {
  /** rate >= this with >=MIN_OPPORTUNITIES → practiced_well */
  practiced_rate: 0.7,
  /** fewer total opportunities than this → getting_started (too little data) */
  min_opportunities: 2,
  /** coverage mode: minimum distinct techniques for the practiced floor */
  coverage_started: 2,
} as const;

export const SKILLS: SkillDef[] = [
  {
    id: "prompt-engineering",
    title: "Prompt Engineering",
    tagline: "Writing requests the AI can execute in one pass",
    miss_rules: [],
    use_techniques: ["structured-questions"],
    measurement_note:
      "v1 measures light signals only (interruptions, clarification requests). Deep prompt-quality measurement arrives with the judge layer and will be labeled as interpretation.",
    mode: "opportunity",
  },
  {
    id: "planning-decomposition",
    title: "Planning & Decomposition",
    tagline: "Agreeing on scope before tokens are spent",
    miss_rules: ["abandoned-work"],
    use_techniques: ["plan-mode-first", "todo-tracking"],
    mode: "opportunity",
  },
  {
    id: "agent-orchestration",
    title: "Agent Orchestration",
    tagline: "Delegating bulk work to subagents and workflows",
    miss_rules: ["missed-delegation"],
    use_techniques: ["subagent-delegation", "parallel-agents", "workflow-orchestration", "background-tasks"],
    mode: "opportunity",
  },
  {
    id: "context-engineering",
    title: "Context Engineering",
    tagline: "Keeping the context window and prompt cache healthy",
    miss_rules: ["cache-thrash", "compaction-burn", "oversized-context-reads", "duplicate-tool-call"],
    use_techniques: ["targeted-reads", "search-before-read", "prompt-cache-stability"],
    mode: "opportunity",
  },
  {
    id: "tooling-fluency",
    title: "Tooling Fluency",
    tagline: "Knowing the ecosystem: skills, MCP tools, research tools",
    miss_rules: [],
    use_techniques: ["custom-skills", "mcp-tools", "web-research", "slash-commands"],
    mode: "coverage",
  },
  {
    id: "workflow-automation",
    title: "Workflow Automation",
    tagline: "Configuring repetition away: hooks, commands, project memory",
    miss_rules: ["permission-churn"],
    use_techniques: ["hooks", "claude-md", "permission-allowlists", "slash-commands"],
    mode: "opportunity",
  },
  {
    id: "recovery-verification",
    title: "Recovery & Verification",
    tagline: "Breaking error loops and verifying what the AI produced",
    miss_rules: ["edit-fail-loop", "bash-error-loop"],
    use_techniques: ["verify-with-tests"],
    mode: "opportunity",
  },
];

export const SKILL_BY_ID: Record<SkillId, SkillDef> = Object.fromEntries(
  SKILLS.map((s) => [s.id, s]),
) as Record<SkillId, SkillDef>;

/** Map a rule id to the skill it represents a missed opportunity for. */
export function skillForRule(ruleId: string): SkillId | undefined {
  return SKILLS.find((s) => s.miss_rules.includes(ruleId))?.id;
}

export const STATE_COPY: Record<PracticeState, { label: string; blurb: string }> = {
  practiced_well: {
    label: "Practiced well",
    blurb: "When the work called for this skill, you mostly used it.",
  },
  opportunities_missed: {
    label: "Opportunities missed",
    blurb: "The work called for this skill more often than it was used — receipts below.",
  },
  not_needed: {
    label: "Not needed recently",
    blurb: "Your recent work didn't call for this skill. That's fine — nothing to fix.",
  },
  getting_started: {
    label: "Getting started",
    blurb: "Too few opportunities so far to say more. This fills in as you work.",
  },
};
