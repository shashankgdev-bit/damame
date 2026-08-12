/**
 * Scrubs a real Claude Code transcript into a shareable fixture:
 *  - all free text (prompts, assistant text, thinking, tool outputs, file
 *    contents) is replaced by 'x'-runs of the SAME LENGTH (lengths matter for
 *    byte/token-shaped metrics), except recognized error strings, which are
 *    kept verbatim because detectors classify them;
 *  - paths are rewritten under /scrubbed/, preserving depth and extension;
 *  - emails and uuids are rewritten deterministically (stable across the file);
 *  - usage numbers, timestamps, structure, and line order are preserved.
 *
 * Usage: npx tsx scripts/sanitize-fixture.ts <in.jsonl> <out.jsonl>
 * ALWAYS diff-review the output before committing a fixture.
 */
import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error("usage: tsx scripts/sanitize-fixture.ts <in.jsonl> <out.jsonl>");
  process.exit(1);
}

const KEEP_ERROR_PATTERNS = [
  /^Error: /,
  /^User rejected tool use$/,
  /^\[Request interrupted by user/,
  /String to replace not found/,
  /File has not been read yet/,
];

const uuidMap = new Map<string, string>();
let uuidCounter = 0;

function scrubUuid(id: string): string {
  let mapped = uuidMap.get(id);
  if (!mapped) {
    uuidCounter += 1;
    const h = createHash("sha256").update(String(uuidCounter)).digest("hex");
    mapped = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
    uuidMap.set(id, mapped);
  }
  return mapped;
}

function scrubPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  const scrubbed = parts.map((part, i) => (i === parts.length - 1 ? scrubBasename(part) : `d${i}`));
  return "/scrubbed/" + scrubbed.join("/");
}

function scrubBasename(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot) : "";
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return `f${createHash("sha256").update(stem).digest("hex").slice(0, 6)}${ext}`;
}

function scrubText(text: string): string {
  if (KEEP_ERROR_PATTERNS.some((p) => p.test(text))) return text;
  // keep whitespace structure so line counts survive
  return text.replace(/[^\s]/g, "x");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.]+/g;
const PATHLIKE_RE = /^(\/|~\/)[\w./ -]+$/;

const TEXT_KEYS = new Set(["text", "thinking", "content", "stdout", "stderr", "originalFile", "lastPrompt", "aiTitle", "description", "prompt", "snippet", "error"]);
const ID_KEYS = new Set(["uuid", "parentUuid", "sessionId", "leafUuid", "logicalParentUuid", "sourceToolAssistantUUID", "promptId", "snapshotMessageId", "messageId", "refusedUserMessageUuid"]);
const PATH_KEYS = new Set(["cwd", "file_path", "filePath", "path", "notebook_path", "trackingPath", "outputFile", "scriptPath", "transcriptDir"]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function scrub(value: any, key?: string): any {
  if (typeof value === "string") {
    if (key && ID_KEYS.has(key) && UUID_RE.test(value)) return scrubUuid(value);
    if (key && PATH_KEYS.has(key)) return scrubPath(value);
    if (key === "gitBranch" || key === "slug") return value; // harmless
    if (key && TEXT_KEYS.has(key)) {
      if (PATHLIKE_RE.test(value)) return scrubPath(value);
      return scrubText(value).replace(EMAIL_RE, "user@example.com");
    }
    if (UUID_RE.test(value)) return scrubUuid(value);
    return value.replace(EMAIL_RE, "user@example.com");
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v, key));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrub(v, k);
    return out;
  }
  return value;
}

const rl = createInterface({ input: createReadStream(input, { encoding: "utf8" }), crlfDelay: Infinity });
const out = createWriteStream(output);
let lines = 0;
for await (const line of rl) {
  if (!line.trim()) continue;
  try {
    out.write(JSON.stringify(scrub(JSON.parse(line))) + "\n");
    lines += 1;
  } catch {
    // drop malformed lines from fixtures
  }
}
out.end();
console.error(`scrubbed ${lines} lines → ${output}`);
console.error("REVIEW THE OUTPUT before committing: grep for anything that survived scrubbing.");
