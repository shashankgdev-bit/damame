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
  version: "0.1.0",
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
      out.push(
        finding({
          rule: { id: this.id, version: this.version },
          category: this.category,
          severity: branch.usage_tokens >= major ? "major" : "moderate",
          confidence: { source: "deterministic" },
          title: `${formatTokens(branch.usage_tokens)} tokens spent on a branch abandoned by a rewind`,
          description:
            `Work on this path (${branch.event_count} events, ${formatTokens(branch.usage_tokens)} tokens ` +
            `of recorded assistant usage) was discarded when the session was rewound to an earlier point. ` +
            `Rewinds are often deliberate exploration; if the direction change was foreseeable, an up-front ` +
            `scope statement or plan mode would have surfaced it before the spend.`,
          evidence: {
            events: eventRefs(ctx.session, [branch.root_event_id]),
            metrics: {
              abandoned_event_count: branch.event_count,
              abandoned_usage_tokens: branch.usage_tokens,
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
