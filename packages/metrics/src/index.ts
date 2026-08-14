import type {
  AssistantMessageEvent,
  CompactionEvent,
  Event,
  PermissionDenialEvent,
  Session,
  ToolCallEvent,
  ToolResultEvent,
  Usage,
} from "@damame/ir";
import { addUsage, emptyAggregatedUsage, totalTokens } from "@damame/ir";

/**
 * Pass 1: pure, deterministic facts computed from the IR. No rules, no
 * opinions, no IO. Every later pass (detectors, renderers) reads this bundle.
 */
export interface MetricsBundle {
  session_id: string;
  totals: {
    usage: Usage;
    total_tokens: number;
    turn_count: number;
    human_turn_count: number;
    event_count: number;
    tool_call_count: number;
    tool_error_count: number;
    wall_clock_ms?: number;
  };
  per_model: Record<string, { usage: Usage; message_count: number }>;
  per_tool: Record<
    string,
    { calls: number; errors: number; total_duration_ms: number; max_duration_ms: number }
  >;
  /** input_hash → occurrences (in event order) for calls appearing more than once. */
  duplicate_tool_calls: DuplicateGroup[];
  /** Consecutive same-signature failures against the same target. */
  error_runs: ErrorRun[];
  /** Consecutive api_error system events. */
  api_error_runs: Array<{ event_ids: string[]; total_retry_wait_ms: number }>;
  compactions: Array<{
    event_id: string;
    pre_tokens?: number;
    post_tokens?: number;
    duration_ms?: number;
  }>;
  permission_denials: Array<{ event_id: string; tool_name?: string }>;
  interruption_count: number;
  abandoned_branches: Array<{ root_event_id?: string; event_count: number; usage_tokens: number }>;
  cache_misses: Array<{ event_id: string; reason: string; missed_input_tokens?: number }>;
  subagent_runs: Array<{
    event_id: string;
    spawn_tool: string;
    agent_type?: string;
    resolved_model?: string;
    usage_tokens?: number;
  }>;
  /** Longest run of consecutive main-thread read-only tool calls per turn. */
  read_only_runs: Array<{ turn_id: string; length: number; first_event_id: string; last_event_id: string }>;
  /** Read results ≥ threshold bytes with no offset/limit on the call. */
  large_full_reads: Array<{
    call_event_id: string;
    result_event_id: string;
    file_path?: string;
    output_bytes: number;
  }>;
  /** Human think-time gaps between turns (previous turn end → next human prompt). */
  idle_gaps_ms: number[];
}

const READ_ONLY_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch", "NotebookRead"]);
const STATE_CHANGING_TOOLS = new Set(["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit"]);
const LARGE_READ_BYTES = 80_000; // ≈20k tokens at 4 bytes/token

export interface DuplicateGroup {
  input_hash: string;
  tool_name: string;
  call_event_ids: string[];
  /** True when all observed results carried the same output_hash. */
  identical_results: boolean;
  /** True if a state-changing call succeeded between first and last occurrence. */
  state_change_between: boolean;
  repeated_output_bytes: number;
}

export interface ErrorRun {
  signature: string;
  target?: string;
  tool_name?: string;
  call_event_ids: string[];
  result_event_ids: string[];
  length: number;
  /** Deduped usage of assistant messages between first failure and run end. */
  retry_usage_tokens: number;
  first_ts?: string;
  last_ts?: string;
}

