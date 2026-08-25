import { spawn } from "node:child_process";
import { openSync, readSync, closeSync, statSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Event, Finding, Session } from "@damame/ir";
import { totalTokens } from "@damame/ir";
import {
  defaultProjectsRoot,
  discoverSessions,
  parseSessionWithChildren,
} from "@damame/adapter-claude-code";
import { computeMetrics, type MetricsBundle } from "@damame/metrics";
import { DETECTORS, gradingVersion, runRules } from "@damame/rules";
import { buildProfile, probeEnvironment, sessionSkills, summarizeWithCache } from "@damame/profile";
import { feedbackStats, indexFindings, lastAnswers, recordAnswer, QUESTIONS, type Question } from "../feedback.js";
import { computeRecurrence } from "../recurrence.js";
import { auditorHealth, ClaudeCliDriver, humanAgreement, lastAudits } from "@damame/judge";
import { briefWithCache, cachedBrief, type GeneratedBrief } from "@damame/brief";
import { matchPlaybooks } from "@damame/playbooks";
import { NO_ACTION_REFS, REGISTRY } from "@damame/registry";
import { computeScore, SCORE_VERSION } from "@damame/score";
import { detectTechniques } from "@damame/profile";

const DAMAME_VERSION = "0.6.0";

interface CacheEntry {
  mtimeMs: number;
  payload: unknown;
}

const analysisCache = new Map<string, CacheEntry>();

/** Cheap title read: scan the tail of the file for the last ai-title line. */
function tailTitle(path: string, sizeBytes: number): string | undefined {
  try {
    const want = Math.min(sizeBytes, 256 * 1024);
    const fd = openSync(path, "r");
    const buf = Buffer.alloc(want);
    readSync(fd, buf, 0, want, Math.max(0, sizeBytes - want));
    closeSync(fd);
    const lines = buf.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (!line.includes('"ai-title"')) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === "ai-title" && typeof parsed.aiTitle === "string") return parsed.aiTitle;
      } catch {
        // partial first line of the tail window — keep scanning
      }
    }
  } catch {
    // unreadable file — no title
  }
  return undefined;
}

function excerptFor(event: Event): string {
  switch (event.kind) {
    case "user_message":
    case "thinking":
      return event.text.slice(0, 240);
    case "assistant_message":
      return (event.text ?? "").slice(0, 240);
    case "tool_call":
      return `${event.name}(${JSON.stringify(event.input).slice(0, 200)})`;
    case "tool_result":
      return (event.output_text ?? "").slice(0, 240);
    case "compaction":
      return `compaction: ${event.pre_tokens ?? "?"} → ${event.post_tokens ?? "?"} tokens`;
    case "system_event":
      return JSON.stringify(event.detail).slice(0, 200);
    default:
      return event.kind;
  }
}

/**
 * Best-available name for a delegation, in order of authority: the name the
 * harness itself recorded in the tool result, the spawn call's description,
 * an explicit name argument, the meta literal inside an inline script, and
 * finally the script file's basename (scriptPath re-invocations carry the
 * name there: <name>-wf_<id>.js).
 */
function workflowTaskName(eventName: string | undefined, input: Record<string, unknown>): string {
  if (eventName) return eventName;
  if (typeof input.description === "string" && input.description) return input.description;
  if (typeof input.name === "string" && input.name) return input.name;
  if (typeof input.script === "string") {
    const m = /name:\s*['"]([^'"\n]{1,80})['"]/.exec(input.script);
    if (m) return m[1]!;
  }
  if (typeof input.scriptPath === "string") {
    const base = input.scriptPath.split("/").pop() ?? "";
    const m = /^(.+?)-wf_[a-z0-9-]+\.js$/.exec(base);
    if (m) return m[1]!;
    if (base.endsWith(".js")) return base.slice(0, -3);
  }
  return "";
}

