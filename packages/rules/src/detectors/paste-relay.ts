import type { Finding, Severity } from "@damame/ir";
import type { Detector } from "../types.js";
import { eventRefs, finding, formatTokens } from "../helpers.js";

/** Cap on cited events so a 100+-paste relay still produces a readable finding. */
const MAX_EVIDENCE_EVENTS = 8;

/**
 * Normalized shape signature of a pasted block: lowercase, whitespace
 * collapsed, every digit run replaced with "#", everything outside
 * [a-z0-9#] stripped, then truncated to the first 48 characters.
 * Normalization runs BEFORE truncation on purpose: varying number widths
 * ("7/10" vs "10/10") would otherwise shift the raw 48-char window and split
 * what is structurally the same template into many one-member groups.
 */
function shapeSignature(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\d+/g, "#")
    .replace(/[^a-z0-9#]/g, "")
    .slice(0, 48);
}

/**
 * Fires when the human repeatedly pastes large, structurally-similar blocks
 * into the chat: the same template shape (shared prefix, numbers normalized
 * away) arriving over and over as fresh human messages. That is a manual
 * data-ferrying loop — a drop-folder the session can Read, or a direct
 * connection to the source (browser MCP, a fetch script), would automate it.
 * A group fires when it has at least `min_occurrences` pastes of at least
 * `min_paste_bytes` each whose summed size crosses `min_total_bytes`.
 *
 * No savings block: the dominant cost is human time spent hand-ferrying,
 * which we cannot measure defensibly, and the per-paste context re-billing
 * cannot be attributed without guessing what the automated alternative would
 * have carried instead. The cost is described, not quantified.
 *
 * Meta messages and events on abandoned branches are skipped; pastes whose
 * signature normalizes to nothing (pure punctuation/whitespace) are excluded
 * rather than lumped into one accidental group.
 */
export const pasteRelay: Detector = {
  id: "paste-relay",
  version: "0.1.1", // 0.1.1: "pasted" → "entered" — the transcript proves arrival, not the clipboard
  category: "missed-resource",
  summary: "Human repeatedly pasted large structurally-similar blocks — a manual data-ferrying loop automation would remove",
  defaults: {
    min_paste_bytes: 600,
    min_occurrences: 6,
    min_total_bytes: 15_000,
    major_occurrence_multiple: 3,
  },
  detect(ctx): Finding[] {
    const minPasteBytes = ctx.config.min_paste_bytes as number;
    const minOccurrences = ctx.config.min_occurrences as number;
    const minTotalBytes = ctx.config.min_total_bytes as number;
    const majorMultiple = ctx.config.major_occurrence_multiple as number;

    const groups = new Map<string, { event_ids: string[]; total_bytes: number }>();
    for (const event of ctx.session.events) {
      if (event.kind !== "user_message") continue;
      if (event.on_abandoned_branch) continue;
      if (event.origin !== "human") continue;
      if (event.is_meta) continue;
      // text.length (UTF-16 code units) stands in for bytes; exact for the
      // ASCII-dominated pastes this rule targets.
      if (event.text.length < minPasteBytes) continue;
      const signature = shapeSignature(event.text);
      if (signature === "") continue;
      const group = groups.get(signature) ?? { event_ids: [], total_bytes: 0 };
      group.event_ids.push(event.event_id);
      group.total_bytes += event.text.length;
      groups.set(signature, group);
    }

    const out: Finding[] = [];
    for (const [signature, group] of groups) {
      const occurrences = group.event_ids.length;
      if (occurrences < minOccurrences) continue;
      if (group.total_bytes < minTotalBytes) continue;
      const severity: Severity = occurrences >= minOccurrences * majorMultiple ? "major" : "moderate";
      out.push(
        finding({
          rule: { id: this.id, version: this.version },
          category: this.category,
          severity,
          confidence: { source: "deterministic" },
          title: `${occurrences} structurally-similar blocks entered by hand (${formatTokens(group.total_bytes)} bytes)`,
          description:
            `The human entered ${occurrences} large blocks totalling ${formatTokens(group.total_bytes)} bytes ` +
            `that share the same structural shape (normalized signature "${signature}"). Repeating pastes of ` +
            `the same template is a manual data-ferrying loop: a watched file the session reads, or a direct ` +
            `connection to the source (browser MCP, a fetch script), would deliver the same data without a ` +
            `human copying each block. Every paste also enters the context window and is re-billed as fresh ` +
            `input by each subsequent request.`,
          evidence: {
            events: eventRefs(ctx.session, group.event_ids.slice(0, MAX_EVIDENCE_EVENTS)),
            metrics: {
              occurrences,
              total_bytes: group.total_bytes,
              signature,
            },
          },
          recommendation: {
            resource: { kind: "prompting_pattern", ref: "automate-data-ingestion" },
            rationale:
              "Drop the data into a watched file and have Claude read it, or let Claude reach the source " +
              "directly (browser MCP, a file drop, a script that fetches the data) instead of hand-ferrying " +
              "each block into the chat. Each manual paste costs human time and re-bills as fresh context on " +
              "every subsequent request.",
          },
        }),
      );
    }
    return out;
  },
};