export function computeMetrics(session: Session): MetricsBundle {
  const events = session.events;
  const totalsUsage = emptyAggregatedUsage();
  const perModel: MetricsBundle["per_model"] = {};
  const perTool: MetricsBundle["per_tool"] = {};
  const cacheMisses: MetricsBundle["cache_misses"] = [];
  const compactions: MetricsBundle["compactions"] = [];
  const permissionDenials: MetricsBundle["permission_denials"] = [];
  const subagentRuns: MetricsBundle["subagent_runs"] = [];
  let toolCallCount = 0;
  let toolErrorCount = 0;
  let interruptionCount = 0;

  const callById = new Map<string, ToolCallEvent>();
  for (const event of events) {
    if (event.kind === "tool_call") callById.set(event.event_id, event);
  }

  for (const event of events) {
    switch (event.kind) {
      case "assistant_message": {
        addUsage(totalsUsage, event.usage);
        const model = event.model ?? "<unknown>";
        const entry = (perModel[model] ??= { usage: emptyAggregatedUsage(), message_count: 0 });
        entry.message_count += 1;
        addUsage(entry.usage, event.usage);
        if (event.cache_miss) {
          cacheMisses.push({
            event_id: event.event_id,
            reason: event.cache_miss.reason,
            ...(event.cache_miss.missed_input_tokens !== undefined
              ? { missed_input_tokens: event.cache_miss.missed_input_tokens }
              : {}),
          });
        }
        break;
      }
      case "tool_call": {
        toolCallCount += 1;
        const entry = (perTool[event.name] ??= {
          calls: 0,
          errors: 0,
          total_duration_ms: 0,
          max_duration_ms: 0,
        });
        entry.calls += 1;
        break;
      }
      case "tool_result": {
        const name = event.tool_name ?? "<unknown>";
        const entry = (perTool[name] ??= { calls: 0, errors: 0, total_duration_ms: 0, max_duration_ms: 0 });
        if (event.is_error) {
          toolErrorCount += 1;
          entry.errors += 1;
        }
        if (event.duration_ms !== undefined) {
          entry.total_duration_ms += event.duration_ms;
          entry.max_duration_ms = Math.max(entry.max_duration_ms, event.duration_ms);
        }
        break;
      }
      case "permission_denial":
        permissionDenials.push({
          event_id: event.event_id,
          ...(event.tool_name ? { tool_name: event.tool_name } : {}),
        });
        break;
      case "compaction":
        compactions.push({
          event_id: event.event_id,
          ...(event.pre_tokens !== undefined ? { pre_tokens: event.pre_tokens } : {}),
          ...(event.post_tokens !== undefined ? { post_tokens: event.post_tokens } : {}),
          ...(event.duration_ms !== undefined ? { duration_ms: event.duration_ms } : {}),
        });
        break;
      case "interruption":
        interruptionCount += 1;
        break;
      case "subagent_run":
        subagentRuns.push({
          event_id: event.event_id,
          spawn_tool: event.spawn_tool,
          ...(event.agent_type ? { agent_type: event.agent_type } : {}),
          ...(event.resolved_model ? { resolved_model: event.resolved_model } : {}),
          ...(event.usage ? { usage_tokens: totalTokens(event.usage) } : {}),
        });
        break;
      default:
        break;
    }
  }

  const wallClock =
    session.started_at && session.ended_at
      ? Math.max(0, Date.parse(session.ended_at) - Date.parse(session.started_at))
      : undefined;

  return {
    session_id: session.id,
    totals: {
      usage: totalsUsage,
      total_tokens: totalTokens(totalsUsage),
      turn_count: session.turns.length,
      human_turn_count: session.turns.filter((t) => t.origin === "human").length,
      event_count: events.length,
      tool_call_count: toolCallCount,
      tool_error_count: toolErrorCount,
      ...(wallClock !== undefined ? { wall_clock_ms: wallClock } : {}),
    },
    per_model: perModel,
    per_tool: perTool,
    duplicate_tool_calls: findDuplicates(events, callById),
    error_runs: findErrorRuns(events, callById),
    api_error_runs: findApiErrorRuns(events),
    compactions,
    permission_denials: permissionDenials,
    interruption_count: interruptionCount,
    abandoned_branches:
      (session.metadata?.abandoned_branches as MetricsBundle["abandoned_branches"]) ?? [],
    cache_misses: cacheMisses,
    subagent_runs: subagentRuns,
    read_only_runs: findReadOnlyRuns(session),
    large_full_reads: findLargeFullReads(events, callById),
    idle_gaps_ms: findIdleGaps(session),
  };
}

