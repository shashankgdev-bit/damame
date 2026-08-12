import type { Finding } from "@damame/ir";
import type { Detector } from "../types.js";
import { eventRefs, finding } from "../helpers.js";

const BASH_SIGNATURES = new Set(["exit_code_nonzero", "command_timeout"]);

/**
 * Fires on runs of consecutive Bash failures of the same normalized command
 * (nonzero exit code or timeout). The metrics pass only breaks an error run on
 * a *successful result of the same tool*, so interleaved diagnostic calls with
 * other tools do not hide the loop.
 *
 * Savings are measured, not modeled: the deduped usage of every assistant
 * request between the first failure and the end of the run, i.e. tokens that
 * were demonstrably spent re-running the same failing command — the first
 * attempt is excluded by construction because the run starts at the first
 * *failure*.
 */
export const bashErrorLoop: Detector = {
  id: "bash-error-loop",
  version: "0.1.0",
  category: "error-loop",
  summary: "The same Bash command re-run repeatedly after failing (nonzero exit or timeout)",
  defaults: {
    min_consecutive_failures: 3,
    major_at_failures: 5,
  },
  detect(ctx): Finding[] {
    const min = ctx.config.min_consecutive_failures as number;
    const majorAt = ctx.config.major_at_failures as number;
    const out: Finding[] = [];
    for (const run of ctx.metrics.error_runs) {
      if (run.tool_name !== "Bash") continue;
      if (!BASH_SIGNATURES.has(run.signature)) continue;
      if (run.length < min) continue;
      const wallClock =
        run.first_ts && run.last_ts ? Math.max(0, Date.parse(run.last_ts) - Date.parse(run.first_ts)) : undefined;
      const failureVerb = run.signature === "command_timeout" ? "timed out" : "failed";
      out.push(
        finding({
          rule: { id: this.id, version: this.version },
          category: this.category,
          severity: run.length >= majorAt ? "major" : "moderate",
          confidence: { source: "deterministic" },
          title: `${run.length} consecutive Bash failures of \`${shortCommand(run.target)}\``,
          description:
            `The same Bash command ${failureVerb} ${run.length} times in a row with "${run.signature}"` +
            `${run.target ? ` (\`${run.target}\`)` : ""}. Each retry re-sent the full context without new ` +
            `diagnostic information. Reading the error output, adding verbosity, and inspecting the relevant ` +
            `state (paths, environment, running processes) before re-running avoids the loop.`,
          evidence: {
            events: eventRefs(ctx.session, [...run.call_event_ids, ...run.result_event_ids]),
            metrics: { consecutive_failures: run.length, signature: run.signature, command: run.target },
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
            resource: { kind: "prompting_pattern", ref: "diagnose-before-retry" },
            rationale:
              "A command that failed once fails again unless something changed. Before re-running, read the " +
              "error output, re-run with verbose/debug flags if the cause is unclear, and inspect the state " +
              "the command depends on (file paths, environment variables, service status) so the next " +
              "invocation is a corrected command, not a repeat.",
          },
        }),
      );
    }
    return out;
  },
};

function shortCommand(target: string | undefined): string {
  if (!target) return "a command";
  return target.length > 60 ? `${target.slice(0, 57)}...` : target;
}
