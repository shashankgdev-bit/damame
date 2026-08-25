import type { Finding } from "@damame/ir";
import type { Detector } from "../types.js";
import { eventRefs, finding, formatTokens } from "../helpers.js";

/**
 * Fires once per abandoned branch whose recorded assistant usage crossed the
 * threshold. Branches come from the adapter's fork resolution: a transcript
 * line with more than one child means the session was rewound (escape /
 * re-prompt) and exactly one child continued; every other subtree is dead work.
 *
 * Deliberately conservative — rewinds are often intentional exploration, so
 * the default threshold is high and the finding only claims what is recorded:
 * the branch's deduped usage was spent, and the path did not continue.
 *
 * Savings are measured, not modeled: `usage_tokens` is the deduped
 * input+output+cache-write usage of assistant responses actually recorded on
 * the abandoned branch (cache reads excluded by the adapter). No counterfactual
 * is assumed.
 */
export const abandonedWork: Detector = {
  id: "abandoned-work",
  version: "0.2.0", // 0.2.0: resume-orphaned branches (reopen/crash tails) split from rewinds — info severity, no user action. Real-user feedback fix.
  category: "prompting",
  summary: "Large token spend on a branch discarded when the session was rewound",
  defaults: {
    min_abandoned_tokens: 200_000,
    major_abandoned_tokens: 1_000_000,
  },
  detect(ctx): Finding[] {
    const min = ctx.config.min_abandoned_tokens as number;
    const major = ctx.config.major_abandoned_tokens as number;
    const out: Finding[] = [];
    for (const branch of ctx.metrics.abandoned_branches) {
      if (!branch.root_event_id) continue;
      if (branch.usage_tokens < min) continue;
      // A branch orphaned by a session reopen/crash is not a user decision:
      // report it for cost visibility only, in the not-your-inefficiency
      // bucket, with nothing to fix.
      if (branch.fork_kind !== "rewind") {
        out.push(
          finding({
            rule: { id: this.id, version: this.version },
            category: "infra",
            severity: "info",
            confidence: { source: "deterministic" },
            title: `${formatTokens(branch.usage_tokens)} tokens on a branch orphaned by a session resume`,
            description:
              `Work on this path (${branch.event_count} events, ${formatTokens(branch.usage_tokens)} tokens ` +
              `of recorded assistant usage) ended up off the live conversation after the session was closed ` +
              `and reopened (or recovered from a failure) — the resumed thread continued from an earlier ` +
              `point. The work itself (files written, commands run) still happened; only its conversation ` +
              `lines are off the final path. This is a harness/lifecycle artifact, not a user action, and ` +
              `there is nothing to fix.`,
            evidence: {
              events: eventRefs(ctx.session, [branch.root_event_id]),
              metrics: {
                abandoned_event_count: branch.event_count,
                abandoned_usage_tokens: branch.usage_tokens,
                fork_kind: branch.fork_kind ?? "resume",
              },
            },
            recommendation: {
              resource: { kind: "config", ref: "none-required" },
              rationale:
                "Orphaned resume tails originate in session lifecycle (reopen after close, crash recovery), " +
                "not in how the session was driven; reported for cost visibility only.",
            },
          }),
        );
        continue;
      }
      out.push(
        finding({
          rule: { id: this.id, version: this.version },
          category: this.category,
          severity: branch.usage_tokens >= major ? "major" : "moderate",
          confidence: { source: "deterministic" },
          title: `${formatTokens(branch.usage_tokens)} tokens spent on a branch abandoned by a rewind`,
          description:
            `Work on this path (${branch.event_count} events, ${formatTokens(branch.usage_tokens)} tokens ` +
            `of recorded assistant usage) was discarded when the session was rewound to an earlier point ` +
            `within the same sitting. Rewinds are often deliberate exploration; if the direction change was ` +
            `foreseeable, an up-front scope statement or plan mode would have surfaced it before the spend.`,
          evidence: {
            events: eventRefs(ctx.session, [branch.root_event_id]),
            metrics: {
              abandoned_event_count: branch.event_count,
              abandoned_usage_tokens: branch.usage_tokens,
              fork_kind: "rewind",
            },
          },
          savings: {
            tokens: { value: branch.usage_tokens },
            method:
              "deduped input+output+cache-write usage of assistant responses on the abandoned branch; " +
              "cache reads excluded",
            basis: "measured",
          },
          recommendation: {
            resource: { kind: "prompting_pattern", ref: "plan-mode-first" },
            rationale:
              "Stating the intended scope up front — or starting in plan mode so the approach is agreed " +
              "before execution — surfaces a direction change before tokens are spent on a path that gets " +
              "discarded.",
          },
        }),
      );
    }
    return out;
  },
};
