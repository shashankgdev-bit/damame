import type { Finding } from "@damame/ir";
import type { Detector } from "../types.js";
import { eventRefs, finding, formatDuration } from "../helpers.js";

/** Agent types whose job is bulk exploration; first available one is recommended. */
const EXPLORATION_AGENT_TYPES = ["Explore", "general-purpose"];

/**
 * Fires when the session compacted its context window repeatedly. Each
 * compaction pauses work while the conversation is summarized (the CLI records
 * the pause as `compactMetadata.durationMs`), and detail not carried into the
 * summary must be re-established afterward.
 *
 * Savings are measured, not modeled: the sum of the recorded compaction
 * durations — wall-clock time demonstrably spent compacting. No token savings
 * are claimed: the re-establishment cost after a compaction is real but not
 * defensibly attributable from the transcript alone.
 */
export const compactionBurn: Detector = {
  id: "compaction-burn",
  version: "0.1.0",
  category: "context-hygiene",
  summary: "Repeated context compactions: recorded time lost to summarization pauses",
  defaults: {
    min_compactions: 2,
  },
  detect(ctx): Finding[] {
    const min = ctx.config.min_compactions as number;
    const compactions = ctx.metrics.compactions;
    if (compactions.length < min) return [];

    const count = compactions.length;
    const durations = compactions
      .map((c) => c.duration_ms)
      .filter((d): d is number => d !== undefined);
    const totalDurationMs = durations.reduce((sum, d) => sum + d, 0);
    const hasDurations = durations.length > 0;

    const agentType = EXPLORATION_AGENT_TYPES.find((type) =>
      ctx.env?.agents.some((a) => a.type === type && a.removed !== true),
    );

    const durationClause = hasDurations
      ? ` (${formatDuration(totalDurationMs)} of recorded compaction time in total)`
      : "";

    return [
      finding({
        rule: { id: this.id, version: this.version },
        category: this.category,
        severity: count >= min + 2 ? "major" : "moderate",
        confidence: { source: "deterministic" },
        title: `${count} context compactions in one session`,
        description:
          `The context window filled to the compaction threshold ${count} times. Each compaction ` +
          `pauses work while the conversation is summarized${durationClause}, and detail not carried ` +
          `into the summary has to be re-established afterward. Repeated compactions indicate bulk ` +
          `tool output (full-file reads, wide search results) accumulating in the main context.`,
        evidence: {
          events: eventRefs(
            ctx.session,
            compactions.map((c) => c.event_id),
          ),
          metrics: {
            compaction_count: count,
            ...(hasDurations ? { total_compaction_duration_ms: totalDurationMs } : {}),
          },
        },
        ...(hasDurations
          ? {
              savings: {
                wall_clock_ms: { value: totalDurationMs },
                method: "compactMetadata.durationMs recorded by the CLI for each compaction",
                basis: "measured" as const,
              },
            }
          : {}),
        recommendation: agentType
          ? {
              resource: { kind: "subagent" as const, ref: agentType, available_in_session: true },
              rationale:
                `Delegating bulk file reading and searching to the ${agentType} subagent keeps that ` +
                `output out of the main context window — only the subagent's summary returns — ` +
                `delaying or avoiding compaction.`,
            }
          : {
              resource: { kind: "prompting_pattern" as const, ref: "delegate-bulk-exploration" },
              rationale:
                "Keep bulk exploration out of the long-lived context: read targeted line ranges " +
                "instead of whole files, prefer narrow search output, and carry forward conclusions " +
                "rather than raw tool output, so the resident window stays under the compaction threshold.",
            },
      }),
    ];
  },
};