function findDuplicates(events: Event[], callById: Map<string, ToolCallEvent>): DuplicateGroup[] {
  const byHash = new Map<string, { call: ToolCallEvent; result?: ToolResultEvent; order: number }[]>();
  const resultByCallEventId = new Map<string, ToolResultEvent>();
  const stateChangeOrders: number[] = [];

  events.forEach((event, order) => {
    if (event.kind === "tool_result" && event.call_event_id) {
      resultByCallEventId.set(event.call_event_id, event);
      const call = callById.get(event.call_event_id);
      // ATTEMPTS count, not just successes: after a failed Edit the agent
      // cannot know the file is unchanged without re-reading, so a repeat
      // across any state-changing attempt is not pure waste.
      if (call && STATE_CHANGING_TOOLS.has(call.name)) stateChangeOrders.push(order);
    }
  });

  events.forEach((event, order) => {
    if (event.kind !== "tool_call" || event.on_abandoned_branch) return;
    const result = resultByCallEventId.get(event.event_id);
    // Repeating a FAILING call is an error-loop pattern, not redundant work —
    // the error-run analysis owns it. Only successful repeats count here.
    if (result?.is_error) return;
    const list = byHash.get(event.input_hash) ?? [];
    list.push({ call: event, result, order });
    byHash.set(event.input_hash, list);
  });

  const groups: DuplicateGroup[] = [];
  for (const [hash, occurrences] of byHash) {
    if (occurrences.length < 2) continue;
    const first = occurrences[0]!;
    const last = occurrences[occurrences.length - 1]!;
    const hashes = occurrences.map((o) => o.result?.output_hash).filter(Boolean);
    const identical = hashes.length === occurrences.length && new Set(hashes).size === 1;
    const stateChangeBetween = stateChangeOrders.some((o) => o > first.order && o < last.order);
    groups.push({
      input_hash: hash,
      tool_name: first.call.name,
      call_event_ids: occurrences.map((o) => o.call.event_id),
      identical_results: identical,
      state_change_between: stateChangeBetween,
      repeated_output_bytes: occurrences
        .slice(1)
        .reduce((sum, o) => sum + (o.result?.output_bytes ?? 0), 0),
    });
  }
  return groups.sort((a, b) => b.call_event_ids.length - a.call_event_ids.length);
}

/** Target for an error run: file path when present, else normalized command/input. */
function errorTarget(call: ToolCallEvent | undefined): string | undefined {
  if (!call) return undefined;
  const input = call.input;
  if (typeof input.file_path === "string") return input.file_path;
  if (typeof input.command === "string") {
    return (input.command as string).replace(/\s+/g, " ").trim().slice(0, 120);
  }
  return undefined;
}

function findErrorRuns(events: Event[], callById: Map<string, ToolCallEvent>): ErrorRun[] {
  const runs: ErrorRun[] = [];
  let current: ErrorRun | undefined;
  let currentUsage = 0;
  const seenMessageIds = new Set<string>();

  const close = () => {
    if (current && current.length >= 2) {
      current.retry_usage_tokens = currentUsage;
      runs.push(current);
    }
    current = undefined;
    currentUsage = 0;
    seenMessageIds.clear();
  };

  for (const event of events) {
    if (event.on_abandoned_branch) continue;
    if (event.kind === "assistant_message" && current) {
      const mid = event.source_ids?.message_id;
      if (mid && !seenMessageIds.has(mid)) {
        seenMessageIds.add(mid);
        currentUsage += totalTokens(event.usage);
      }
      continue;
    }
    if (event.kind !== "tool_result") continue;
    if (!event.is_error || !event.error_signature || event.error_signature === "user_rejected") {
      // A successful (or unrelated) result for the same tool breaks the run.
      if (current && event.tool_name === current.tool_name && !event.is_error) close();
      continue;
    }
    const call = event.call_event_id ? callById.get(event.call_event_id) : undefined;
    const target = errorTarget(call);
    const matches =
      current &&
      current.signature === event.error_signature &&
      (current.target ?? "") === (target ?? "") &&
      (current.tool_name ?? "") === (event.tool_name ?? "");
    if (matches && current) {
      current.length += 1;
      current.result_event_ids.push(event.event_id);
      if (call) current.call_event_ids.push(call.event_id);
      if (event.timestamp) current.last_ts = event.timestamp;
    } else {
      close();
      current = {
        signature: event.error_signature,
        ...(target !== undefined ? { target } : {}),
        ...(event.tool_name ? { tool_name: event.tool_name } : {}),
        call_event_ids: call ? [call.event_id] : [],
        result_event_ids: [event.event_id],
        length: 1,
        retry_usage_tokens: 0,
        ...(event.timestamp ? { first_ts: event.timestamp, last_ts: event.timestamp } : {}),
      };
    }
  }
  close();
  return runs;
}

