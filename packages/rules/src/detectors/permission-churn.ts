import type { Finding } from "@damame/ir";
import type { Detector } from "../types.js";
import { eventRefs, finding } from "../helpers.js";

const HELPER_SKILL = "fewer-permission-prompts";

/**
 * Fires when a session accumulates enough permission denials (the user
 * declining a proposed tool call) to indicate the permission settings don't
 * match the workflow. Each denial costs a full model round-trip — the call is
 * constructed, sent, and rejected — plus a human interaction to decline, and
 * the model typically re-plans around the rejection.
 *
 * Savings are intentionally omitted: the token cost of a denied call is
 * trivial, and the dominant cost (human wait/attention time at each prompt)
 * is not defensibly measurable from the transcript in v1.
 */
export const permissionChurn: Detector = {
  id: "permission-churn",
  version: "0.1.0",
  category: "interaction-friction",
  summary: "Repeated permission denials suggest settings misaligned with the workflow",
  defaults: {
    min_denials: 3,
  },
  detect(ctx): Finding[] {
    const min = ctx.config.min_denials as number;

    const abandoned = new Set(
      ctx.session.events.filter((e) => e.on_abandoned_branch).map((e) => e.event_id),
    );
    const denials = ctx.metrics.permission_denials.filter((d) => !abandoned.has(d.event_id));
    if (denials.length < min) return [];

    // Counts per tool, keyed in first-seen order (deterministic tie-break).
    const byTool: Record<string, number> = {};
    for (const denial of denials) {
      const name = denial.tool_name ?? "<unknown>";
      byTool[name] = (byTool[name] ?? 0) + 1;
    }
    let topTool = "<unknown>";
    let topCount = 0;
    for (const [name, count] of Object.entries(byTool)) {
      if (count > topCount) {
        topTool = name;
        topCount = count;
      }
    }

    const hasHelperSkill = (ctx.env?.skills ?? []).some((s) => s.name === HELPER_SKILL);
    const recommendation: Finding["recommendation"] = hasHelperSkill
      ? {
          resource: { kind: "skill", ref: HELPER_SKILL, available_in_session: true },
          rationale:
            `The ${HELPER_SKILL} skill was available in this session: it scans transcripts for ` +
            `routinely-approved tool calls and adds a prioritized allowlist to .claude/settings.json, ` +
            `removing the recurring prompts at the source.`,
          example_invocation: `/${HELPER_SKILL}`,
        }
      : {
          resource: { kind: "config", ref: "permissions-allowlist" },
          rationale:
            `Add permissions.allow entries to .claude/settings.json for the tool calls you routinely ` +
            `approve — starting with ${topTool}, the most-denied tool in this session — and use plan ` +
            `mode first for exploratory phases so proposed actions are reviewed as a batch instead of ` +
            `prompt-by-prompt.`,
        };

    const breakdown = Object.entries(byTool)
      .map(([name, count]) => `${name} ×${count}`)
      .join(", ");

    return [
      finding({
        rule: { id: this.id, version: this.version },
        category: this.category,
        severity: denials.length >= 2 * min ? "moderate" : "minor",
        confidence: { source: "deterministic" },
        title: `${denials.length} permission denials in one session (${breakdown})`,
        description:
          `${denials.length} proposed tool calls were denied permission (${breakdown}). Each denial ` +
          `spends a model round-trip constructing a call that is then rejected, interrupts the user ` +
          `to decline it, and forces the model to re-plan around the rejection. Recurring denials ` +
          `for the same tool indicate the session's permission settings do not match the workflow.`,
        evidence: {
          events: eventRefs(
            ctx.session,
            denials.map((d) => d.event_id),
          ),
          metrics: { total_denials: denials.length, denials_by_tool: byTool },
        },
        recommendation,
      }),
    ];
  },
};
