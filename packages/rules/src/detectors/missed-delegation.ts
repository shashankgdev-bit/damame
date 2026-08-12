import type { Finding } from "@damame/ir";
import type { Detector } from "../types.js";
import { eventRefs, finding } from "../helpers.js";

/**
 * Agent types this rule is willing to recommend, in preference order. The rule
 * only fires when one of them was listed in the session's own environment
 * snapshot (removed !== true) — we never claim the user had a tool they didn't.
 */
const DELEGABLE_AGENT_TYPES = ["Explore", "general-purpose"];

/**
 * Fires on long runs of consecutive main-thread read-only tool calls
 * (Read/Grep/Glob/…) inside a single turn when a delegable agent type was
 * available and no subagent was spawned anywhere in that turn. Every result of
 * such a run enters the main context and is re-carried by each subsequent
 * request; a subagent would have kept the raw output in its own context and
 * returned only conclusions.
 *
 * Savings are modeled, not measured: bytes/4 over the run's tool results is an
 * approximation of the read output that entered the main context, and it
 * assumes a subagent's returned summary would have been negligible next to it.
 */
export const missedDelegation: Detector = {
  id: "missed-delegation",
  version: "0.1.0",
  category: "delegation",
  summary: "Long main-thread read-only exploration while a delegable agent went unused",
  defaults: {
    min_run_length: 15,
  },
  detect(ctx): Finding[] {
    const min = ctx.config.min_run_length as number;
    const agentType = DELEGABLE_AGENT_TYPES.find((t) =>
      (ctx.env?.agents ?? []).some((a) => a.type === t && a.removed !== true),
    );
    if (!agentType) return [];

    const events = ctx.session.events;
    const indexById = new Map<string, number>();
    events.forEach((event, i) => indexById.set(event.event_id, i));

    const out: Finding[] = [];
    for (const run of ctx.metrics.read_only_runs) {
      if (run.length < min) continue;
      const turn = ctx.session.turns.find((t) => t.id === run.turn_id);
      if (!turn) continue;

      const inTurn = (eventId: string): boolean => {
        const i = indexById.get(eventId);
        return i !== undefined && i >= turn.first_event_index && i <= turn.last_event_index;
      };
      // The main thread did delegate inside this turn — the survey was not "missed".
      if (ctx.metrics.subagent_runs.some((s) => inTurn(s.event_id))) continue;

      const firstIdx = indexById.get(run.first_event_id);
      const lastIdx = indexById.get(run.last_event_id);
      if (firstIdx === undefined || lastIdx === undefined) continue;

      // All tool_calls between the run's endpoints are read-only by construction
      // (a state-changing call would have reset the run in the metrics pass).
      const runCallIds: string[] = [];
      for (let i = firstIdx; i <= lastIdx; i++) {
        const event = events[i]!;
        if (event.kind === "tool_call" && !event.on_abandoned_branch) runCallIds.push(event.event_id);
      }
      const callIdSet = new Set(runCallIds);

      // Sum the recorded output_bytes of the results linked to the run's calls.
      // The last call's result sits just past last_event_id, so scan to the turn end.
      let outputBytes = 0;
      const scanEnd = Math.min(turn.last_event_index, events.length - 1);
      for (let i = firstIdx; i <= scanEnd; i++) {
        const event = events[i]!;
        if (event.kind !== "tool_result" || event.on_abandoned_branch) continue;
        if (event.call_event_id && callIdSet.has(event.call_event_id)) {
          outputBytes += event.output_bytes ?? 0;
        }
      }

      const compactionInTurn = ctx.metrics.compactions.some((c) => inTurn(c.event_id));

      out.push(
        finding({
          rule: { id: this.id, version: this.version },
          category: this.category,
          severity: compactionInTurn ? "major" : "moderate",
          confidence: { source: "deterministic" },
          title: `${run.length} consecutive read-only calls in the main thread without delegation`,
          description:
            `One turn contained a run of ${run.length} consecutive read-only tool calls in the main thread ` +
            `with no subagent spawned in that turn. Each result entered the main context and was re-carried ` +
            `by every subsequent request. The ${agentType} agent was available in this session and could have ` +
            `performed the survey in a separate context, returning only the conclusions.` +
            (compactionInTurn
              ? ` The context grew until a compaction occurred within the same turn, discarding earlier detail.`
              : ``),
          evidence: {
            events: eventRefs(ctx.session, runCallIds),
            turn_ids: [run.turn_id],
            metrics: {
              run_length: run.length,
              read_output_bytes: outputBytes,
              compaction_in_turn: compactionInTurn,
              available_agent: agentType,
            },
          },
          ...(outputBytes > 0
            ? {
                savings: {
                  tokens: { value: Math.round(outputBytes / 4) },
                  method:
                    "sum of output_bytes/4 over the run's tool results — a bytes-per-token approximation " +
                    "of read output that entered the main context and was re-carried by subsequent " +
                    "requests; assumes a subagent's returned summary would have been negligible by comparison",
                  basis: "modeled",
                },
              }
            : {}),
          recommendation: {
            resource: { kind: "subagent", ref: agentType, available_in_session: true },
            rationale:
              `The ${agentType} agent was listed in this session's environment. Delegating a multi-file ` +
              `survey keeps the raw file contents in the subagent's context; only its final answer enters ` +
              `the main thread.`,
            example_invocation: `Ask the ${agentType} agent to survey the files and return only the conclusions`,
          },
        }),
      );
    }
    return out;
  },
};
