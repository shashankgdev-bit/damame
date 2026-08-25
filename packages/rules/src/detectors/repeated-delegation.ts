import type { Finding, Severity } from "@damame/ir";
import type { Detector } from "../types.js";
import { eventRefs, finding } from "../helpers.js";

/** Evidence lists the first N spawn calls of a family; the rest are counted, not cited. */
const MAX_EVIDENCE_EVENTS = 8;
/** How many raw descriptions to carry in evidence.metrics as illustration. */
const MAX_SAMPLE_DESCRIPTIONS = 3;

/**
 * Derive a stable "task family" key from a spawn description: lowercase,
 * collapse whitespace, replace digit runs with "#" (so "probe 3" and
 * "probe 12" agree), then keep only the first three tokens. The prefix is
 * where hand-written task names put their identity ("Cold-Opus probe <task>");
 * the tail is where the per-run parameters live, so it is deliberately dropped.
 */
function familyKey(description: string): string | undefined {
  const normalized = description
    .toLowerCase()
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized === "") return undefined;
  return normalized.split(" ").slice(0, 3).join(" ");
}

/**
 * Fires when the session re-improvised the same delegation by hand many
 * times: `min_occurrences` or more subagent spawns whose task descriptions
 * normalize to the same family key. Each of those spawns was a human- or
 * model-typed prompt reconstructing the same procedure from memory — a saved,
 * parameterized workflow would make it one command and guarantee every step
 * runs identically each time.
 *
 * No savings block is emitted: the repetition itself is not token waste (each
 * run did real, distinct work). The risk is drift and omission — every
 * re-typed variant of the procedure can silently diverge from the last — which
 * is a reliability cost, not a measurable token cost, so we do not model one.
 *
 * Runs on abandoned branches are skipped, as are runs whose spawn call has no
 * string `description` input (nothing to compare).
 */
export const repeatedDelegation: Detector = {
  id: "repeated-delegation",
  version: "0.1.0",
  category: "missed-resource",
  summary: "The same subagent delegation re-improvised by hand many times instead of saved as a workflow",
  defaults: {
    min_occurrences: 5,
  },
  detect(ctx): Finding[] {
    const min = ctx.config.min_occurrences as number;

    const eventById = new Map<string, (typeof ctx.session.events)[number]>();
    for (const event of ctx.session.events) eventById.set(event.event_id, event);

    interface Family {
      /** Spawn call event id when linked, else the subagent_run event id. */
      evidence_ids: string[];
      descriptions: string[];
    }
    const families = new Map<string, Family>();

    for (const event of ctx.session.events) {
      if (event.kind !== "subagent_run" || event.on_abandoned_branch) continue;

      const spawnCall = event.spawn_call_event_id ? eventById.get(event.spawn_call_event_id) : undefined;
      if (!spawnCall || spawnCall.kind !== "tool_call") continue;
      const description = spawnCall.input["description"];
      if (typeof description !== "string") continue;

      const key = familyKey(description);
      if (key === undefined) continue;

      const family = families.get(key) ?? { evidence_ids: [], descriptions: [] };
      family.evidence_ids.push(event.spawn_call_event_id ?? event.event_id);
      family.descriptions.push(description);
      families.set(key, family);
    }

    const out: Finding[] = [];
    for (const [key, family] of families) {
      const occurrences = family.evidence_ids.length;
      if (occurrences < min) continue;
      const severity: Severity = occurrences >= min * 3 ? "major" : "moderate";
      out.push(
        finding({
          rule: { id: this.id, version: this.version },
          category: this.category,
          severity,
          confidence: { source: "deterministic" },
          title: `${occurrences} subagent spawns re-improvised the same task ("${key} …")`,
          description:
            `This session spawned ${occurrences} subagents with near-identical task descriptions ` +
            `(family "${key}"), each one written out by hand at spawn time. Re-typing the same ` +
            `delegation reconstructs the procedure from memory on every occurrence, so each variant ` +
            `can silently drift from the last — a step reworded, reordered, or dropped — with no ` +
            `guarantee the runs were actually equivalent. A saved, parameterized workflow makes the ` +
            `repeated procedure a single command whose steps are identical by construction.`,
          evidence: {
            events: eventRefs(ctx.session, family.evidence_ids.slice(0, MAX_EVIDENCE_EVENTS)),
            metrics: {
              occurrences,
              family: key,
              sample_descriptions: family.descriptions.slice(0, MAX_SAMPLE_DESCRIPTIONS),
            },
          },
          recommendation: {
            resource: { kind: "prompting_pattern", ref: "save-as-named-workflow" },
            rationale:
              "A saved workflow with arguments turns the repeated procedure into one command and " +
              "guarantees every step runs identically on each invocation — the per-run variation " +
              "moves into parameters instead of re-typed prose.",
          },
        }),
      );
    }
    return out;
  },
};
