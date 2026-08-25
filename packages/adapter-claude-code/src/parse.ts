import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type {
  AssistantMessageEvent,
  EnvironmentSnapshot,
  Event,
  Session,
  ToolCallEvent,
  Turn,
  Usage,
} from "@damame/ir";
import { addUsage, emptyAggregatedUsage } from "@damame/ir";
import { classifyError } from "./error-signatures.js";
import { hashToolInput, sha256 } from "./hash.js";

export const ADAPTER_NAME = "claude-code";
export const ADAPTER_VERSION = "0.1.0";

const TEXT_CAP = 20_000;
const THINKING_CAP = 2_000;
const OUTPUT_CAP = 4_000;
const INPUT_STRING_CAP = 2_000;
const PROMPT_PREVIEW_CAP = 500;

/** Line types we know about and deliberately do not turn into events. */
const SKIPPED_LINE_TYPES = new Set([
  "ai-title",
  "last-prompt",
  "mode",
  "queue-operation",
  "file-history-snapshot",
  "file-history-delta",
  "frame-link",
  "summary",
]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RawLine = Record<string, any>;

interface LineNode {
  uuid: string;
  parentUuid: string | null;
  eventIds: string[];
  messageId?: string;
  usage?: Usage;
  timestamp?: string;
  /** Last transcript line number this uuid appeared on (chronology proxy). */
  lastLine: number;
  /** sessionId of the sitting that wrote this line — resumes change it,
   * which is how a resume fork is told apart from an in-session rewind. */
  sessionId?: string;
  /** Which sitting (save-marker interval) first wrote this uuid. */
  sitting?: number;
}

interface PendingCall {
  eventId: string;
  name: string;
  timestamp?: string;
  input: unknown;
}

export interface ParseOptions {
  /** Ingest subagent transcripts as child sessions (default true, handled by index.ts). */
  sessionIdOverride?: string;
  parent?: Session["parent"];
}

export interface ParsedSession {
  session: Session;
  /** agentIds of subagent transcripts referenced from this session. */
  referencedAgentIds: string[];
}

export async function parseTranscriptFile(filePath: string, opts: ParseOptions = {}): Promise<ParsedSession> {
  const events: Event[] = [];
  const turns: Turn[] = [];
  const nodes = new Map<string, LineNode>();
  const childrenByParent = new Map<string, Set<string>>();
  const pendingCalls = new Map<string, PendingCall>(); // tool_use id → call
  const assistantByMessageId = new Map<string, AssistantMessageEvent>();
  const unknownLineTypes: Record<string, number> = {};
  const skippedLineTypes: Record<string, number> = {};
  const referencedAgentIds: string[] = [];
  const retractedMessageUuids: string[] = [];
  const rootUuids: string[] = [];
  let sittingCounter = 0;

  const env: EnvironmentSnapshot = {
    captured_from: ["transcript_attachments", "observed_use"],
    skills: [],
    agents: [],
    deferred_tools: [],
    core_tools_observed: [],
    invoked_skills: [],
  };
  const skillNames = new Set<string>();
  const agentTypes = new Map<string, { type: string; description?: string; removed?: boolean }>();
  const deferredTools = new Map<string, { name: string; available: boolean; needs_auth?: boolean }>();
  const observedTools = new Set<string>();
  const needsAuthServers = new Set<string>();

  let sessionId: string | undefined = opts.sessionIdOverride;
  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let versionMin: string | undefined;
  let versionMax: string | undefined;
  let title: string | undefined;
  let slug: string | undefined;
  let leafUuid: string | undefined;
  let entrypoint: string | undefined;
  let firstTs: string | undefined;
  let lastTs: string | undefined;
  const permissionModes = new Set<string>();

  let lineNo = 0;
  let malformedLines = 0;

  const nextEventId = () => `e${String(events.length).padStart(5, "0")}`;

  function pushEvent<T extends Event>(event: T): T {
    events.push(event);
    return event;
  }

  function registerNode(raw: RawLine, eventId?: string): LineNode | undefined {
    const uuid = raw.uuid;
    if (typeof uuid !== "string") return undefined;
    let node = nodes.get(uuid);
    if (!node) {
      node = { uuid, parentUuid: raw.parentUuid ?? null, eventIds: [], lastLine: lineNo };
      nodes.set(uuid, node);
      const parent = raw.parentUuid;
      if (typeof parent === "string") {
        let set = childrenByParent.get(parent);
        if (!set) childrenByParent.set(parent, (set = new Set()));
        set.add(uuid);
      } else if (raw.parentUuid === null) {
        rootUuids.push(uuid);
      }
    }
    node.lastLine = lineNo;
    if (eventId) node.eventIds.push(eventId);
    if (typeof raw.timestamp === "string") node.timestamp = raw.timestamp;
    if (typeof raw.sessionId === "string") node.sessionId = raw.sessionId;
    node.sitting ??= sittingCounter;
    return node;
  }

  function envelope(raw: RawLine) {
    const ts: string | undefined = typeof raw.timestamp === "string" ? raw.timestamp : undefined;
    if (ts) {
      if (!firstTs || ts < firstTs) firstTs = ts;
      if (!lastTs || ts > lastTs) lastTs = ts;
    }
    const parentUuid = typeof raw.parentUuid === "string" ? raw.parentUuid : null;
    const parentEventId = parentUuid ? nodes.get(parentUuid)?.eventIds[0] : undefined;
    return {
      event_id: nextEventId(),
      index: events.length,
      ...(ts ? { timestamp: ts } : {}),
      ...(parentEventId ? { parent_event_id: parentEventId } : {}),
      source_ids: {
        ...(typeof raw.uuid === "string" ? { uuid: raw.uuid } : {}),
        ...(typeof raw.requestId === "string" ? { request_id: raw.requestId } : {}),
        parent_uuid: parentUuid,
      },
      raw_ref: { file: filePath, line: lineNo },
    };
  }

  function captureSessionMeta(raw: RawLine) {
    if (!sessionId && typeof raw.sessionId === "string") sessionId = raw.sessionId;
    if (typeof raw.cwd === "string") cwd = raw.cwd;
    if (typeof raw.gitBranch === "string" && raw.gitBranch) gitBranch = raw.gitBranch;
    if (typeof raw.slug === "string") slug = raw.slug;
    if (typeof raw.entrypoint === "string") entrypoint = raw.entrypoint;
    if (typeof raw.version === "string") {
      if (!versionMin || raw.version < versionMin) versionMin = raw.version;
      if (!versionMax || raw.version > versionMax) versionMax = raw.version;
    }
  }

  const rl = createInterface({ input: createReadStream(filePath, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    lineNo += 1;
    if (!line.trim()) continue;
    let raw: RawLine;
    try {
      raw = JSON.parse(line);
    } catch {
      malformedLines += 1;
      continue;
    }
    const type = raw.type;
    try {
      switch (type) {
        case "assistant":
          captureSessionMeta(raw);
          handleAssistantLine(raw);
          break;
        case "user":
          captureSessionMeta(raw);
          handleUserLine(raw);
          break;
        case "system":
          captureSessionMeta(raw);
          handleSystemLine(raw);
          break;
        case "attachment":
          captureSessionMeta(raw);
          handleAttachmentLine(raw);
          break;
        case "ai-title":
          if (typeof raw.aiTitle === "string") title = raw.aiTitle;
          skippedLineTypes["ai-title"] = (skippedLineTypes["ai-title"] ?? 0) + 1;
          break;
        case "last-prompt":
          if (typeof raw.leafUuid === "string") leafUuid = raw.leafUuid;
          // A last-prompt line is written when the session is saved/closed —
          // it delimits "sittings". Lines after it belong to the next sitting,
          // which is how resume-orphaned forks are told apart from rewinds.
          sittingCounter += 1;
          skippedLineTypes["last-prompt"] = (skippedLineTypes["last-prompt"] ?? 0) + 1;
          break;
        default:
          if (typeof type === "string" && SKIPPED_LINE_TYPES.has(type)) {
            skippedLineTypes[type] = (skippedLineTypes[type] ?? 0) + 1;
          } else {
            const key = typeof type === "string" ? type : "<untyped>";
            unknownLineTypes[key] = (unknownLineTypes[key] ?? 0) + 1;
          }
      }
    } catch {
      // Never let one bad line kill a 200MB parse; count it and move on.
      malformedLines += 1;
    }
  }

  // ---- line handlers -------------------------------------------------------

  function handleAssistantLine(raw: RawLine) {
    const msg = raw.message ?? {};
    const messageId: string = typeof msg.id === "string" ? msg.id : `synthetic:${raw.uuid ?? lineNo}`;
    const isSynthetic = msg.model === "<synthetic>" || raw.isApiErrorMessage === true;

    let assistantEvent = assistantByMessageId.get(messageId);
    if (!assistantEvent) {
      const usage = extractUsage(msg.usage);
      const diagnostics = msg.diagnostics?.cache_miss_reason;
      assistantEvent = pushEvent<AssistantMessageEvent>({
        ...envelope(raw),
        kind: "assistant_message",
        ...(typeof msg.model === "string" ? { model: msg.model } : {}),
        stop_reason: msg.stop_reason ?? null,
        ...(typeof raw.effort === "string" ? { effort: raw.effort } : {}),
        ...(raw.attributionSkill || raw.attributionPlugin
          ? {
              attribution: {
                ...(raw.attributionSkill ? { skill: raw.attributionSkill } : {}),
                ...(raw.attributionPlugin ? { plugin: raw.attributionPlugin } : {}),
              },
            }
          : {}),
        ...(usage ? { usage } : {}),
        ...(diagnostics && typeof diagnostics.type === "string"
          ? {
              cache_miss: {
                reason: diagnostics.type,
                ...(typeof diagnostics.cache_missed_input_tokens === "number"
                  ? { missed_input_tokens: diagnostics.cache_missed_input_tokens }
                  : {}),
              },
            }
          : {}),
        ...(isSynthetic ? { is_error_placeholder: true } : {}),
      });
      assistantEvent.source_ids = { ...assistantEvent.source_ids, message_id: messageId };
      assistantByMessageId.set(messageId, assistantEvent);
    } else if (typeof msg.stop_reason === "string") {
      // stop_reason arrives on the last block's line
      assistantEvent.stop_reason = msg.stop_reason;
    }

    const node = registerNode(raw, assistantEvent.event_id);
    if (node) {
      node.messageId = messageId;
      node.usage = assistantEvent.usage;
    }

    const content = msg.content;
    if (typeof content === "string") {
      appendAssistantText(assistantEvent, content);
      return;
    }
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      switch (block.type) {
        case "text":
          appendAssistantText(assistantEvent, block.text ?? "");
          break;
        case "thinking": {
          const text: string = block.thinking ?? "";
          const ev = pushEvent({
            ...envelope(raw),
            kind: "thinking" as const,
            text: text.slice(0, THINKING_CAP),
            ...(text.length > THINKING_CAP ? { text_truncated: true } : {}),
            ...(typeof msg.model === "string" ? { model: msg.model } : {}),
          });
          registerNode(raw, ev.event_id);
          break;
        }
        case "tool_use": {
          const name: string = block.name ?? "<unknown>";
          observedTools.add(name);
          const { input, truncated } = truncateInput(block.input ?? {});
          const ev = pushEvent<ToolCallEvent>({
            ...envelope(raw),
            kind: "tool_call",
            name,
            input,
            ...(truncated ? { input_truncated: true } : {}),
            ...(typeof block.id === "string" ? { call_id: block.id } : {}),
            input_hash: hashToolInput(name, block.input ?? {}),
            ...(typeof msg.model === "string" ? { model: msg.model } : {}),
          });
          registerNode(raw, ev.event_id);
          if (typeof block.id === "string") {
            pendingCalls.set(block.id, {
              eventId: ev.event_id,
              name,
              timestamp: typeof raw.timestamp === "string" ? raw.timestamp : undefined,
              input: block.input,
            });
          }
          break;
        }
        default:
          break; // redacted_thinking, server_tool_use, etc. stay in raw only
      }
    }
  }

  function handleUserLine(raw: RawLine) {
    const content = raw.message?.content;
    const blocks: RawLine[] = Array.isArray(content) ? content : [];
    const toolResultBlocks = blocks.filter((b) => b?.type === "tool_result");

    if (toolResultBlocks.length > 0 || raw.toolUseResult !== undefined) {
      let firstEventId: string | undefined;
      for (const block of toolResultBlocks.length > 0 ? toolResultBlocks : [undefined]) {
        const id = emitToolResult(raw, block);
        firstEventId = firstEventId ?? id;
      }
      registerNode(raw, firstEventId);
      return;
    }

    const text = typeof content === "string" ? content : collectText(blocks);
    const imageCount = blocks.filter((b) => b?.type === "image").length;

    if (/^\s*\[Request interrupted by user/.test(text)) {
      const ev = pushEvent({
        ...envelope(raw),
        kind: "interruption" as const,
        scope: text.includes("for tool use") ? ("tool_use" as const) : ("request" as const),
      });
      registerNode(raw, ev.event_id);
      return;
    }

    const originKind = raw.origin?.kind;
    // Harness-injected content is not always flagged isMeta (e.g. IDE
    // notifications, local command output); a leading harness tag marks it.
    const harnessInjected =
      /^\s*<(?:ide_|local-command-|system-reminder|task-notification|command-message)/.test(text) &&
      !/^\s*<command-name>/.test(text);
    const origin =
      originKind === "task-notification"
        ? ("task_notification" as const)
        : raw.isMeta === true || raw.isCompactSummary === true || harnessInjected
          ? ("synthetic" as const)
          : ("human" as const);
    if (typeof raw.permissionMode === "string") permissionModes.add(raw.permissionMode);

    const slash = parseSlashCommand(text);
    const ev = pushEvent({
      ...envelope(raw),
      kind: "user_message" as const,
      text: text.slice(0, TEXT_CAP),
      origin,
      ...(imageCount > 0 ? { image_count: imageCount } : {}),
      ...(raw.isMeta === true ? { is_meta: true } : {}),
      ...(raw.isCompactSummary === true ? { is_compact_summary: true } : {}),
      ...(slash ? { slash_command: slash } : {}),
      ...(typeof raw.permissionMode === "string" ? { permission_mode: raw.permissionMode } : {}),
    });
    registerNode(raw, ev.event_id);
  }

  function emitToolResult(raw: RawLine, block: RawLine | undefined): string {
    const callId: string | undefined = block?.tool_use_id;
    const pending = callId ? pendingCalls.get(callId) : undefined;
    const tur = raw.toolUseResult;
    const isRejection = typeof tur === "string" && classifyError(tur) === "user_rejected";

    if (isRejection) {
      const ev = pushEvent({
        ...envelope(raw),
        kind: "permission_denial" as const,
        ...(pending ? { call_event_id: pending.eventId } : {}),
        ...(callId ? { call_id: callId } : {}),
        ...(pending ? { tool_name: pending.name } : {}),
      });
      return ev.event_id;
    }

    const fullOutput = block ? extractResultText(block) : typeof tur === "string" ? tur : "";
    const isError = block?.is_error === true || typeof tur === "string";
    const errorSignature = isError
      ? classifyError(typeof tur === "string" ? tur : fullOutput)
      : undefined;

    const durationMs =
      pending?.timestamp && typeof raw.timestamp === "string"
        ? Math.max(0, Date.parse(raw.timestamp) - Date.parse(pending.timestamp))
        : undefined;

    const structured =
      tur && typeof tur === "object" && !Array.isArray(tur) ? projectStructured(tur) : undefined;

    const ev = pushEvent({
      ...envelope(raw),
      kind: "tool_result" as const,
      ...(pending ? { call_event_id: pending.eventId } : {}),
      ...(callId ? { call_id: callId } : {}),
      ...(pending ? { tool_name: pending.name } : {}),
      ...(isError ? { is_error: true } : {}),
      ...(errorSignature ? { error_signature: errorSignature } : {}),
      output_text: fullOutput.slice(0, OUTPUT_CAP),
      ...(fullOutput.length > OUTPUT_CAP ? { output_text_truncated: true } : {}),
      output_bytes: Buffer.byteLength(fullOutput, "utf8"),
      output_hash: sha256(fullOutput),
      ...(structured ? { structured } : {}),
      ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
      ...(tur && typeof tur === "object" && tur.userModified === true ? { user_modified: true } : {}),
    });

    maybeEmitSubagentRun(raw, pending, ev.event_id);
    if (callId) pendingCalls.delete(callId);
    return ev.event_id;
  }

  function maybeEmitSubagentRun(raw: RawLine, pending: PendingCall | undefined, resultEventId: string) {
    if (!pending) return;
    const tur = raw.toolUseResult;
    if (!tur || typeof tur !== "object") return;
    if (pending.name === "Agent" || pending.name === "Task") {
      const agentId = typeof tur.agentId === "string" ? tur.agentId : undefined;
      if (agentId) referencedAgentIds.push(agentId);
      const input = pending.input as RawLine | undefined;
      pushEvent({
        ...envelope(raw),
        kind: "subagent_run" as const,
        spawn_call_event_id: pending.eventId,
        spawn_tool: pending.name,
        ...(agentId ? { child_ref: agentId } : {}),
        child_kind: "agent" as const,
        ...(typeof input?.subagent_type === "string" ? { agent_type: input.subagent_type } : {}),
        ...(typeof tur.resolvedModel === "string" ? { resolved_model: tur.resolvedModel } : {}),
        ...(typeof tur.isAsync === "boolean" ? { is_async: tur.isAsync } : {}),
        ...(typeof tur.status === "string" ? { status: tur.status } : {}),
      });
    } else if (pending.name === "Workflow") {
      const runId = typeof tur.runId === "string" ? tur.runId : undefined;
      pushEvent({
        ...envelope(raw),
        kind: "subagent_run" as const,
        spawn_call_event_id: pending.eventId,
        spawn_tool: "Workflow",
        ...(runId ? { child_ref: runId } : {}),
        child_kind: "workflow" as const,
        ...(typeof tur.workflowName === "string" && tur.workflowName ? { name: tur.workflowName } : {}),
        ...(typeof tur.status === "string" ? { status: tur.status } : {}),
      });
    }
    void resultEventId;
  }

  function handleSystemLine(raw: RawLine) {
    const subtype = raw.subtype;
    if (subtype === "compact_boundary") {
      const meta = raw.compactMetadata ?? {};
      const ev = pushEvent({
        ...envelope(raw),
        kind: "compaction" as const,
        ...(typeof meta.trigger === "string" ? { trigger: meta.trigger } : {}),
        ...(typeof meta.preTokens === "number" ? { pre_tokens: meta.preTokens } : {}),
        ...(typeof meta.postTokens === "number" ? { post_tokens: meta.postTokens } : {}),
        ...(typeof meta.durationMs === "number" ? { duration_ms: Math.round(meta.durationMs) } : {}),
        ...(typeof raw.logicalParentUuid === "string" ? { logical_parent_uuid: raw.logicalParentUuid } : {}),
      });
      registerNode(raw, ev.event_id);
      return;
    }
    if (subtype === "api_error") {
      const ev = pushEvent({
        ...envelope(raw),
        kind: "system_event" as const,
        subtype: "api_error" as const,
        detail: {
          retryAttempt: raw.retryAttempt,
          maxRetries: raw.maxRetries,
          retryInMs: raw.retryInMs,
        },
      });
      registerNode(raw, ev.event_id);
      return;
    }
    if (subtype === "model_refusal_fallback") {
      if (Array.isArray(raw.retractedMessageUuids)) retractedMessageUuids.push(...raw.retractedMessageUuids);
      const ev = pushEvent({
        ...envelope(raw),
        kind: "system_event" as const,
        subtype: "model_refusal_fallback" as const,
        detail: {
          originalModel: raw.originalModel,
          fallbackModel: raw.fallbackModel,
          apiRefusalCategory: raw.apiRefusalCategory,
          retractedCount: Array.isArray(raw.retractedMessageUuids) ? raw.retractedMessageUuids.length : 0,
        },
      });
      registerNode(raw, ev.event_id);
      return;
    }
    const ev = pushEvent({
      ...envelope(raw),
      kind: "system_event" as const,
      subtype: "other" as const,
      detail: { subtype },
    });
    registerNode(raw, ev.event_id);
  }

  function handleAttachmentLine(raw: RawLine) {
    registerNode(raw);
    const att = raw.attachment;
    if (!att || typeof att !== "object") return;
    switch (att.type) {
      case "skill_listing": {
        const descriptions = parseListingLines(att.content);
        for (const name of att.names ?? []) {
          if (typeof name === "string" && !skillNames.has(name)) {
            skillNames.add(name);
            env.skills.push({
              name,
              ...(descriptions.get(name) ? { description: descriptions.get(name) } : {}),
              source: "session_listing",
            });
          }
        }
        break;
      }
      case "agent_listing_delta": {
        const descriptions = parseListingLines((att.addedLines ?? []).join("\n"));
        for (const type of att.addedTypes ?? []) {
          if (typeof type !== "string") continue;
          const existing = agentTypes.get(type);
          agentTypes.set(type, {
            type,
            description: descriptions.get(type) ?? existing?.description,
            removed: false,
          });
        }
        for (const type of att.removedTypes ?? []) {
          if (typeof type !== "string") continue;
          const existing = agentTypes.get(type);
          if (existing) existing.removed = true;
          else agentTypes.set(type, { type, removed: true });
        }
        break;
      }
      case "deferred_tools_delta": {
        for (const name of [...(att.addedNames ?? []), ...(att.readdedNames ?? [])]) {
          if (typeof name === "string") deferredTools.set(name, { name, available: true });
        }
        for (const name of att.removedNames ?? []) {
          if (typeof name === "string") deferredTools.set(name, { name, available: false });
        }
        for (const server of att.needsAuthMcpServers ?? []) {
          if (typeof server === "string") needsAuthServers.add(server);
        }
        break;
      }
      case "invoked_skills": {
        for (const skill of att.skills ?? []) {
          if (skill && typeof skill.name === "string") {
            env.invoked_skills.push({
              name: skill.name,
              ...(typeof skill.content === "string" ? { content_bytes: Buffer.byteLength(skill.content) } : {}),
            });
          }
        }
        break;
      }
      default:
        break;
    }
  }

  // ---- finalize ------------------------------------------------------------

  const abandonedBranches = finalizeForks();
  buildTurns();
  const usageTotals = events.reduce<Usage>((acc, ev) => {
    if (ev.kind === "assistant_message") addUsage(acc, ev.usage);
    return acc;
  }, emptyAggregatedUsage());

  env.agents = [...agentTypes.values()];
  env.deferred_tools = [...deferredTools.values()];
  env.core_tools_observed = [...observedTools].sort();
  if (needsAuthServers.size > 0) env.needs_auth_mcp_servers = [...needsAuthServers];

  const session: Session = {
    id: sessionId ?? filePath,
    ir_version: "0.1.0",
    source: {
      tool: "claude-code",
      ...(versionMin ? { tool_version_min: versionMin } : {}),
      ...(versionMax ? { tool_version_max: versionMax } : {}),
      adapter: ADAPTER_NAME,
      adapter_version: ADAPTER_VERSION,
    },
    ...(cwd || gitBranch ? { project: { ...(cwd ? { cwd } : {}), ...(gitBranch ? { git_branch: gitBranch } : {}) } } : {}),
    ...(firstTs ? { started_at: firstTs } : {}),
    ...(lastTs ? { ended_at: lastTs } : {}),
    ...(title ? { title } : {}),
    ...(slug ? { slug } : {}),
    ...(opts.parent ? { parent: opts.parent } : {}),
    turns,
    events,
    environment: env,
    usage_totals: usageTotals,
    chain_root_event_ids: rootUuids
      .map((uuid) => nodes.get(uuid)?.eventIds[0])
      .filter((id): id is string => id !== undefined),
    ...(Object.keys(unknownLineTypes).length > 0 ? { unknown_line_types: unknownLineTypes } : {}),
    metadata: {
      transcript_path: filePath,
      line_count: lineNo,
      malformed_lines: malformedLines,
      skipped_line_types: skippedLineTypes,
      ...(entrypoint ? { entrypoint } : {}),
      permission_modes: [...permissionModes],
      ...(leafUuid ? { leaf_uuid: leafUuid } : {}),
      chain_root_count: rootUuids.length,
      abandoned_branches: abandonedBranches,
      retracted_message_uuids: retractedMessageUuids,
    },
  };

  return { session, referencedAgentIds };

  // ---- helpers -------------------------------------------------------------

  function appendAssistantText(event: AssistantMessageEvent, text: string) {
    if (!text) return;
    const current = event.text ?? "";
    if (current.length >= TEXT_CAP) return;
    event.text = (current + (current ? "\n" : "") + text).slice(0, TEXT_CAP);
  }

  /**
   * Fork resolution: a parent line with >1 distinct children means the user
   * escaped/re-prompted (or a retry created a sibling branch). Exactly one
   * child is live. Resolution order:
   *   1. a child on the `last-prompt.leafUuid` ancestry chain is live;
   *   2. otherwise the child whose subtree was written to latest in the file
   *      is live (a session resume moves leafUuid to a different chain, but
   *      the branch that kept receiving lines is the one that continued).
   * Every other child's subtree is abandoned: events get
   * `on_abandoned_branch: true` and its deduped usage is summarized.
   */
  function finalizeForks() {
    const liveAncestry = new Set<string>();
    if (leafUuid) {
      let cursor: string | undefined = leafUuid;
      while (cursor && !liveAncestry.has(cursor)) {
        liveAncestry.add(cursor);
        cursor = nodes.get(cursor)?.parentUuid ?? undefined;
      }
    }
    const eventById = new Map(events.map((e) => [e.event_id, e]));
    const summaries: Array<{
      fork_parent_uuid: string;
      root_event_id?: string;
      event_count: number;
      usage_tokens: number;
      fork_kind: "rewind" | "resume";
    }> = [];

    /** All uuids in the subtree rooted at `rootUuid` (cycle-guarded). */
    const collectSubtree = (rootUuid: string): string[] => {
      const out: string[] = [];
      const stack = [rootUuid];
      const seen = new Set<string>();
      while (stack.length > 0) {
        const uuid = stack.pop()!;
        if (seen.has(uuid)) continue;
        seen.add(uuid);
        out.push(uuid);
        for (const child of childrenByParent.get(uuid) ?? []) stack.push(child);
      }
      return out;
    };

    const subtreeLastLine = (rootUuid: string): number =>
      collectSubtree(rootUuid).reduce((max, uuid) => Math.max(max, nodes.get(uuid)?.lastLine ?? 0), 0);

    for (const [parentUuid, children] of childrenByParent) {
      if (children.size < 2) continue;
      const childList = [...children];
      let live = childList.find((c) => liveAncestry.has(c));
      if (!live) {
        live = childList.reduce((a, b) => (subtreeLastLine(a) >= subtreeLastLine(b) ? a : b));
      }
      for (const childUuid of childList) {
        if (childUuid === live) continue;
        const usage = emptyAggregatedUsage();
        const countedMessages = new Set<string>();
        let eventCount = 0;
        let rootEventId: string | undefined;
        for (const uuid of collectSubtree(childUuid)) {
          if (liveAncestry.has(uuid)) continue;
          const node = nodes.get(uuid);
          if (!node) continue;
          for (const eventId of node.eventIds) {
            const event = eventById.get(eventId);
            if (!event) continue;
            if (!event.on_abandoned_branch) {
              event.on_abandoned_branch = true;
              eventCount += 1;
            }
            rootEventId = rootEventId ?? eventId;
          }
          if (node.messageId && node.usage && !countedMessages.has(node.messageId)) {
            countedMessages.add(node.messageId);
            addUsage(usage, node.usage);
          }
        }
        if (eventCount > 0) {
          // Rewind vs resume: a true rewind forks WITHIN one sitting. When
          // the live continuation was written in a different sitting (a
          // later save-marker interval, or a different sessionId in stitched
          // files), the dead branch is a tail orphaned by a reopen/crash —
          // no user action, and blaming a "rewind" would be a measured
          // applicability failure (it was, on real data).
          const dead = nodes.get(childUuid);
          const liveNode = nodes.get(live);
          const sameSession =
            !dead?.sessionId || !liveNode?.sessionId || dead.sessionId === liveNode.sessionId;
          const sameSitting = (dead?.sitting ?? 0) === (liveNode?.sitting ?? 0);
          const fork_kind: "rewind" | "resume" = sameSession && sameSitting ? "rewind" : "resume";
          summaries.push({
            fork_parent_uuid: parentUuid,
            ...(rootEventId ? { root_event_id: rootEventId } : {}),
            event_count: eventCount,
            usage_tokens:
              (usage.input_tokens ?? 0) +
              (usage.output_tokens ?? 0) +
              (usage.cache_creation_input_tokens ?? 0),
            fork_kind,
          });
        }
      }
    }
    return summaries;
  }

  /** Segment events into turns at each live-branch, non-meta user_message. */
  function buildTurns() {
    let current: Turn | undefined;
    let currentUsage: Usage | undefined;

    const close = (lastIndex: number) => {
      if (!current) return;
      current.last_event_index = lastIndex;
      if (currentUsage) current.usage = currentUsage;
      const first = events[current.first_event_index];
      const last = events[lastIndex];
      if (first?.timestamp && last?.timestamp) {
        current.wall_clock_ms = Math.max(0, Date.parse(last.timestamp) - Date.parse(first.timestamp));
      }
      turns.push(current);
      current = undefined;
      currentUsage = undefined;
    };

    events.forEach((event, i) => {
      const startsTurn =
        event.kind === "user_message" &&
        !event.is_meta &&
        !event.is_compact_summary &&
        !event.on_abandoned_branch &&
        (event.origin === "human" || event.origin === "task_notification");

      if (startsTurn) {
        close(i - 1);
        current = {
          id: event.source_ids?.uuid ?? `t${turns.length}`,
          index: turns.length,
          origin: event.origin === "human" ? "human" : "task_notification",
          first_event_index: i,
          last_event_index: i,
          prompt_text: (event as { text: string }).text.slice(0, PROMPT_PREVIEW_CAP),
          tool_call_count: 0,
          error_count: 0,
        };
      }
      if (!current) return;
      event.turn_id = current.id;
      if (event.kind === "assistant_message") {
        currentUsage = addUsage(currentUsage ?? emptyAggregatedUsage(), event.usage);
      } else if (event.kind === "tool_call") {
        current.tool_call_count = (current.tool_call_count ?? 0) + 1;
      } else if (event.kind === "tool_result" && event.is_error) {
        current.error_count = (current.error_count ?? 0) + 1;
      } else if (event.kind === "permission_denial") {
        current.error_count = (current.error_count ?? 0) + 1;
      } else if (event.kind === "interruption") {
        current.interrupted = true;
      }
    });
    close(events.length - 1);
  }
}

// ---- module-level helpers --------------------------------------------------

function extractUsage(usage: unknown): Usage | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const cc = u.cache_creation as Record<string, unknown> | undefined;
  return {
    ...(typeof u.input_tokens === "number" ? { input_tokens: u.input_tokens } : {}),
    ...(typeof u.output_tokens === "number" ? { output_tokens: u.output_tokens } : {}),
    ...(typeof u.cache_read_input_tokens === "number"
      ? { cache_read_input_tokens: u.cache_read_input_tokens }
      : {}),
    ...(typeof u.cache_creation_input_tokens === "number"
      ? { cache_creation_input_tokens: u.cache_creation_input_tokens }
      : {}),
    ...(cc
      ? {
          cache_creation: {
            ...(typeof cc.ephemeral_1h_input_tokens === "number" ? { ephemeral_1h: cc.ephemeral_1h_input_tokens } : {}),
            ...(typeof cc.ephemeral_5m_input_tokens === "number" ? { ephemeral_5m: cc.ephemeral_5m_input_tokens } : {}),
          },
        }
      : {}),
    attribution: "measured" as const,
  };
}

function collectText(blocks: Array<Record<string, unknown>>): string {
  return blocks
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

function extractResultText(block: Record<string, unknown>): string {
  const content = block.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return collectText(content as Array<Record<string, unknown>>);
  return "";
}

function parseSlashCommand(text: string): { name: string; args?: string } | undefined {
  const name = /<command-name>([^<]+)<\/command-name>/.exec(text)?.[1]?.trim();
  if (!name) return undefined;
  const args = /<command-args>([^<]*)<\/command-args>/.exec(text)?.[1]?.trim();
  return { name, ...(args ? { args } : {}) };
}

/** Parse "- name: description" listing lines (skill/agent attachments). */
function parseListingLines(content: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof content !== "string") return out;
  for (const line of content.split("\n")) {
    const match = /^\s*-\s*([A-Za-z0-9:_\/-]+)\s*:\s*(.+)$/.exec(line);
    if (match) out.set(match[1]!, match[2]!.slice(0, 300));
  }
  return out;
}

function truncateInput(input: unknown): { input: Record<string, unknown>; truncated: boolean } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { input: { value: input as unknown }, truncated: false };
  }
  let truncated = false;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" && value.length > INPUT_STRING_CAP) {
      out[key] = value.slice(0, INPUT_STRING_CAP);
      truncated = true;
    } else {
      out[key] = value;
    }
  }
  return { input: out, truncated };
}

/** Keep only small scalar fields of an object-typed toolUseResult. */
function projectStructured(tur: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(tur)) {
    if (typeof value === "string" && value.length <= 300) out[key] = value;
    else if (typeof value === "number" || typeof value === "boolean") out[key] = value;
  }
  out._keys = Object.keys(tur);
  return out;
}
