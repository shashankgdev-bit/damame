import { z } from "zod";
import { EventRefSchema } from "./event.js";

export const FindingCategorySchema = z.enum([
  "error-loop",
  "redundant-work",
  "context-hygiene",
  "missed-resource",
  "delegation",
  "prompting",
  "interaction-friction",
  "infra",
]);
export type FindingCategory = z.infer<typeof FindingCategorySchema>;

export const SeveritySchema = z.enum(["info", "minor", "moderate", "major"]);
export type Severity = z.infer<typeof SeveritySchema>;

const EstimateBandSchema = z.object({
  value: z.number().nonnegative(),
  low: z.number().nonnegative().optional(),
  high: z.number().nonnegative().optional(),
});

/**
 * Savings claims are the most trust-sensitive part of a finding, so they are
 * structured, not prose:
 *  - `basis: "measured"` — tokens/time actually spent on identifiably wasted
 *    work (e.g. the deduped usage of retry requests after the first failure).
 *  - `basis: "modeled"` — a counterfactual estimate; `method` must state the
 *    assumptions. Rules omit `savings` entirely rather than guess.
 */
export const SavingsSchema = z.object({
  tokens: EstimateBandSchema.optional(),
  wall_clock_ms: EstimateBandSchema.optional(),
  method: z.string().min(10),
  basis: z.enum(["measured", "modeled"]),
});
export type Savings = z.infer<typeof SavingsSchema>;

export const RecommendationSchema = z.object({
  resource: z.object({
    kind: z.enum(["skill", "subagent", "mcp_tool", "core_tool", "prompting_pattern", "config"]),
    ref: z.string(),
    /**
     * From the session's own EnvironmentSnapshot. Required for skill/subagent/
     * mcp_tool kinds: recommending something the user didn't have is a
     * different (weaker) claim than "you had it and didn't use it".
     */
    available_in_session: z.boolean().optional(),
  }),
  rationale: z.string(),
  example_invocation: z.string().optional(),
});
export type Recommendation = z.infer<typeof RecommendationSchema>;

export const FindingSchema = z.object({
  rule: z.object({ id: z.string(), version: z.string() }),
  category: FindingCategorySchema,
  severity: SeveritySchema,
  confidence: z.object({
    /** Never mixed: a judge-annotated deterministic finding stays "deterministic". */
    source: z.enum(["deterministic", "llm_judge"]),
    score: z.number().min(0).max(1).optional(),
  }),
  title: z.string(),
  /** States the mechanism, not vibes. */
  description: z.string(),
  evidence: z.object({
    events: z.array(EventRefSchema).min(1),
    turn_ids: z.array(z.string()).optional(),
    /** The numbers the rule keyed on, e.g. {consecutive_failures: 4}. */
    metrics: z.record(z.unknown()).optional(),
  }),
  savings: SavingsSchema.optional(),
  recommendation: RecommendationSchema,
  /** stable hash(rule.id, primary evidence) — feedback joining, idempotent re-runs. */
  dedupe_key: z.string(),
});
export type Finding = z.infer<typeof FindingSchema>;

/** Embedded in every report; two reports are comparable iff these match. */
export const GradingVersionSchema = z.object({
  damame_version: z.string(),
  ir_version: z.string(),
  adapter: z.string(),
  adapter_version: z.string(),
  rule_versions: z.record(z.string()),
});
export type GradingVersion = z.infer<typeof GradingVersionSchema>;
