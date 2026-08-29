import type { Finding } from "@damame/ir";
import type { Detector } from "../types.js";
import { eventRefs, finding, formatBytes } from "../helpers.js";

/**
 * Fires when a compaction measurably forced re-purchasing of content the
 * pile already held: reads AFTER the compaction whose input_hash matches a
 * successful read BEFORE it and whose result came back with an IDENTICAL
 * output_hash. Output identity is the entire guard — if anything had
 * changed the content (an edit, a Bash side effect, the user), the hashes
 * would differ and the pair is excluded automatically. The claim "this
 * re-read added nothing new" is proven, not inferred.
 *
 * This is the receipt for the quality argument the hygiene rules can only
 * state as mechanism: "compaction loses fidelity." Here the loss has a
 * byte count and line-level evidence.
 *
 * Ownership: these pairs are excluded from duplicate-tool-call (the
 * duplicate analysis groups per compaction era) — the cause is the
 * compaction, so this rule owns them. One crime, one bill.
 *
 * Known undercount, accepted: a post-compaction re-read with different
 * arguments (an offset/limit slice of a file read whole before) has a
 * different input_hash and is invisible here. The metric therefore reports
 * a floor, never an estimate — the honest direction to be wrong in.
 *
 * Thresholds — measured, not guessed (calibrated on the real sessions
 * available, 28 live compactions across two multi-week transcripts): the
 * noise tail was 1-2 identical re-reads totaling ≤19KB per compaction;
 * the one genuine incident was 32 re-reads / 62KB after a single
 * compaction. min_rereads 3 and min_reread_bytes 20KB sit in the gap on
 * both axes.
 */
export const compactionRework: Detector = {
  id: "compaction-rework",
  version: "0.1.0",
  category: "context-hygiene",
  summary: "A compaction forced re-reading of content the context already held — the measured price of the summary",
  defaults: {
    min_rereads: 3,
    min_reread_bytes: 20_000,
    moderate_reread_bytes: 100_000,
    moderate_rereads: 10,
  },
  detect(ctx): Finding[] {
    const minRereads = ctx.config.min_rereads as number;
    const minBytes = ctx.config.min_reread_bytes as number;
    const modBytes = ctx.config.moderate_reread_bytes as number;
    const modRereads = ctx.config.moderate_rereads as number;

    const out: Finding[] = [];
    for (const rework of ctx.metrics.compaction_rework) {
      const count = rework.reread_call_event_ids.length;
      if (count < minRereads || rework.reread_bytes < minBytes) continue;
      const severity = rework.reread_bytes >= modBytes || count >= modRereads ? "moderate" : "minor";
      const savedTokens = Math.round(rework.reread_bytes / 4);
      const fileSample = rework.files.slice(0, 3).join(", ");

      out.push(
        finding({
          rule: { id: this.id, version: this.version },
          category: this.category,
          severity,
          confidence: { source: "deterministic" },
          title: `A compaction forced ${count} re-reads of already-loaded content (${formatBytes(rework.reread_bytes)} re-purchased)`,
          description:
            `After a context compaction, ${count} read(s) re-fetched content the conversation had already ` +
            `loaded before it — and every one came back byte-identical (proven by output hash), so nothing ` +
            `had changed except the summary dropping it. ${formatBytes(rework.reread_bytes)} of content was ` +
            `re-purchased (${fileSample}). This is the measured price of compaction losing fidelity: the ` +
            `summary kept the file names but not the file contents.`,
          evidence: {
            events: eventRefs(ctx.session, [
              rework.compaction_event_id,
              ...rework.reread_call_event_ids.slice(0, 6),
            ]),
            metrics: {
              reread_count: count,
              reread_bytes: rework.reread_bytes,
            },
          },
          savings: {
            tokens: savedTokens,
            basis: "modeled",
            method:
              `${count} identical re-read result(s) totaling ${rework.reread_bytes} bytes / 4 bytes-per-token ` +
              `— identity proven by matching output hashes across the compaction; assumes byte-to-token ≈ 4:1. ` +
              `A floor, not an estimate: re-reads with different arguments are not counted.`,
          },
          recommendation: {
            resource: { kind: "prompting_pattern", ref: "session-per-task-bootstrap" },
            rationale:
              "Compaction re-purchases are a symptom of one session carrying too much: smaller per-task " +
              "sessions briefed by a notes file rarely compact at all, and durable file knowledge survives " +
              "in the files themselves instead of a summary.",
          },
        }),
      );
    }
    return out;
  },
};
