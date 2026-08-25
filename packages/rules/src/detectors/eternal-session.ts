import type { Finding, Recommendation, Severity } from "@damame/ir";
import type { Detector } from "../types.js";
import { eventRefs, finding, formatDuration } from "../helpers.js";

/**
 * File names that indicate the session already externalizes its memory into
 * project state files (a ledger, briefing, plan, notes, or CLAUDE.md). Matched
 * against tool_call `file_path` inputs, case-insensitively.
 */
const STATE_FILE_PATTERN = /CLAUDE\.md|LEDGER|LEARNINGS|BRIEFING|NOTES|PLAN/i;

/** Cap on cited compaction events so evidence stays readable on extreme sessions. */
const MAX_EVIDENCE_EVENTS = 8;

/**
 * Fires when one session has become a long-lived workspace rather than a
 * task-scoped conversation: many resume boundaries (transcript lines with a
 * null parent pointer — each one a resume of the same session file), repeated
 * context compactions, AND a multi-day wall-clock span, all at once. Each
 * compaction costs a recorded pause plus a lossy summarization, so a session
 * kept alive for weeks accumulates summaries-of-summaries; a fresh session
 * bootstrapped from state files starts with a clean, cheap context instead.
 *
 * Savings are measured: the sum of the recorded compaction durations
 * (`compactMetadata.durationMs`). This is the same measured basis
 * compaction-burn uses, and the overlap is intentional — compaction-burn fires
 * on the single-session burn itself, while this rule fires on the
 * SESSION-LIFECYCLE pattern (the compactions keep recurring because the
 * session is never allowed to end). Savings are omitted when no compaction
 * recorded a duration.
 */
export const eternalSession: Detector = {
  id: "eternal-session",
  version: "0.1.0",
  category: "context-hygiene",
  summary: "One session used as a permanent workspace: many resumes, repeated compactions, multi-day span",
  defaults: {
    min_resumes: 15,
    min_compactions: 3,
    min_span_days: 7,
    major_compactions: 10,
  },
  detect(ctx): Finding[] {
    const minResumes = ctx.config.min_resumes as number;
    const minCompactions = ctx.config.min_compactions as number;
    const minSpanDays = ctx.config.min_span_days as number;
    const majorAt = ctx.config.major_compactions as number;

    const resumes = ctx.session.chain_root_event_ids?.length ?? 0;
    const compactions = ctx.metrics.compactions;
    const { started_at, ended_at } = ctx.session;
    const spanDays =
      started_at !== undefined && ended_at !== undefined
        ? (Date.parse(ended_at) - Date.parse(started_at)) / 86_400_000
        : 0;

    if (resumes < minResumes || compactions.length < minCompactions || spanDays < minSpanDays) {
      return [];
    }

    // State files touched by any live-branch tool call: evidence that the
    // session's memory already lives outside the context window.
    const stateFileSet = new Set<string>();
    for (const event of ctx.session.events) {
      if (event.kind !== "tool_call" || event.on_abandoned_branch) continue;
      const filePath = event.input["file_path"];
      if (typeof filePath !== "string" || !STATE_FILE_PATTERN.test(filePath)) continue;
      stateFileSet.add(filePath.split("/").pop() ?? filePath);
    }
    const stateFiles = [...stateFileSet].sort();

    const durations = compactions
      .map((c) => c.duration_ms)
      .filter((d): d is number => d !== undefined);
    const totalDurationMs = durations.reduce((sum, d) => sum + d, 0);

    const spanDaysRounded = Math.round(spanDays * 10) / 10;
    const severity: Severity = compactions.length >= majorAt ? "major" : "moderate";
    const durationClause =
      totalDurationMs > 0
        ? ` — ${formatDuration(totalDurationMs)} of recorded compaction pauses in total`
        : "";

    const recommendation: Recommendation = {
      resource: { kind: "prompting_pattern", ref: "session-per-task-bootstrap" },
      rationale:
        stateFiles.length > 0
          ? `Your state files (${stateFiles.join(", ")}) already carry the memory — start fresh ` +
            `sessions from them. A new session that begins by reading those files gets the same ` +
            `working state in a clean context, without the compaction chain.`
          : `Create a state/briefing file first (a ledger, plan, or notes file that records the ` +
            `project's working state), then start fresh sessions from it. A new session that begins ` +
            `by reading that file gets the same working state in a clean context, without the ` +
            `compaction chain.`,
    };

    return [
      finding({
        rule: { id: this.id, version: this.version },
        category: this.category,
        severity,
        confidence: { source: "deterministic" },
        title:
          `One session spanned ${spanDaysRounded} days across ${resumes} resumes and ` +
          `${compactions.length} compactions`,
        description:
          `This session was resumed ${resumes} times over ${spanDaysRounded} days and compacted its ` +
          `context ${compactions.length} times${durationClause}. Each compaction pauses work while the ` +
          `conversation is summarized, and each summary is lossy — a session kept alive this long is ` +
          `running on summaries of summaries. The session has become a permanent workspace; a fresh ` +
          `session bootstrapped from state files carries the same working knowledge in a clean, cheap ` +
          `context instead.`,
        evidence: {
          events: eventRefs(
            ctx.session,
            compactions.slice(0, MAX_EVIDENCE_EVENTS).map((c) => c.event_id),
          ),
          metrics: {
            resumes,
            compactions: compactions.length,
            span_days: spanDaysRounded,
            state_files: stateFiles,
          },
        },
        ...(totalDurationMs > 0
          ? {
              savings: {
                wall_clock_ms: { value: totalDurationMs },
                method:
                  "sum of compactMetadata.durationMs recorded by the CLI for each compaction — the " +
                  "recorded pauses a task-scoped session lifecycle would have avoided (same measured " +
                  "basis as compaction-burn; the two rules overlap intentionally)",
                basis: "measured",
              },
            }
          : {}),
        recommendation,
      }),
    ];
  },
};
