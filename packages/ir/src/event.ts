import { z } from "zod";
import { UsageSchema } from "./usage.js";

/** Stable reference to an event, usable across sessions (parent ↔ subagent). */
export const EventRefSchema = z.object({
  session_id: z.string(),
  event_id: z.string(),
});
export type EventRef = z.infer<typeof EventRefSchema>;

/**
 * Pointer back to the original source record. `file` is the transcript path,
 * `line` the 1-based line number. IR fields are a projection; this is the
 * lossless escape hatch (and what report renderers deep-link to).
 */
export const RawRefSchema = z.object({
  file: z.string(),
  line: z.number().int().positive(),
});
export type RawRef = z.infer<typeof RawRefSchema>;

const SourceIdsSchema = z.object({
  uuid: z.string().optional(),
  request_id: z.string().optional(),
  message_id: z.string().optional(),
  parent_uuid: z.string().nullable().optional(),
});

/**
 * Common envelope. Ordering (`index`) is ground truth; ids, timestamps and
 * threading are optional overlays because not every source has them.
 */
const base = {
  event_id: z.string(),
  index: z.number().int().nonnegative(),
  turn_id: z.string().optional(),
  timestamp: z.string().optional(), // ISO-8601
  parent_event_id: z.string().optional(),
  source_ids: SourceIdsSchema.optional(),
  raw_ref: RawRefSchema,
  /** true when the event sits on a branch abandoned via fork (escape/retry). */
  on_abandoned_branch: z.boolean().optional(),
};

export const UserMessageEventSchema = z.object({
  ...base,
  kind: z.literal("user_message"),
  text: z.string(),
  origin: z.enum(["human", "task_notification", "queued", "synthetic"]),
  image_count: z.number().int().nonnegative().optional(),
  /** Harness-injected content (isMeta) — not typed by the human. */
  is_meta: z.boolean().optional(),
  is_compact_summary: z.boolean().optional(),
  slash_command: z.object({ name: z.string(), args: z.string().optional() }).optional(),
  permission_mode: z.string().optional(),
});

export const AssistantMessageEventSchema = z.object({
  ...base,
  kind: z.literal("assistant_message"),
  model: z.string().optional(),
  text: z.string().optional(),
  stop_reason: z.string().nullable().optional(),
  effort: z.string().optional(),
  attribution: z.object({ skill: z.string().optional(), plugin: z.string().optional() }).optional(),
  /** Exactly one Usage per API response (adapter dedupes by message.id). */
  usage: UsageSchema.optional(),
  cache_miss: z
    .object({ reason: z.string(), missed_input_tokens: z.number().int().nonnegative().optional() })
    .optional(),
  /** Synthetic placeholder emitted after terminal API errors (model "<synthetic>"). */
  is_error_placeholder: z.boolean().optional(),
  /** First-block latency vs the triggering user event, when computable. */
  ttfb_ms: z.number().int().nonnegative().optional(),
});

export const ThinkingEventSchema = z.object({
  ...base,
  kind: z.literal("thinking"),
  text: z.string(),
  text_truncated: z.boolean().optional(),
  model: z.string().optional(),
});

export const ToolCallEventSchema = z.object({
  ...base,
  kind: z.literal("tool_call"),
  name: z.string(),
  /** Input with oversized string values truncated; hash computed pre-truncation. */
  input: z.record(z.unknown()),
  input_truncated: z.boolean().optional(),
  call_id: z.string().optional(),
  /** sha256 of canonical JSON of (name, full input) — duplicate detection. */
  input_hash: z.string(),
  model: z.string().optional(),
});

export const ToolResultEventSchema = z.object({
  ...base,
  kind: z.literal("tool_result"),
  call_event_id: z.string().optional(),
  call_id: z.string().optional(),
  tool_name: z.string().optional(),
  is_error: z.boolean().optional(),
  /**
   * Normalized error class, e.g. "edit_string_not_found" | "file_not_read" |
   * "exit_code_nonzero" | "user_rejected" | "generic_error".
   */
  error_signature: z.string().optional(),
  output_text: z.string().optional(),
  output_text_truncated: z.boolean().optional(),
  output_bytes: z.number().int().nonnegative().optional(),
  /** sha256 of the full output — lets detectors prove two results were identical. */
  output_hash: z.string().optional(),
  /** Compact projection of object-typed toolUseResult (small fields only). */
  structured: z.record(z.unknown()).optional(),
  duration_ms: z.number().int().nonnegative().optional(),
  user_modified: z.boolean().optional(),
});

export const InterruptionEventSchema = z.object({
  ...base,
  kind: z.literal("interruption"),
  scope: z.enum(["request", "tool_use"]),
  abandoned_branch: z
    .object({
      root_event_id: z.string(),
      event_count: z.number().int().nonnegative(),
      usage: UsageSchema.optional(),
    })
    .optional(),
});

export const PermissionDenialEventSchema = z.object({
  ...base,
  kind: z.literal("permission_denial"),
  call_event_id: z.string().optional(),
  call_id: z.string().optional(),
  tool_name: z.string().optional(),
});

export const CompactionEventSchema = z.object({
  ...base,
  kind: z.literal("compaction"),
  trigger: z.string().optional(),
  pre_tokens: z.number().int().nonnegative().optional(),
  post_tokens: z.number().int().nonnegative().optional(),
  duration_ms: z.number().int().nonnegative().optional(),
  logical_parent_uuid: z.string().optional(),
});

export const SubagentRunEventSchema = z.object({
  ...base,
  kind: z.literal("subagent_run"),
  spawn_call_event_id: z.string().optional(),
  spawn_tool: z.string(),
  child_ref: z.string().optional(), // agentId or workflow runId
  child_kind: z.enum(["agent", "workflow"]).optional(),
  agent_type: z.string().optional(),
  /** Resolved workflow name as recorded by the harness in the tool result. */
  name: z.string().optional(),
  resolved_model: z.string().optional(),
  is_async: z.boolean().optional(),
  status: z.string().optional(),
  /** Rollup from the child session when it was ingested. */
  usage: UsageSchema.optional(),
});

export const SystemEventSchema = z.object({
  ...base,
  kind: z.literal("system_event"),
  subtype: z.enum(["api_error", "model_refusal_fallback", "other"]),
  detail: z.record(z.unknown()),
});

export const EventSchema = z.discriminatedUnion("kind", [
  UserMessageEventSchema,
  AssistantMessageEventSchema,
  ThinkingEventSchema,
  ToolCallEventSchema,
  ToolResultEventSchema,
  InterruptionEventSchema,
  PermissionDenialEventSchema,
  CompactionEventSchema,
  SubagentRunEventSchema,
  SystemEventSchema,
]);

export type UserMessageEvent = z.infer<typeof UserMessageEventSchema>;
export type AssistantMessageEvent = z.infer<typeof AssistantMessageEventSchema>;
export type ThinkingEvent = z.infer<typeof ThinkingEventSchema>;
export type ToolCallEvent = z.infer<typeof ToolCallEventSchema>;
export type ToolResultEvent = z.infer<typeof ToolResultEventSchema>;
export type InterruptionEvent = z.infer<typeof InterruptionEventSchema>;
export type PermissionDenialEvent = z.infer<typeof PermissionDenialEventSchema>;
export type CompactionEvent = z.infer<typeof CompactionEventSchema>;
export type SubagentRunEvent = z.infer<typeof SubagentRunEventSchema>;
export type SystemEvent = z.infer<typeof SystemEventSchema>;
export type Event = z.infer<typeof EventSchema>;
export type EventKind = Event["kind"];
