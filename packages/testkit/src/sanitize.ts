import { createHash } from "node:crypto";

/**
 * Allowlist-first transcript sanitizer.
 *
 * Design principle: a string survives verbatim ONLY if it is provably
 * structural (enum-ish keys, ids, timestamps, tool names, recognized error
 * strings). Everything else — prompts, code, commands, edit strings, patches,
 * tool output, file contents — is replaced by a deterministic 'x'-run of the
 * SAME LENGTH (lengths feed byte/token-shaped metrics, and identical inputs
 * scrub identically so duplicate detection is preserved). This inverts the
 * usual blocklist approach: an unknown future field leaks nothing.
 *
 * Invariant (tested): running the analyzer on a sanitized transcript yields
 * the same rule firings and the same deduped usage totals as the original.
 */

export interface SanitizeOptions {
  /** Cap scrubbed strings at this length (breaks length fidelity — goldens must be generated AFTER truncation). */
  maxString?: number;
}

export interface SanitizeState {
  ids: Map<string, string>;
  counter: number;
  /** Strings kept verbatim that the audit should surface for human review. */
  audit: Set<string>;
}

export function createSanitizeState(): SanitizeState {
  return { ids: new Map(), counter: 0, audit: new Set() };
}

/** Values under these keys are enum-ish/structural — kept verbatim. */
const KEEP_KEYS = new Set([
  "type", "subtype", "role", "model", "level", "trigger", "operation", "kind", "status",
  "service_tier", "speed", "inference_geo", "stop_reason", "stop_sequence", "entrypoint",
  "userType", "version", "gitBranch", "permissionMode", "promptSource", "effort",
  "commandMode", "agentType", "attributionSkill", "attributionPlugin", "reminderType",
  "direction", "apiRefusalCategory", "taskType", "returnCodeInterpretation", "reason",
]);

/** Arrays of names/types that detectors match against — kept verbatim. */
const KEEP_LIST_KEYS = new Set([
  "names", "addedTypes", "removedTypes", "addedNames", "removedNames", "readdedNames",
  "needsAuthMcpServers", "pendingMcpServers", "preCompactDiscoveredTools",
]);

/** Values under these keys are ids — deterministically remapped. */
const ID_KEYS = new Set([
  "uuid", "parentUuid", "sessionId", "leafUuid", "logicalParentUuid",
  "sourceToolAssistantUUID", "promptId", "messageId", "snapshotMessageId",
  "refusedUserMessageUuid", "requestId", "id", "tool_use_id", "call_id", "agentId",
  "taskId", "runId", "backgroundTaskId", "toolUseId", "slug",
]);

