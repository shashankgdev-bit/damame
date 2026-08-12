import type { Finding } from "@damame/ir";
import type { Detector } from "../types.js";
import { eventRefs, finding, formatTokens } from "../helpers.js";

/**
 * Fires on full-file Reads (no offset/limit) whose results were large enough
 * (≥ ~80KB, thresholded by the metrics pass) that the entire file body entered
 * the model context. One finding per file: repeated full reads of the same
 * large file are grouped and raise the severity.
 *
 * Savings are modeled, never measured: we cannot know which bytes were
 * actually needed, so the estimate assumes a targeted read of
 * `assumed_targeted_bytes` would have sufficed and converts the excess at
 * 4 bytes/token. The method string states both assumptions.
 */
export const oversizedContextReads: Detector = {
  id: "oversized-context-reads",
  version: "0.1.0",
  category: "context-hygiene",
  summary: "Full-file Reads of large files pulled entirely into context without offset/limit",
  defaults: {
    min_reads: 1,
    assumed_targeted_bytes: 8_000,
  },
  detect(ctx): Finding[] {
    const minReads = ctx.config.min_reads as number;
    const assumedTargetedBytes = ctx.config.assumed_targeted_bytes as number;

    // Group by file path; reads without a recorded path each stand alone.
    const groups = new Map<string, typeof ctx.metrics.large_full_reads>();
    for (const read of ctx.metrics.large_full_reads) {
      const key = read.file_path ?? `<no-path:${read.call_event_id}>`;
      const list = groups.get(key) ?? [];
      list.push(read);
      groups.set(key, list);
    }

    const exploreAvailable =
      ctx.env?.agents.some((a) => a.type === "Explore" && a.removed !== true) ?? false;

    const out: Finding[] = [];
    for (const [key, reads] of groups) {
      if (reads.length < minReads) continue;
      const filePath = reads[0]!.file_path;
      const totalBytes = reads.reduce((sum, r) => sum + r.output_bytes, 0);
      const excessBytes = reads.reduce(
        (sum, r) => sum + Math.max(0, r.output_bytes - assumedTargetedBytes),
        0,
      );
      const modeledTokens = Math.round(excessBytes / 4);
      const approxTokensLoaded = Math.round(totalBytes / 4);
      out.push(
        finding({
          rule: { id: this.id, version: this.version },
          category: this.category,
          severity: reads.length >= 2 ? "moderate" : "minor",
          confidence: { source: "deterministic" },
          title:
            reads.length >= 2
              ? `${reads.length} full reads of ${shortPath(filePath)} loaded ~${formatTokens(approxTokensLoaded)} tokens into context`
              : `Full read of ${shortPath(filePath)} loaded ~${formatTokens(approxTokensLoaded)} tokens into context`,
          description:
            `${reads.length === 1 ? "A Read call" : `${reads.length} Read calls`} on ` +
            `${filePath ?? "a large file"} used no offset or limit, so the full ${totalBytes} bytes ` +
            `(~${approxTokensLoaded} tokens) entered the model context and are carried in every ` +
            `subsequent request until compaction. Scoping the read with offset/limit, or locating the ` +
            `relevant region with Grep first, keeps the context to the part of the file that is actually used.`,
          evidence: {
            events: eventRefs(
              ctx.session,
              reads.flatMap((r) => [r.call_event_id, r.result_event_id]),
            ),
            metrics: {
              read_count: reads.length,
              total_output_bytes: totalBytes,
              ...(filePath !== undefined ? { file_path: filePath } : { group_key: key }),
            },
          },
          savings: {
            tokens: { value: modeledTokens },
            method:
              `sum over ${reads.length} read(s) of (output_bytes − ${assumedTargetedBytes}) / 4 — ` +
              `assumes 4 bytes per token and that a targeted read of ~${assumedTargetedBytes} bytes ` +
              `would have sufficed`,
            basis: "modeled",
          },
          recommendation: {
            resource: { kind: "prompting_pattern", ref: "targeted-reads" },
            rationale:
              "Grep for the symbol or section first, then Read only that region with offset/limit. " +
              "The rest of the file never enters context, and later requests stay smaller." +
              (exploreAvailable
                ? " For broader exploration of large files, the Explore subagent (available in this " +
                  "session) can scan them in its own context and return only a summary."
                : ""),
            example_invocation:
              'Grep(pattern: "functionName", path: "src/") then Read(file_path, offset: <line>, limit: 80)',
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
