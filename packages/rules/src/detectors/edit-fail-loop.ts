import type { Finding } from "@damame/ir";
import type { Detector } from "../types.js";
import { eventRefs, finding } from "../helpers.js";

const EDIT_SIGNATURES = new Set([
  "edit_string_not_found",
  "edit_string_not_unique",
  "file_not_read",
  "file_modified_since_read",
]);

/**
 * Fires on runs of consecutive Edit-class failures against the same file
 * (Edit-fail → Read → Edit-fail cycles included: the metrics pass only breaks
 * an error run on a *successful result of the same tool+target*).
 *
 * Savings are measured, not modeled: the deduped usage of every assistant
 * request between the first failure and the end of the run, i.e. tokens that
 * were demonstrably spent re-attempting, minus nothing — the first attempt is
 * excluded by construction because the run starts at the first *failure*.
 */
export const editFailLoop: Detector = {
  id: "edit-fail-loop",
  version: "0.1.0",
  category: "error-loop",
  summary: "Repeated Edit failures on the same file (stale content, unmatched strings)",
  defaults: {
    min_consecutive_failures: 3,
  },
  detect(ctx): Finding[] {
    const min = ctx.config.min_consecutive_failures as number;
    const out: Finding[] = [];
    for (const run of ctx.metrics.error_runs) {
      if (!EDIT_SIGNATURES.has(run.signature)) continue;
      if (run.length < min) continue;
      const wallClock =
        run.first_ts && run.last_ts ? Math.max(0, Date.parse(run.last_ts) - Date.parse(run.first_ts)) : undefined;
      out.push(
        finding({
          rule: { id: this.id, version: this.version },
          category: this.category,
          severity: run.length >= min + 2 ? "major" : "moderate",
          confidence: { source: "deterministic" },
          title: `${run.length} consecutive Edit failures on ${shortPath(run.target)}`,
          description:
            `The same edit failed ${run.length} times in a row with "${run.signature}" against ` +
            `${run.target ?? "the same file"}. Each retry re-sent the full context. Reading the current file ` +
            `content immediately before constructing the edit (and re-reading after any external change) ` +
            `avoids the loop.`,
          evidence: {
            events: eventRefs(ctx.session, [...run.call_event_ids, ...run.result_event_ids]),
            metrics: { consecutive_failures: run.length, signature: run.signature, target: run.target },
          },
          savings: {
            tokens: { value: run.retry_usage_tokens },
            ...(wallClock !== undefined ? { wall_clock_ms: { value: wallClock } } : {}),
            method:
              "sum of deduped assistant usage between the first failure in the run and the run's end " +
              "(tokens demonstrably spent on re-attempts)",
            basis: "measured",
          },
          recommendation: {
            resource: { kind: "prompting_pattern", ref: "read-before-edit" },
            rationale:
              "Edit requires exact current file content. A Read of the target region immediately before the " +
              "edit (or after any tool that may have changed the file) makes the old_string match on the first try.",
          },
        }),
      );
    }
    return out;
  },
};

function shortPath(target: string | undefined): string {
  if (!target) return "a file";
  const parts = target.split("/");
  return parts.slice(-2).join("/");
}