const PATH_KEYS = new Set([
  "cwd", "file_path", "filePath", "path", "notebook_path", "trackingPath", "outputFile",
  "scriptPath", "transcriptDir", "displayPath", "filename", "installPath",
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREFIXED_ID_RE = /^(msg_|req_|toolu_|wf_|agent-|srvtoolu_)[\w-]+$/;
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?$/;
const SHORT_TOKEN_RE = /^[\w.:\/@-]{1,64}$/;

/**
 * Error strings the adapter classifies on. Only the ANCHORED, matched prefix
 * survives; everything after it is scrubbed — an "Error: Exit code 1" followed
 * by a stack trace keeps the signature and loses the trace. All patterns are
 * ^-anchored: an unanchored pattern would keep any content that merely quotes
 * an error sentence (a real leak found in testing).
 */
const KEEP_ERROR_PREFIXES = [
  /^Error: String to replace not found in file\./,
  /^Error: Found \d+ matches of the string to replace/,
  /^Error: File has not been read yet\.?/,
  /^Error: File does not exist\.?/,
  /^Error: Exit code \d+/,
  /^Error: /,
  /^User rejected tool use$/,
  /^The user doesn't want to proceed with this tool use\./,
  /^\[Request interrupted by user( for tool use)?\]/,
  /^API Error: /,
  /^Command timed out( after [\d.]+\w*( [\d.]+\w*)?)?/,
  /^This session is being continued from a previous conversation/,
];

function remapId(value: string, state: SanitizeState): string {
  let mapped = state.ids.get(value);
  if (mapped) return mapped;
  state.counter += 1;
  const h = createHash("sha256").update(`damame-scrub-${state.counter}`).digest("hex");
  if (UUID_RE.test(value)) {
    mapped = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  } else {
    const prefix = PREFIXED_ID_RE.exec(value)?.[1] ?? "id_";
    mapped = `${prefix}scrub${String(state.counter).padStart(4, "0")}`;
  }
  state.ids.set(value, mapped);
  return mapped;
}

export function scrubPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  const mapped = parts.map((part, i) => {
    if (i === parts.length - 1) {
      const dot = part.lastIndexOf(".");
      const ext = dot > 0 ? part.slice(dot) : "";
      const stem = dot > 0 ? part.slice(0, dot) : part;
      return `f${createHash("sha256").update(stem).digest("hex").slice(0, 6)}${ext}`;
    }
    return `d${createHash("sha256").update(part).digest("hex").slice(0, 4)}`;
  });
  return "/scrubbed/" + mapped.join("/");
}

function xRun(text: string, opts: SanitizeOptions): string {
  // Preserve whitespace structure so line/length shapes survive.
  let scrubbed = text.replace(/[^\s]/g, "x");
  if (opts.maxString && scrubbed.length > opts.maxString) scrubbed = scrubbed.slice(0, opts.maxString);
  return scrubbed;
}

function scrubText(text: string, opts: SanitizeOptions): string {
  for (const pattern of KEEP_ERROR_PREFIXES) {
    const match = pattern.exec(text);
    if (match) {
      const rest = text.slice(match[0].length);
      return rest ? match[0] + xRun(rest, opts) : match[0];
    }
  }
  return xRun(text, opts);
}

/** JSON object keys can carry data too (paths, question text) — sanitize them. */
const KEY_TOKEN_RE = /^[A-Za-z0-9_$.-]{1,64}$/;

function scrubKey(key: string, state: SanitizeState): string {
  if (KEY_TOKEN_RE.test(key)) return key; // ordinary field name
  const h = createHash("sha256").update(key).digest("hex").slice(0, 8);
  if (key.startsWith("/") || key.startsWith("~/")) return `${scrubPath(key)}#k${h}`;
  void state;
  return `scrubbed-key-${h}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sanitizeValue(value: any, key: string | undefined, state: SanitizeState, opts: SanitizeOptions): any {
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    if (key && ID_KEYS.has(key)) {
      if (key === "slug") return "scrubbed-session-slug";
      return UUID_RE.test(value) || PREFIXED_ID_RE.test(value) || value.length >= 8 ? remapId(value, state) : value;
    }
    if (UUID_RE.test(value)) return remapId(value, state);
    if (ISO_TS_RE.test(value)) return value;
    if (key && PATH_KEYS.has(key)) return scrubPath(value);
    if (key && KEEP_KEYS.has(key)) {
      if (SHORT_TOKEN_RE.test(value)) {
        state.audit.add(`${key}=${value}`);
        return value;
      }
      return scrubText(value, opts); // a "structural" field with prose in it — scrub
    }
    if (key === "name" && SHORT_TOKEN_RE.test(value)) {
      // tool / skill / agent names — detectors match on these
      state.audit.add(`name=${value}`);
      return value;
    }
    return scrubText(value, opts);
  }
  if (Array.isArray(value)) {
    if (key && KEEP_LIST_KEYS.has(key)) {
      return value.map((v) => {
        if (typeof v === "string" && SHORT_TOKEN_RE.test(v)) {
          state.audit.add(`${key}[]=${v}`);
          return v;
        }
        return sanitizeValue(v, undefined, state, opts);
      });
    }
    return value.map((v) => sanitizeValue(v, key, state, opts));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[scrubKey(k, state)] = sanitizeValue(v, k, state, opts);
    return out;
  }
  return value;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function sanitizeLine(line: Record<string, any>, state: SanitizeState, opts: SanitizeOptions = {}): Record<string, any> {
  return sanitizeValue(line, undefined, state, opts);
}

/** Line types that carry no analysis signal and dominate fixture size. */
const COMPACT_DROP_TYPES = new Set(["file-history-snapshot", "file-history-delta", "queue-operation"]);
/** Repeated pointer lines — under --compact only the last of each survives. */
const COMPACT_LAST_ONLY_TYPES = new Set(["ai-title", "last-prompt"]);

export function sanitizeTranscript(
  jsonl: string,
  opts: SanitizeOptions & { compact?: boolean } = {},
): { output: string; audit: string[] } {
  const state = createSanitizeState();
  const out: string[] = [];
  const lastOnly = new Map<string, string>(); // type → sanitized line (last wins)
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (opts.compact && typeof parsed.type === "string") {
        if (COMPACT_DROP_TYPES.has(parsed.type)) continue;
        if (COMPACT_LAST_ONLY_TYPES.has(parsed.type)) {
          lastOnly.set(parsed.type, JSON.stringify(sanitizeLine(parsed, state, opts)));
          continue;
        }
      }
      out.push(JSON.stringify(sanitizeLine(parsed, state, opts)));
    } catch {
      // malformed lines are dropped from fixtures
    }
  }
  out.push(...lastOnly.values());
  return { output: out.join("\n") + "\n", audit: [...state.audit].sort() };
}