function findApiErrorRuns(events: Event[]): MetricsBundle["api_error_runs"] {
  const runs: MetricsBundle["api_error_runs"] = [];
  let current: { event_ids: string[]; total_retry_wait_ms: number } | undefined;
  for (const event of events) {
    if (event.kind === "system_event" && event.subtype === "api_error") {
      current ??= { event_ids: [], total_retry_wait_ms: 0 };
      current.event_ids.push(event.event_id);
      const wait = event.detail.retryInMs;
      if (typeof wait === "number") current.total_retry_wait_ms += Math.round(wait);
    } else if (event.kind === "assistant_message" || event.kind === "user_message") {
      if (current && current.event_ids.length > 0) runs.push(current);
      current = undefined;
    }
  }
  if (current && current.event_ids.length > 0) runs.push(current);
  return runs;
}

function findReadOnlyRuns(session: Session): MetricsBundle["read_only_runs"] {
  const runs: MetricsBundle["read_only_runs"] = [];
  for (const turn of session.turns) {
    let length = 0;
    let firstId: string | undefined;
    let lastId: string | undefined;
    let best: { length: number; firstId: string; lastId: string } | undefined;
    for (let i = turn.first_event_index; i <= turn.last_event_index && i < session.events.length; i++) {
      const event = session.events[i]!;
      if (event.kind !== "tool_call") continue;
      if (event.on_abandoned_branch) continue;
      if (READ_ONLY_TOOLS.has(event.name)) {
        length += 1;
        firstId ??= event.event_id;
        lastId = event.event_id;
        if (!best || length > best.length) best = { length, firstId: firstId!, lastId: lastId! };
      } else {
        length = 0;
        firstId = undefined;
        lastId = undefined;
      }
    }
    if (best) {
      runs.push({ turn_id: turn.id, length: best.length, first_event_id: best.firstId, last_event_id: best.lastId });
    }
  }
  return runs;
}

function findLargeFullReads(
  events: Event[],
  callById: Map<string, ToolCallEvent>,
): MetricsBundle["large_full_reads"] {
  const out: MetricsBundle["large_full_reads"] = [];
  for (const event of events) {
    if (event.kind !== "tool_result" || event.is_error || event.on_abandoned_branch) continue;
    if (event.tool_name !== "Read") continue;
    if ((event.output_bytes ?? 0) < LARGE_READ_BYTES) continue;
    const call = event.call_event_id ? callById.get(event.call_event_id) : undefined;
    if (!call) continue;
    if (call.input.offset !== undefined || call.input.limit !== undefined) continue;
    out.push({
      call_event_id: call.event_id,
      result_event_id: event.event_id,
      ...(typeof call.input.file_path === "string" ? { file_path: call.input.file_path } : {}),
      output_bytes: event.output_bytes ?? 0,
    });
  }
  return out;
}

function findIdleGaps(session: Session): number[] {
  const gaps: number[] = [];
  for (let i = 1; i < session.turns.length; i++) {
    const prev = session.turns[i - 1]!;
    const next = session.turns[i]!;
    if (next.origin !== "human") continue;
    const prevLast = session.events[prev.last_event_index];
    const nextFirst = session.events[next.first_event_index];
    if (prevLast?.timestamp && nextFirst?.timestamp) {
      const gap = Date.parse(nextFirst.timestamp) - Date.parse(prevLast.timestamp);
      if (gap >= 0) gaps.push(gap);
    }
  }
  return gaps;
}