function buildSessionPayload(session: Session, metrics: MetricsBundle, findings: Finding[], children: Session[]) {
  const eventById = new Map(session.events.map((e) => [e.event_id, e]));
  const turnIndexById = new Map(session.turns.map((t) => [t.id, t.index]));

  // Compaction detail per turn index (pre/post tokens for the timeline).
  // Abandoned-branch compactions are excluded — they are not part of the
  // surviving conversation. A turn can compact more than once, so this is a
  // list, never a single overwritten entry.
  const compactionsByTurn = new Map<number, Array<{ pre: number | null; post: number | null }>>();
  for (const e of session.events) {
    if (e.kind !== "compaction" || !e.turn_id || e.on_abandoned_branch) continue;
    const i = turnIndexById.get(e.turn_id);
    if (i === undefined) continue;
    const list = compactionsByTurn.get(i) ?? [];
    list.push({ pre: e.pre_tokens ?? null, post: e.post_tokens ?? null });
    compactionsByTurn.set(i, list);
  }

  // Per-turn activity: which tools ran and which agents were spawned, so the
  // timeline can narrate each turn instead of only counting it. Calls and
  // errors are recounted here over live events only — the parser's per-turn
  // counts include abandoned-branch events and would disagree with the
  // per-tool breakdown rendered right next to them.
  const turnTools = new Map<number, Map<string, number>>();
  const turnAgents = new Map<number, string[]>();
  const turnFiles = new Map<number, Map<string, number>>();
  const turnLive = new Map<number, { calls: number; errors: number }>();
  for (const e of session.events) {
    if (e.on_abandoned_branch || !e.turn_id) continue;
    const i = turnIndexById.get(e.turn_id);
    if (i === undefined) continue;
    const live = turnLive.get(i) ?? { calls: 0, errors: 0 };
    if (e.kind === "tool_call") {
      const m = turnTools.get(i) ?? new Map<string, number>();
      m.set(e.name, (m.get(e.name) ?? 0) + 1);
      turnTools.set(i, m);
      live.calls += 1;
      if (typeof e.input.file_path === "string") {
        const short = e.input.file_path.split("/").slice(-1)[0]!;
        const f = turnFiles.get(i) ?? new Map<string, number>();
        f.set(short, (f.get(short) ?? 0) + 1);
        turnFiles.set(i, f);
      }
    } else if (e.kind === "tool_result" && e.is_error) {
      live.errors += 1;
    } else if (e.kind === "subagent_run") {
      const list = turnAgents.get(i) ?? [];
      list.push(e.agent_type ?? (e.child_kind === "workflow" ? "workflow" : e.spawn_tool));
      turnAgents.set(i, list);
    }
    turnLive.set(i, live);
  }

  const turns = session.turns.map((t) => ({
    i: t.index,
    origin: t.origin,
    preview: (t.prompt_text ?? "").slice(0, 160),
    tokens: totalTokens(t.usage),
    out_tokens: t.usage?.output_tokens ?? 0,
    calls: turnLive.get(t.index)?.calls ?? 0,
    errors: turnLive.get(t.index)?.errors ?? 0,
    interrupted: t.interrupted === true,
    compaction: compactionsByTurn.has(t.index),
    compactions: compactionsByTurn.get(t.index) ?? [],
    wall_ms: t.wall_clock_ms ?? null,
    tools: [...(turnTools.get(t.index)?.entries() ?? [])].sort((a, b) => b[1] - a[1]),
    agents: turnAgents.get(t.index) ?? [],
  }));

  // "How Claude worked": turns classified by dominant activity, adjacent
  // same-activity turns merged into phases. This is the page's high-level
  // spine — activity-centric, not prompt-centric (the user knows what they
  // typed; what they can't see is what Claude was DOING).
  const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch", "NotebookRead", "ToolSearch"]);
  const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
  const PLAN_TOOLS = new Set(["TodoWrite", "EnterPlanMode", "ExitPlanMode", "AskUserQuestion"]);
  const activityOf = (i: number): string => {
    const agents = turnAgents.get(i) ?? [];
    if (agents.length > 0) return "delegating";
    const tools = turnTools.get(i);
    const live = turnLive.get(i) ?? { calls: 0, errors: 0 };
    if (!tools || live.calls === 0) return "discussing";
    let reads = 0;
    let edits = 0;
    let runs = 0;
    let plans = 0;
    for (const [name, n] of tools) {
      if (READ_TOOLS.has(name)) reads += n;
      else if (EDIT_TOOLS.has(name)) edits += n;
      else if (PLAN_TOOLS.has(name)) plans += n;
      else runs += n; // Bash and everything else that acts
    }
    if (live.errors >= 3 && edits > 0) return "debugging";
    const best = Math.max(reads, edits, runs, plans);
    if (best === edits && edits > 0) return "building";
    if (best === reads && reads > 0) return "exploring";
    if (best === runs && runs > 0) return "verifying";
    return "planning";
  };
  // A raw phase per activity switch would produce hundreds of slivers on a
  // real session (build↔verify alternates constantly). High-level means a
  // dozen phases, so raw units go through a merge pipeline: absorb chatter,
  // unite the build/verify/debug family, then merge smallest-first down to a
  // hard budget. Labels stay honest: a merged phase is relabeled by whichever
  // activity dominates its tool calls.
  interface PhaseUnit {
    start_turn: number;
    end_turn: number;
    turn_count: number;
    human_prompts: number;
    tokens: number;
    calls: number;
    errors: number;
    wall_ms: number | null;
    agents: string[];
    tools: Map<string, number>;
    files: Map<string, number>;
    activity_calls: Map<string, number>;
    compactions: number;
    preview: string;
  }
  const MAKING = new Set(["building", "verifying", "debugging"]);
  const PHASE_BUDGET = 14;
  const unitFor = (t: (typeof turns)[number], label: string): PhaseUnit => ({
    start_turn: t.i,
    end_turn: t.i,
    turn_count: 1,
    human_prompts: t.origin === "human" ? 1 : 0,
    tokens: t.tokens,
    calls: t.calls,
    errors: t.errors,
    wall_ms: t.wall_ms ?? null,
    agents: [...t.agents],
    tools: new Map(t.tools),
    files: new Map(turnFiles.get(t.i) ?? []),
    activity_calls: new Map([[label, Math.max(t.calls, 1)]]),
    compactions: t.compactions.length,
    preview: t.origin === "human" ? (t.preview ?? "").slice(0, 110) : "",
  });
  const mergeInto = (a: PhaseUnit, b: PhaseUnit): PhaseUnit => {
    // a and b are adjacent; result spans both.
    const out = a.start_turn <= b.start_turn ? a : b;
    const other = out === a ? b : a;
    out.end_turn = Math.max(a.end_turn, b.end_turn);
    out.start_turn = Math.min(a.start_turn, b.start_turn);
    out.turn_count += other.turn_count;
    out.human_prompts += other.human_prompts;
    out.tokens += other.tokens;
    out.calls += other.calls;
    out.errors += other.errors;
    out.wall_ms = a.wall_ms === null && b.wall_ms === null ? null : (a.wall_ms ?? 0) + (b.wall_ms ?? 0);
    out.agents = [...a.agents, ...b.agents];
    for (const [k, v] of other.tools) out.tools.set(k, (out.tools.get(k) ?? 0) + v);
    for (const [k, v] of other.files) out.files.set(k, (out.files.get(k) ?? 0) + v);
    for (const [k, v] of other.activity_calls) out.activity_calls.set(k, (out.activity_calls.get(k) ?? 0) + v);
    out.compactions += other.compactions;
    if (!out.preview) out.preview = other.preview;
    return out;
  };
  const dominantLabel = (u: PhaseUnit): string => {
    let best = "discussing";
    let bestCalls = -1;
    for (const [label, calls] of u.activity_calls) {
      if (calls > bestCalls) {
        best = label;
        bestCalls = calls;
      }
    }
    return best;
  };

  let units: PhaseUnit[] = turns.map((t) => unitFor(t, activityOf(t.i)));
  const mergeAdjacent = (sameGroup: (x: string, y: string) => boolean) => {
    const merged: PhaseUnit[] = [];
    for (const u of units) {
      const last = merged[merged.length - 1];
      if (last && sameGroup(dominantLabel(last), dominantLabel(u))) merged[merged.length - 1] = mergeInto(last, u);
      else merged.push(u);
    }
    units = merged;
  };
  // 1. exact-label runs collapse
  mergeAdjacent((x, y) => x === y);
  // 2. pure chatter units (no calls) fold into the preceding work phase
  units = units.reduce<PhaseUnit[]>((acc, u) => {
    const last = acc[acc.length - 1];
    if (last && u.calls === 0 && dominantLabel(u) === "discussing") acc[acc.length - 1] = mergeInto(last, u);
    else acc.push(u);
    return acc;
  }, []);
  // 3. the build/verify/debug family is one kind of work
  mergeAdjacent((x, y) => x === y || (MAKING.has(x) && MAKING.has(y)));
  // 4. hard budget: repeatedly merge the lightest phase into its lighter neighbor
  while (units.length > PHASE_BUDGET) {
    let idx = 0;
    let min = Infinity;
    for (let i = 0; i < units.length; i++) {
      const weight = units[i]!.calls + units[i]!.turn_count;
      if (weight < min) {
        min = weight;
        idx = i;
      }
    }
    const left = idx > 0 ? units[idx - 1]! : undefined;
    const right = idx < units.length - 1 ? units[idx + 1]! : undefined;
    const into = !left ? idx + 1 : !right ? idx - 1 : (left.calls + left.turn_count <= right.calls + right.turn_count ? idx - 1 : idx + 1);
    const lo = Math.min(idx, into);
    units.splice(lo, 2, mergeInto(units[lo]!, units[lo + 1]!));
  }

  const phases = units.map((u) => ({
    label: dominantLabel(u),
    start_turn: u.start_turn,
    end_turn: u.end_turn,
    turn_count: u.turn_count,
    human_prompts: u.human_prompts,
    tokens: u.tokens,
    calls: u.calls,
    errors: u.errors,
    wall_ms: u.wall_ms,
    agents: u.agents,
    top_tools: [...u.tools.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6),
    top_files: [...u.files.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4),
    compactions: u.compactions,
    preview: u.preview,
  }));

  // Agents drill-down: one row per subagent_run, enriched with the spawn
  // call's task text and the child transcript's own timings. A Workflow spawn
  // (child_ref = runId) owns every step agent ingested under its run
  // directory: those aggregate into the run's row rather than appearing as
  // orphan duplicates. Children no event references at all (e.g. a Task whose
  // result lacked an agentId) still get fallback rows so nothing is hidden.
  const childByAgentId = new Map(children.map((c) => [c.metadata?.agent_id as string | undefined, c]));
  const childrenByRunId = new Map<string, Session[]>();
  for (const c of children) {
    const runId = c.metadata?.workflow_run_id as string | undefined;
    if (!runId) continue;
    const group = childrenByRunId.get(runId) ?? [];
    group.push(c);
    childrenByRunId.set(runId, group);
  }
  const linkedChildren = new Set<Session>();
  const groupStats = (group: Session[]) => {
    if (!group.length) return { duration_ms: null, tool_calls: null, child_tokens: null };
    const starts = group.map((c) => c.started_at).filter((s): s is string => !!s);
    const ends = group.map((c) => c.ended_at).filter((s): s is string => !!s);
    const duration_ms =
      starts.length && ends.length
        ? Math.max(0, Math.max(...ends.map(Date.parse)) - Math.min(...starts.map(Date.parse)))
        : null;
    const tokens = group.reduce((s, c) => s + (c.usage_totals ? totalTokens(c.usage_totals) : 0), 0);
    return {
      duration_ms,
      tool_calls: group.reduce((s, c) => s + c.events.filter((e) => e.kind === "tool_call").length, 0),
      child_tokens: tokens > 0 ? tokens : null,
    };
  };
  const agents = session.events
    .filter((e) => e.kind === "subagent_run")
    .map((e) => {
      const spawn = e.spawn_call_event_id ? eventById.get(e.spawn_call_event_id) : undefined;
      const input: Record<string, unknown> = spawn?.kind === "tool_call" ? spawn.input : {};
      const single = e.child_ref ? childByAgentId.get(e.child_ref) : undefined;
      const group = single ? [single] : e.child_ref ? (childrenByRunId.get(e.child_ref) ?? []) : [];
      for (const c of group) linkedChildren.add(c);
      const stats = groupStats(group);
      return {
        type: e.agent_type ?? (e.child_kind === "workflow" ? "workflow" : e.spawn_tool),
        kind: e.child_kind ?? "agent",
        spawn_tool: e.spawn_tool,
        model: e.resolved_model ?? null,
        task: workflowTaskName(e.name, input),
        prompt_preview: typeof input.prompt === "string" ? input.prompt.slice(0, 240) : "",
        tokens: e.usage ? totalTokens(e.usage) : stats.child_tokens,
        duration_ms: stats.duration_ms,
        tool_calls: stats.tool_calls,
        steps: single ? null : group.length || null,
        status: e.status ?? null,
        turn: e.turn_id ? (turnIndexById.get(e.turn_id) ?? null) : null,
        on_abandoned_branch: e.on_abandoned_branch === true,
      };
    });
  for (const child of children) {
    if (linkedChildren.has(child)) continue;
    const stats = groupStats([child]);
    agents.push({
      type: child.parent?.agent_type ?? "subagent",
      kind: child.metadata?.workflow_run_id ? ("workflow" as const) : ("agent" as const),
      spawn_tool: child.metadata?.workflow_run_id ? "Workflow" : "Agent",
      model: null,
      task: "",
      prompt_preview: "",
      tokens: stats.child_tokens,
      duration_ms: stats.duration_ms,
      tool_calls: stats.tool_calls,
      steps: null,
      status: null,
      turn: null,
      on_abandoned_branch: false,
    });
  }

  const findingsOut = findings.map((f) => ({
    ...f,
    turn_indexes: [
      ...new Set(
        f.evidence.events
          .map((ref) => eventById.get(ref.event_id))
          .filter((e): e is Event => e !== undefined && e.turn_id !== undefined)
          .map((e) => turnIndexById.get(e.turn_id!))
          .filter((i): i is number => i !== undefined),
      ),
    ],
    evidence_excerpts: f.evidence.events.slice(0, 8).map((ref) => {
      const event = eventById.get(ref.event_id);
      return event
        ? {
            event_id: event.event_id,
            kind: event.kind,
            timestamp: event.timestamp ?? null,
            snippet: excerptFor(event),
            file: event.raw_ref.file,
            line: event.raw_ref.line,
          }
        : { event_id: ref.event_id, kind: "unknown", timestamp: null, snippet: "", file: "", line: 0 };
    }),
  }));

  const usedSkills = new Set([
    ...(session.environment?.invoked_skills.map((s) => s.name) ?? []),
    ...session.events.flatMap((e) => (e.kind === "assistant_message" && e.attribution?.skill ? [e.attribution.skill] : [])),
  ]);

  const abandonedTokens = metrics.abandoned_branches.reduce((s, b) => s + b.usage_tokens, 0);
  const idleMs = metrics.idle_gaps_ms.reduce((s, g) => s + g, 0);

  return {
    meta: {
      id: session.id,
      title: session.title ?? session.slug ?? session.id,
      project: session.project?.cwd ?? null,
      started_at: session.started_at ?? null,
      ended_at: session.ended_at ?? null,
      versions: [session.source.tool_version_min, session.source.tool_version_max],
      child_count: children.length,
    },
    facts: {
      usage: metrics.totals.usage,
      total_tokens: metrics.totals.total_tokens,
      turn_count: metrics.totals.turn_count,
      human_turn_count: metrics.totals.human_turn_count,
      tool_call_count: metrics.totals.tool_call_count,
      tool_error_count: metrics.totals.tool_error_count,
      subagent_count: metrics.subagent_runs.length,
      compactions: metrics.compactions.length,
      interruptions: metrics.interruption_count,
      denials: metrics.permission_denials.length,
      api_error_bursts: metrics.api_error_runs.length,
      cache_misses: metrics.cache_misses.length,
      abandoned_branches: metrics.abandoned_branches.length,
      abandoned_tokens: abandonedTokens,
      idle_ms: idleMs,
    },
    // Score denominator = fresh work only (input + output + cache writes);
    // cache reads are re-served context, not new work — including them makes
    // any waste look microscopic on long cached sessions.
    score: computeScore(
      findings,
      (metrics.totals.usage.input_tokens ?? 0) +
        (metrics.totals.usage.output_tokens ?? 0) +
        (metrics.totals.usage.cache_creation_input_tokens ?? 0),
      detectTechniques(session, metrics),
    ),
    turns,
    phases,
    agents,
    per_model: Object.entries(metrics.per_model).map(([model, s]) => ({
      model,
      usage: s.usage,
      messages: s.message_count,
    })),
    per_tool: Object.entries(metrics.per_tool)
      .sort((a, b) => b[1].calls - a[1].calls)
      .map(([name, s]) => ({
        name,
        calls: s.calls,
        errors: s.errors,
        total_duration_ms: s.total_duration_ms,
      })),
    findings: findingsOut,
    skills: sessionSkills(session, metrics, findings),
    inventory: {
      skills: (session.environment?.skills ?? []).map((s) => ({ name: s.name, used: usedSkills.has(s.name) })),
      agents: (session.environment?.agents ?? []).filter((a) => !a.removed).map((a) => a.type),
      observed_tools: session.environment?.core_tools_observed ?? [],
      deferred_count: (session.environment?.deferred_tools ?? []).filter((t) => t.available).length,
    },
    grading: { ...gradingVersion(session, DAMAME_VERSION), score_version: SCORE_VERSION },
  };
}

