import type { Finding, ToolCallEvent } from "@damame/ir";
import type { Detector } from "../types.js";
import { eventRefs, finding, formatTokens } from "../helpers.js";

/** Tools whose repetition is part of their normal protocol, never waste. */
const SKIPPED_TOOLS = new Set(["TodoWrite", "AskUserQuestion"]);

/**
 * Fires on groups of tool calls with identical input (same pre-truncation
 * input_hash) that returned byte-identical output (same output_hash on every
 * occurrence) with no successful state-changing call between the first and
 * last occurrence — i.e. the repeats could not have observed anything new.
 *
 * Re-running a call after a state change (e.g. re-running tests after an Edit)
 * is correct behavior and is excluded by the `state_change_between` guard in
 * the metrics pass. Savings are modeled, not measured: the bytes of output
 * re-injected by the repeats divided by 4 approximates the tokens the repeats
 * added to context; the first occurrence is never counted.
 */
export const duplicateToolCall: Detector = {
  id: "duplicate-tool-call",
  version: "0.1.0",
  category: "redundant-work",
  summary: "Identical tool calls repeated with byte-identical results and no state change between",
  defaults: {
    min_occurrences: 3,
    min_repeated_bytes: 20_000,
  },
  detect(ctx): Finding[] {
    const minOccurrences = ctx.config.min_occurrences as number;
    const minRepeatedBytes = ctx.config.min_repeated_bytes as number;
    const out: Finding[] = [];

    let callsById: Map<string, ToolCallEvent> | undefined;
    const lookupCall = (eventId: string): ToolCallEvent | undefined => {
      if (!callsById) {
        callsById = new Map();
        for (const event of ctx.session.events) {
          if (event.kind === "tool_call") callsById.set(event.event_id, event);
        }
      }
      return callsById.get(eventId);
    };

    for (const group of ctx.metrics.duplicate_tool_calls) {
      if (SKIPPED_TOOLS.has(group.tool_name)) continue;
      if (!group.identical_results) continue;
      if (group.state_change_between) continue;
      const occurrences = group.call_event_ids.length;
      const meetsCount = occurrences >= minOccurrences;
      const meetsBytes = group.repeated_output_bytes >= minRepeatedBytes;
      if (!meetsCount && !meetsBytes) continue;

      const repeats = occurrences - 1;
      const target = callTarget(lookupCall(group.call_event_ids[0]!));
      const modeledTokens = Math.round(group.repeated_output_bytes / 4);
      out.push(
        finding({
          rule: { id: this.id, version: this.version },
          category: this.category,
          severity: meetsBytes ? "moderate" : "minor",
          confidence: { source: "deterministic" },
          title: `${group.tool_name}${target ? ` of ${target}` : ""} called ${occurrences} times with identical input and output`,
          description:
            `The same ${group.tool_name} call was issued ${occurrences} times with identical input and ` +
            `returned byte-identical output every time; no state-changing tool call succeeded between the ` +
            `first and last occurrence, so the repeats could not have observed anything new. The ` +
            `${repeats === 1 ? "repeat" : `${repeats} repeats`} re-injected ` +
            `${group.repeated_output_bytes} bytes (~${formatTokens(modeledTokens)} tokens) of already-seen ` +
            `output into the context.`,
          evidence: {
            events: eventRefs(ctx.session, group.call_event_ids),
            metrics: {
              occurrences,
              tool_name: group.tool_name,
              input_hash: group.input_hash,
              repeated_output_bytes: group.repeated_output_bytes,
            },
          },
          ...(group.repeated_output_bytes > 0
            ? {
                savings: {
                  tokens: { value: modeledTokens },
                  method:
                    "repeated_output_bytes / 4 — the bytes of output re-injected by occurrences after the " +
                    "first, converted to tokens with the ~4 bytes/token approximation",
                  basis: "modeled" as const,
                },
              }
            : {}),
          recommendation: {
            resource: { kind: "prompting_pattern", ref: "reference-earlier-output" },
            rationale:
              "The output was already in context from the first call. Referring back to the earlier result " +
              "(the file content, command output, or search hits already shown) avoids re-running the call " +
              "and re-paying for its output; only re-run after something has actually changed.",
          },
        }),
      );
    }
    return out;
  },
};

/** Short human label for the duplicated call's target, when the input has one. */
function callTarget(call: ToolCallEvent | undefined): string | undefined {
  if (!call) return undefined;
  const input = call.input;
  if (typeof input.file_path === "string") {
    const parts = input.file_path.split("/");
    return parts.slice(-2).join("/");
  }
  if (typeof input.command === "string") {
    return `\`${input.command.replace(/\s+/g, " ").trim().slice(0, 80)}\``;
  }
  if (typeof input.pattern === "string") return `pattern "${input.pattern.slice(0, 80)}"`;
  return undefined;
}
