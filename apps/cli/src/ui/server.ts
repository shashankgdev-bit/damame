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

const DAMAME_VERSION = "0.3.0";

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

function buildSessionPayload(session: Session, metrics: MetricsBundle, findings: Finding[], childCount: number) {
  const eventById = new Map(session.events.map((e) => [e.event_id, e]));
  const turnIndexById = new Map(session.turns.map((t) => [t.id, t.index]));

  const compactionTurns = new Set(
    session.events.filter((e) => e.kind === "compaction" && e.turn_id).map((e) => turnIndexById.get(e.turn_id!)),
  );

  const turns = session.turns.map((t) => ({
    i: t.index,
    origin: t.origin,
    preview: (t.prompt_text ?? "").slice(0, 160),
    tokens: totalTokens(t.usage),
    out_tokens: t.usage?.output_tokens ?? 0,
    calls: t.tool_call_count ?? 0,
    errors: t.error_count ?? 0,
    interrupted: t.interrupted === true,
    compaction: compactionTurns.has(t.index),
    wall_ms: t.wall_clock_ms ?? null,
  }));

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

  return {
    meta: {
      id: session.id,
      title: session.title ?? session.slug ?? session.id,
      project: session.project?.cwd ?? null,
      started_at: session.started_at ?? null,
      ended_at: session.ended_at ?? null,
      versions: [session.source.tool_version_min, session.source.tool_version_max],
      child_count: childCount,
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
    },
    turns,
    per_tool: Object.entries(metrics.per_tool)
      .sort((a, b) => b[1].calls - a[1].calls)
      .slice(0, 12)
      .map(([name, s]) => ({ name, calls: s.calls, errors: s.errors })),
    findings: findingsOut,
    skills: sessionSkills(session, metrics, findings),
    inventory: {
      skills: (session.environment?.skills ?? []).map((s) => ({ name: s.name, used: usedSkills.has(s.name) })),
      agents: (session.environment?.agents ?? []).filter((a) => !a.removed).map((a) => a.type),
      observed_tools: session.environment?.core_tools_observed ?? [],
      deferred_count: (session.environment?.deferred_tools ?? []).filter((t) => t.available).length,
    },
    grading: gradingVersion(session, DAMAME_VERSION),
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
  const payload = buildSessionPayload(session, metrics, findings, children.length);
  analysisCache.set(path, { mtimeMs, payload });
  return payload;
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
        json(res, 200, {
          ...payload,
          findings: payload.findings.map((f) => ({
            ...f,
            feedback: answers.get(f.dedupe_key) ?? { accurate: null, applicable: null },
          })),
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
        });
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
