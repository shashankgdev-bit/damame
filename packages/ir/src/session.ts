import { z } from "zod";
import { EventSchema } from "./event.js";
import { UsageSchema } from "./usage.js";

export const IR_VERSION = "0.1.0";

/**
 * What was available *in that session* — the only honest baseline for
 * "you had X and didn't use it" findings. Primary source: the transcript's own
 * attachment lines (skill_listing / agent_listing_delta / deferred_tools_delta),
 * never current disk state, which drifts.
 */
export const EnvironmentSnapshotSchema = z.object({
  captured_from: z.array(z.enum(["transcript_attachments", "disk_config", "static_table", "observed_use"])),
  skills: z.array(
    z.object({
      name: z.string(),
      description: z.string().optional(),
      source: z.enum(["session_listing", "disk"]),
    }),
  ),
  agents: z.array(
    z.object({
      type: z.string(),
      description: z.string().optional(),
      removed: z.boolean().optional(),
    }),
  ),
  deferred_tools: z.array(
    z.object({
      name: z.string(),
      available: z.boolean(),
      needs_auth: z.boolean().optional(),
    }),
  ),
  /** Tool names actually observed in tool_call events (provenance: observed_use). */
  core_tools_observed: z.array(z.string()),
  invoked_skills: z.array(z.object({ name: z.string(), content_bytes: z.number().int().optional() })),
  needs_auth_mcp_servers: z.array(z.string()).optional(),
});
export type EnvironmentSnapshot = z.infer<typeof EnvironmentSnapshotSchema>;

/** One human-goal unit: a user prompt plus everything until control returns. */
export const TurnSchema = z.object({
  id: z.string(),
  index: z.number().int().nonnegative(),
  origin: z.enum(["human", "task_notification", "queued", "synthetic"]),
  first_event_index: z.number().int().nonnegative(),
  last_event_index: z.number().int().nonnegative(),
  prompt_text: z.string().optional(),
  usage: UsageSchema.optional(),
  wall_clock_ms: z.number().int().nonnegative().optional(),
  tool_call_count: z.number().int().nonnegative().optional(),
  error_count: z.number().int().nonnegative().optional(),
  interrupted: z.boolean().optional(),
});
export type Turn = z.infer<typeof TurnSchema>;

export const SessionSourceSchema = z.object({
  tool: z.enum(["claude-code", "claude-agent-sdk", "codex-cli", "opencode", "cursor", "gemini-cli", "aider", "other"]),
  /** Range observed across the file — Claude Code sessions span CLI versions. */
  tool_version_min: z.string().optional(),
  tool_version_max: z.string().optional(),
  adapter: z.string(),
  adapter_version: z.string(),
});

export const SessionSchema = z.object({
  id: z.string(),
  ir_version: z.string(),
  source: SessionSourceSchema,
  project: z
    .object({
      cwd: z.string().optional(),
      git_branch: z.string().optional(),
    })
    .optional(),
  started_at: z.string().optional(),
  ended_at: z.string().optional(),
  title: z.string().optional(),
  slug: z.string().optional(),
  /** Present iff this is a subagent/child session. */
  parent: z
    .object({
      session_id: z.string(),
      spawn_tool_use_id: z.string().optional(),
      agent_type: z.string().optional(),
      spawn_depth: z.number().int().optional(),
    })
    .optional(),
  turns: z.array(TurnSchema),
  events: z.array(EventSchema),
  environment: EnvironmentSnapshotSchema.optional(),
  /** Deduped totals (one usage per API response). */
  usage_totals: UsageSchema.optional(),
  /** Event ids whose source parentUuid was null — resume boundaries. */
  chain_root_event_ids: z.array(z.string()).optional(),
  /** Count of source lines the adapter did not recognize (drift canary). */
  unknown_line_types: z.record(z.number()).optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type Session = z.infer<typeof SessionSchema>;
export type SessionSource = z.infer<typeof SessionSourceSchema>;