async function analyzeSession(path: string): Promise<unknown> {
  const mtimeMs = statSync(path).mtimeMs;
  const cached = analysisCache.get(path);
  if (cached && cached.mtimeMs === mtimeMs) return cached.payload;
  const { session, children } = await parseSessionWithChildren(path);
  const metrics = computeMetrics(session);
  const findings = runRules(session, metrics);
  indexFindings(session, findings);
  const payload = buildSessionPayload(session, metrics, findings, children);
  analysisCache.set(path, { mtimeMs, payload });
  return payload;
}

/**
 * Brief generation: one in-flight run per transcript (opening the same
 * session in two tabs must not spawn two `claude -p` processes), CLI
 * availability probed once.
 */
const briefInFlight = new Map<string, Promise<GeneratedBrief>>();
let cliAvailable: Promise<boolean> | undefined;

async function sessionBrief(path: string): Promise<{ status: string; [k: string]: unknown }> {
  const hit = cachedBrief(path);
  if (hit) return { status: "ready", ...hit };
  cliAvailable ??= ClaudeCliDriver.available();
  if (!(await cliAvailable)) {
    return { status: "unavailable", reason: "claude CLI not found — the brief needs your local claude login" };
  }
  let pending = briefInFlight.get(path);
  if (!pending) {
    pending = briefWithCache(path, new ClaudeCliDriver("sonnet")).finally(() => briefInFlight.delete(path));
    briefInFlight.set(path, pending);
  }
  try {
    return { status: "ready", ...(await pending) };
  } catch (error) {
    return { status: "error", reason: String(error).slice(0, 300) };
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export interface UiServerOptions {
  root?: string;
  port?: number;
  openBrowser?: boolean;
}

export async function startUiServer(opts: UiServerOptions = {}): Promise<{ url: string; close: () => void }> {
  const root = opts.root ?? defaultProjectsRoot();
  const appHtml = readFileSync(new URL("./app.html", import.meta.url), "utf8");

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      // Local-only tool: reject anything that isn't a same-machine request.
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(appHtml);
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/sessions") {
        const sessions = await discoverSessions(root);
        json(
          res,
          200,
          sessions.map((s) => ({
            id: s.sessionId,
            project: s.projectDir.replace(/^-/, "").replace(/-/g, "/"),
            path: s.path,
            size_bytes: s.sizeBytes,
            modified_at: s.modifiedAt.toISOString(),
            title: tailTitle(s.path, s.sizeBytes) ?? null,
          })),
        );
        return;
      }
      const playbookMatch = /^\/api\/session\/([\w-]+)\/playbooks$/.exec(url.pathname);
      if (req.method === "GET" && playbookMatch) {
        const sessions = await discoverSessions(root);
        const target = sessions.find((s) => s.sessionId.startsWith(playbookMatch[1]!));
        if (!target) {
          json(res, 404, { error: "session not found" });
          return;
        }
        const tags = (url.searchParams.get("tags") ?? "").split(",").filter(Boolean);
        const payload = (await analyzeSession(target.path)) as { findings: Parameters<typeof matchPlaybooks>[1] };
        json(res, 200, { matches: matchPlaybooks(tags, payload.findings) });
        return;
      }
      const briefMatch = /^\/api\/session\/([\w-]+)\/brief$/.exec(url.pathname);
      if (req.method === "GET" && briefMatch) {
        const sessions = await discoverSessions(root);
        const target = sessions.find((s) => s.sessionId.startsWith(briefMatch[1]!));
        if (!target) {
          json(res, 404, { error: "session not found" });
          return;
        }
        json(res, 200, await sessionBrief(target.path));
        return;
      }
      const sessionMatch = /^\/api\/session\/([\w-]+)$/.exec(url.pathname);
      if (req.method === "GET" && sessionMatch) {
        const sessions = await discoverSessions(root);
        const target = sessions.find((s) => s.sessionId.startsWith(sessionMatch[1]!));
        if (!target) {
          json(res, 404, { error: "session not found" });
          return;
        }
        // Feedback state is overlaid per request — the analysis cache must not
        // freeze answers recorded after the first view.
        const payload = (await analyzeSession(target.path)) as { findings: Array<{ dedupe_key: string }> };
        const answers = lastAnswers();
        const audits = lastAudits();
        json(res, 200, {
          ...payload,
          findings: payload.findings.map((f) => {
            const audit = audits.get(f.dedupe_key);
            return {
              ...f,
              feedback: answers.get(f.dedupe_key) ?? { accurate: null, applicable: null },
              audit: audit
                ? { accurate: audit.accurate, applicable: audit.applicable, model: audit.model, escalated: audit.escalated }
                : null,
            };
          }),
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/feedback") {
        const body = JSON.parse(await readBody(req));
        const question = body.question as Question;
        if (typeof body.key !== "string" || !QUESTIONS.includes(question) || typeof body.answer !== "boolean") {
          json(res, 400, { error: `need {key, question: ${QUESTIONS.join("|")}, answer: boolean}` });
          return;
        }
        const result = recordAnswer(body.key, question, body.answer, typeof body.note === "string" ? body.note : undefined);
        json(res, result.ok ? 200 : 400, result);
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/profile") {
        const sessions = await discoverSessions(root);
        const summaries = [];
        for (const s of sessions) {
          try {
            summaries.push(await summarizeWithCache(s.path));
          } catch {
            // one unreadable session must not break the profile
          }
        }
        const cwds = [...new Set(summaries.map((s) => s.cwd).filter((c): c is string => !!c))];
        json(res, 200, buildProfile(summaries, probeEnvironment(cwds)));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/feedback/stats") {
        json(res, 200, {
          rules: feedbackStats(),
          recurrence: await computeRecurrence(await discoverSessions(root)),
          auditor: { health: auditorHealth(), agreement: humanAgreement(lastAnswers()) },
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/registry") {
        json(res, 200, { entries: REGISTRY, no_action_refs: [...NO_ACTION_REFS] });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/rules") {
        json(
          res,
          200,
          DETECTORS.map((d) => ({ id: d.id, version: d.version, category: d.category, summary: d.summary })),
        );
        return;
      }
      json(res, 404, { error: "not found" });
    } catch (error) {
      json(res, 500, { error: String(error) });
    }
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    // 127.0.0.1 only: the dashboard must never be reachable from the network.
    server.listen(opts.port ?? 0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });

  const url = `http://127.0.0.1:${port}`;
  if (opts.openBrowser !== false && process.platform === "darwin") {
    spawn("open", [url], { stdio: "ignore", detached: true }).unref();
  }
  return { url, close: () => server.close() };
}
