/**
 * Scrubs a real Claude Code transcript into a shareable fixture using the
 * allowlist-first sanitizer in @damame/testkit (see sanitize.ts for the
 * guarantees). Prints an audit of every string kept verbatim — review it, and
 * diff-review the output, before committing a fixture.
 *
 * Usage: npx tsx scripts/sanitize-fixture.ts <in.jsonl> <out.jsonl> [--max-string N] [--head N] [--compact]
 *   --max-string N  cap scrubbed strings at N chars (shrinks huge fixtures;
 *                   generate goldens AFTER this, lengths change)
 *   --head N        keep only the first N lines (slice big sessions)
 *   --compact       drop file-history/queue lines; keep only final ai-title/last-prompt
 */
import { readFileSync, writeFileSync } from "node:fs";
import { sanitizeTranscript } from "../packages/testkit/src/sanitize.js";

const args = process.argv.slice(2);
const [input, output] = args;
if (!input || !output) {
  console.error("usage: tsx scripts/sanitize-fixture.ts <in.jsonl> <out.jsonl> [--max-string N] [--head N] [--compact]");
  process.exit(1);
}
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : undefined;
};
const maxString = flag("--max-string");
const head = flag("--head");

let text = readFileSync(input, "utf8");
if (head) text = text.split("\n").slice(0, head).join("\n");

const compact = args.includes("--compact");
const { output: scrubbed, audit } = sanitizeTranscript(text, { ...(maxString ? { maxString } : {}), ...(compact ? { compact: true } : {}) });
writeFileSync(output, scrubbed);

console.error(`wrote ${scrubbed.length} bytes → ${output}`);
console.error(`\naudit — every string kept verbatim (${audit.length} distinct). REVIEW THIS LIST:`);
for (const entry of audit) console.error(`  ${entry}`);
