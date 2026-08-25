import type { Finding } from "@damame/ir";
import type { Detector } from "../types.js";
import { eventRefs, finding } from "../helpers.js";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * Strip location/env noise and reduce a command to its habitual "shape":
 * leading `cd <path> &&` / `export X=Y &&` prefixes removed, whitespace
 * collapsed, digit runs masked, first three tokens kept. Two runs of the
 * same ritual in different task folders normalize to the same family.
 */
export function normalizeCommand(cmd: string): string {
  let c = cmd.replace(/\s+/g, " ").trim();
  for (let i = 0; i < 3; i++) {
    c = c.replace(/^cd \S+ *(&&|;)? */, "").replace(/^export \S+=\S+ *(&&|;)? */, "");
  }
  c = c.toLowerCase().replace(/[0-9]+/g, "#");
  return c.split(" ").slice(0, 3).join(" ");
}

/**
 * Fires when the same (normalized) command habitually follows file edits —
 * the fingerprint of a reflex living as manual labor instead of a hook.
 * Pairing is conservative: only the FIRST Bash call after an edit, within the
 * same turn, counts, and each edit contributes at most one pair. A family
 * fires at `min_occurrences` post-edit runs.
 *
 * Calibrated on three real sessions from different domains before shipping:
 * habitual check families sat at 10–48 post-edit occurrences while the noise
 * tail stayed ≤6, in all three. Threshold 10 sits in the measured gap.
 *
 * Severity is always "minor" and NO savings are claimed, deliberately: the
 * command runs either way — what a hook adds is guarantee (it cannot be
 * forgotten under context pressure) and the disappearance of ask-and-wait
 * turns, neither of which is a defensible token number. Who initiated each
 * run (the human asking, or Claude deciding) is deliberately ignored: the
 * regularity itself is the signal, and the hook recommendation is identical.
 */
export const postEditRitual: Detector = {
  id: "post-edit-ritual",
  version: "0.1.0",
  category: "missed-resource",
  summary: "The same command habitually follows file edits — a reflex that could be a hook",
  defaults: {
    min_occurrences: 10,
  },
  detect(ctx): Finding[] {
    const minOccurrences = ctx.config.min_occurrences as number;
    const families = new Map<string, { event_ids: string[]; sample: string }>();
    let pendingEditTurn: string | null = null;
    for (const e of ctx.session.events) {
      if (e.on_abandoned_branch) continue;
      if (e.kind !== "tool_call") continue;
      if (EDIT_TOOLS.has(e.name)) {
        pendingEditTurn = e.turn_id ?? null;
      } else if (e.name === "Bash" && pendingEditTurn !== null && e.turn_id === pendingEditTurn) {
        const raw = typeof e.input.command === "string" ? e.input.command : "";
        const key = normalizeCommand(raw);
        if (key) {
          const fam = families.get(key) ?? { event_ids: [], sample: raw.replace(/\s+/g, " ").slice(0, 100) };
          fam.event_ids.push(e.event_id);
          families.set(key, fam);
        }
        pendingEditTurn = null; // one pair per edit, first Bash only
      }
    }

    const out: Finding[] = [];
    for (const [family, fam] of families) {
      const occurrences = fam.event_ids.length;
      if (occurrences < minOccurrences) continue;
      out.push(
        finding({
          rule: { id: this.id, version: this.version },
          category: this.category,
          severity: "minor",
          confidence: { source: "deterministic" },
          title: `The same check followed file edits ${occurrences} times ("${fam.sample.slice(0, 48)}…")`,
          description:
            `After editing files, the same command family ran ${occurrences} times in this session ` +
            `("${fam.sample}"). A reaction this regular is a reflex living as manual labor: wired as a ` +
            `PostToolUse hook it runs automatically after every edit — guaranteed, unforgettable under ` +
            `context pressure, and with no ask-and-run turns. Running it by hand was never wrong; this is ` +
            `an automation opportunity, not waste.`,
          evidence: {
            events: eventRefs(ctx.session, fam.event_ids.slice(0, 8)),
            metrics: {
              occurrences,
              family,
              sample_command: fam.sample,
            },
          },
          recommendation: {
            resource: { kind: "config", ref: "hooks-post-edit" },
            rationale:
              "A PostToolUse hook on Write|Edit runs this check automatically after every edit — the " +
              "recipe includes the exact settings snippet to adapt.",
          },
        }),
      );
    }
    return out;
  },
};
