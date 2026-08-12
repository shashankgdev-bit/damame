import type { Finding } from "@damame/ir";
import type { Detector } from "../types.js";
import { eventRefs, finding, formatDuration } from "../helpers.js";

/**
 * Fires once per session when the API itself misbehaved: runs of api_error
 * system events (each carrying the client's recorded retryInMs backoff wait)
 * and/or synthetic assistant placeholders emitted after terminal API errors.
 *
 * This rule exists for fairness. It attributes the resulting wall-clock delay
 * to provider-side infrastructure so it is never read as session inefficiency,
 * and so other wall-clock-based findings in the same report can be discounted
 * accordingly. Severity is always "info" and the recommendation prescribes no
 * change.
 *
 * Savings are measured, not modeled: the sum of retryInMs waits the client
 * actually recorded on api_error system events. No token claim is made — the
 * transcript does not record usage for failed requests.
 */
export const retryStorm: Detector = {
  id: "retry-storm",
  version: "0.1.0",
  category: "infra",
  summary: "Transient API errors and retry backoff — provider-side delay, not session behavior",
  defaults: {
    min_api_errors: 3,
  },
  detect(ctx): Finding[] {
    const min = ctx.config.min_api_errors as number;
    const runs = ctx.metrics.api_error_runs;
    const apiErrorEventIds = runs.flatMap((run) => run.event_ids);
    const totalWaitMs = runs.reduce((sum, run) => sum + run.total_retry_wait_ms, 0);
    const placeholders = ctx.session.events.filter(
      (e) => e.kind === "assistant_message" && e.is_error_placeholder === true && !e.on_abandoned_branch,
    );
    if (apiErrorEventIds.length < min && placeholders.length === 0) return [];

    const parts: string[] = [];
    if (apiErrorEventIds.length > 0) {
      parts.push(`${apiErrorEventIds.length} transient API error${apiErrorEventIds.length === 1 ? "" : "s"}`);
    }
    if (placeholders.length > 0) {
      parts.push(`${placeholders.length} terminal API failure${placeholders.length === 1 ? "" : "s"}`);
    }

    return [
      finding({
        rule: { id: this.id, version: this.version },
        category: this.category,
        severity: "info",
        confidence: { source: "deterministic" },
        title: `${parts.join(" and ")} — infrastructure delay, not session behavior`,
        description:
          `The API returned transient errors during this session` +
          (apiErrorEventIds.length > 0
            ? `; the client automatically retried, waiting a recorded total of ${formatDuration(totalWaitMs)} in backoff`
            : "") +
          `.` +
          (placeholders.length > 0
            ? ` ${placeholders.length} request${placeholders.length === 1 ? "" : "s"} failed terminally and ` +
              `${placeholders.length === 1 ? "was" : "were"} replaced by a synthetic error placeholder.`
            : "") +
          ` This delay originated from provider-side availability, not from anything the user or the agent did, ` +
          `and must not count against the session. This finding contextualizes wall-clock numbers in other ` +
          `findings rather than flagging a problem to fix.`,
        evidence: {
          events: eventRefs(ctx.session, [...apiErrorEventIds, ...placeholders.map((p) => p.event_id)]),
          metrics: {
            api_error_count: apiErrorEventIds.length,
            api_error_run_count: runs.length,
            error_placeholder_count: placeholders.length,
            total_retry_wait_ms: totalWaitMs,
          },
        },
        ...(totalWaitMs > 0
          ? {
              savings: {
                wall_clock_ms: { value: totalWaitMs },
                method: "retryInMs backoff waits recorded on api_error system events",
                basis: "measured" as const,
              },
            }
          : {}),
        recommendation: {
          resource: { kind: "config", ref: "none-required" },
          rationale:
            "Transient API errors are provider-side and outside the session's control; no configuration change " +
            "is required. If large operations repeatedly hit overload errors, consider re-running them off-peak. " +
            "Primarily, use this finding to discount the retry wait time when reading other findings in this report.",
        },
      }),
    ];
  },
};
