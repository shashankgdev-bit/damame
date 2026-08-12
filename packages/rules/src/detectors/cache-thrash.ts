import type { Finding, Recommendation, Severity } from "@damame/ir";
import type { Detector } from "../types.js";
import { eventRefs, finding, formatTokens } from "../helpers.js";

/**
 * Miss reasons that originate on the API side (an expired or evicted cache
 * entry), not from how the session was driven. These still cost real tokens,
 * so they are surfaced — but as "info", explicitly not a behavior finding.
 */
const INFRA_REASONS = new Set(["previous_message_not_found", "unavailable"]);

/**
 * Fires when the API itself reported prompt-cache misses whose summed
 * `cache_missed_input_tokens` crosses the threshold, grouped by miss reason.
 * This is the highest-precision signal in the tool: nothing is inferred — the
 * provider recorded both the miss and its exact token cost in
 * `message.diagnostics`, so savings are measured by definition.
 *
 * Misses without a reported token count cannot contribute to the threshold and
 * are excluded from evidence entirely (we only cite responses whose cost the
 * API quantified). Misses on abandoned branches are skipped.
 */
export const cacheThrash: Detector = {
  id: "cache-thrash",
  version: "0.1.0",
  category: "context-hygiene",
  summary: "Prompt-cache misses reported by the API (missed input tokens re-processed at full price)",
  defaults: {
    min_missed_tokens: 100_000,
    major_missed_tokens: 1_000_000,
  },
  detect(ctx): Finding[] {
    const min = ctx.config.min_missed_tokens as number;
    const majorAt = ctx.config.major_missed_tokens as number;

    const abandoned = new Set<string>();
    for (const event of ctx.session.events) {
      if (event.on_abandoned_branch) abandoned.add(event.event_id);
    }

    const groups = new Map<string, { event_ids: string[]; total: number }>();
    for (const miss of ctx.metrics.cache_misses) {
      if (abandoned.has(miss.event_id)) continue;
      if (miss.missed_input_tokens === undefined) continue;
      const group = groups.get(miss.reason) ?? { event_ids: [], total: 0 };
      group.event_ids.push(miss.event_id);
      group.total += miss.missed_input_tokens;
      groups.set(miss.reason, group);
    }

    const out: Finding[] = [];
    for (const [reason, group] of groups) {
      if (group.total < min) continue;
      const infra = INFRA_REASONS.has(reason);
      const severity: Severity = infra ? "info" : group.total >= majorAt ? "major" : "moderate";
      out.push(
        finding({
          rule: { id: this.id, version: this.version },
          category: this.category,
          severity,
          confidence: { source: "deterministic" },
          title: `${formatTokens(group.total)} input tokens missed the prompt cache (${reason})`,
          description: describe(reason, group.event_ids.length, group.total),
          evidence: {
            events: eventRefs(ctx.session, group.event_ids),
            metrics: { reason, miss_count: group.event_ids.length, total_missed_input_tokens: group.total },
          },
          savings: {
            tokens: { value: group.total },
            method: "cache_missed_input_tokens reported by the API in message.diagnostics for the cited responses",
            basis: "measured",
          },
          recommendation: recommend(reason),
        }),
      );
    }
    return out;
  },
};

function describe(reason: string, count: number, total: number): string {
  const responses = count === 1 ? "1 response" : `${count} responses`;
  if (reason === "tools_changed") {
    return (
      `The API reported ${responses} with cache_miss_reason "tools_changed": the set of tools visible to ` +
      `the model changed between requests, which invalidates the cached prompt prefix from the tools block ` +
      `onward. ${formatTokens(total)} input tokens that a stable tool set would have served from cache were ` +
      `re-processed at full input price. Enabling or disabling MCP servers or tools mid-session triggers ` +
      `this on every toggle.`
    );
  }
  if (INFRA_REASONS.has(reason)) {
    return (
      `The API reported ${responses} with cache_miss_reason "${reason}": the previously cached prompt ` +
      `prefix was not found or was unavailable at request time. This is typically infrastructure-side ` +
      `(cache expiry or eviction between requests), not a result of how the session was driven. ` +
      `${formatTokens(total)} input tokens were re-processed at full input price; reported for cost visibility.`
    );
  }
  return (
    `The API reported ${responses} with cache_miss_reason "${reason}". ${formatTokens(total)} input tokens ` +
    `that could have been served from the prompt cache were re-processed at full input price. The prompt ` +
    `cache requires an exactly stable prefix; any change to earlier context invalidates every cached block ` +
    `after the change.`
  );
}

function recommend(reason: string): Recommendation {
  if (reason === "tools_changed") {
    return {
      resource: { kind: "config", ref: "stable-tool-availability" },
      rationale:
        "Keep the set of enabled MCP servers and tools stable for the whole session: each mid-session " +
        "toggle changes the tools block at the top of the prompt and invalidates the cache for everything " +
        "after it. Configure the tool set before starting work instead of toggling servers mid-session.",
    };
  }
  if (INFRA_REASONS.has(reason)) {
    return {
      resource: { kind: "prompting_pattern", ref: "no-user-action" },
      rationale:
        "These misses originate on the API side (an expired or evicted cache entry); no session-side " +
        "change reliably prevents them. Long pauses between requests make expiry more likely, but the cost " +
        "is surfaced for visibility, not as a behavior finding.",
    };
  }
  return {
    resource: { kind: "prompting_pattern", ref: "stable-prompt-prefix" },
    rationale:
      "The prompt cache keys on an exact prefix match. Keep earlier context byte-stable across requests — " +
      "avoid rewriting the system prompt, reordering messages, or mutating prior content mid-session.",
  };
}
