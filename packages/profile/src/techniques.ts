import type { Session } from "@damame/ir";
import type { MetricsBundle } from "@damame/metrics";
import type { SkillId } from "./taxonomy.js";

/**
 * The technique registry — concrete, named practices, each deterministically
 * observable in a transcript. `detect` is pure: same session → same count.
 * Environment-derived techniques (hooks, CLAUDE.md, allowlists) are probed
 * separately at profile time (env-techniques.ts) because they live on disk,
 * not in transcripts — the profile labels their provenance accordingly.
 */
export interface Technique {
  id: string;
  skill: SkillId;
  title: string;
  /** 2–3 sentence lesson: what it is and when to reach for it. */
  lesson: string;
  source: "transcript" | "environment";
  detect?: (session: Session, metrics: MetricsBundle) => number;
}

function countToolCalls(session: Session, predicate: (name: string, input: Record<string, unknown>) => boolean): number {
  let count = 0;
  for (const event of session.events) {
    if (event.kind === "tool_call" && !event.on_abandoned_branch && predicate(event.name, event.input)) count += 1;
  }
  return count;
}

export const TECHNIQUES: Technique[] = [
  {
    id: "plan-mode-first",
    skill: "planning-decomposition",
    title: "Plan mode before big changes",
    lesson:
      "Start large or ambiguous tasks in plan mode: the AI proposes an approach you approve before any tokens are spent executing. Direction changes then happen on a plan, not on half-built work.",
    source: "transcript",
    detect: (session) =>
      (session.metadata?.permission_modes as string[] | undefined)?.includes("plan") ? 1 : 0,
  },
  {
    id: "todo-tracking",
    skill: "planning-decomposition",
    title: "Task tracking on multi-step work",
    lesson:
      "Ask for (or let the AI keep) a running todo list on multi-step tasks. It keeps long sessions oriented and makes dropped steps visible instead of silently forgotten.",
    source: "transcript",
    detect: (session, m) => m.per_tool["TodoWrite"]?.calls ?? countToolCalls(session, (n) => n === "TodoWrite"),
  },
  {
    id: "subagent-delegation",
    skill: "agent-orchestration",
    title: "Delegating bulk work to subagents",
    lesson:
      "When a task needs many files read or searched, delegate to a subagent (like Explore): only its conclusions return to your session, keeping the main context small and delaying compaction.",
    source: "transcript",
    detect: (_s, m) => m.subagent_runs.length,
  },
  {
    id: "parallel-agents",
    skill: "agent-orchestration",
    title: "Running agents in parallel",
    lesson:
      "Independent investigations don't need to wait for each other — spawn several agents in one turn and they run concurrently. Wall-clock time drops to the slowest branch instead of the sum.",
    source: "transcript",
    detect: (session) => {
      const spawnsByTurn = new Map<string, number>();
      for (const e of session.events) {
        if (e.kind === "subagent_run" && e.turn_id) {
          spawnsByTurn.set(e.turn_id, (spawnsByTurn.get(e.turn_id) ?? 0) + 1);
        }
      }
      return [...spawnsByTurn.values()].filter((n) => n >= 2).length;
    },
  },
  {
    id: "workflow-orchestration",
    skill: "agent-orchestration",
    title: "Multi-agent workflows",
    lesson:
      "For work with a known fan-out shape (review every module, migrate every call site), a workflow script orchestrates many agents deterministically — pipelines, verification passes, synthesis.",
    source: "transcript",
    detect: (session) =>
      session.events.filter((e) => e.kind === "subagent_run" && e.spawn_tool === "Workflow").length,
  },
  {
    id: "background-tasks",
    skill: "agent-orchestration",
    title: "Background execution",
    lesson:
      "Long-running commands (builds, test suites, servers) can run in the background while the session continues. You get notified on completion instead of blocking every turn on the slowest command.",
    source: "transcript",
    detect: (session) => countToolCalls(session, (n, i) => n === "Bash" && i.run_in_background === true),
  },
  {
    id: "targeted-reads",
    skill: "context-engineering",
    title: "Targeted file reads",
    lesson:
      "Reading a whole large file pushes every byte into the context window, where every later request re-carries it. Reading the relevant region (offset/limit) or grepping first keeps context lean.",
    source: "transcript",
    detect: (session) =>
      countToolCalls(session, (n, i) => n === "Read" && (i.offset !== undefined || i.limit !== undefined)),
  },
  {
    id: "search-before-read",
    skill: "context-engineering",
    title: "Search before reading",
    lesson:
      "Grep and Glob locate the right place cheaply; Read then opens only what matters. Search-first is the difference between carrying a codebase in context and carrying an answer.",
    source: "transcript",
    detect: (session) => countToolCalls(session, (n) => n === "Grep" || n === "Glob"),
  },
  {
    id: "prompt-cache-stability",
    skill: "context-engineering",
    title: "Stable prompt cache",
    lesson:
      "The prompt cache only pays off when earlier context stays byte-identical between requests. Avoid toggling tools or MCP servers mid-session — configure once at the start.",
    source: "transcript",
    detect: (session, m) =>
      m.cache_misses.length === 0 &&
      session.events.filter((e) => e.kind === "assistant_message").length > 10
        ? 1
        : 0,
  },
  {
    id: "structured-questions",
    skill: "prompt-engineering",
    title: "Letting the AI ask structured questions",
    lesson:
      "When the AI asks a structured question (multiple choice), answering it is far cheaper than a wrong guess. Encouraging clarify-then-execute beats a long correction loop afterward.",
    source: "transcript",
    detect: (session, m) => m.per_tool["AskUserQuestion"]?.calls ?? countToolCalls(session, (n) => n === "AskUserQuestion"),
  },
  {
    id: "custom-skills",
    skill: "tooling-fluency",
    title: "Using skills",
    lesson:
      "Skills are packaged expertise — a review checklist, a deploy procedure, a design method — loaded on demand. Invoking one replaces re-explaining the same instructions every session.",
    source: "transcript",
    detect: (session) => session.environment?.invoked_skills.length ?? 0,
  },
  {
    id: "slash-commands",
    skill: "tooling-fluency",
    title: "Slash commands",
    lesson:
      "Slash commands (/loop, /code-review, custom ones) trigger packaged behavior in one keystroke. Recurring instructions you type by hand are candidates to become one.",
    source: "transcript",
    detect: (session) =>
      session.events.filter((e) => e.kind === "user_message" && e.slash_command).length,
  },
  {
    id: "mcp-tools",
    skill: "tooling-fluency",
    title: "MCP tools",
    lesson:
      "MCP servers connect the AI to external systems — drives, calendars, databases, internal APIs. Work that round-trips through copy-paste is often one connected tool away from direct.",
    source: "transcript",
    detect: (session) => countToolCalls(session, (n) => n.startsWith("mcp__")),
  },
  {
    id: "web-research",
    skill: "tooling-fluency",
    title: "Web research in-session",
    lesson:
      "WebSearch and WebFetch let the AI check current docs and facts instead of guessing from training data. For anything version-sensitive, research-then-answer beats recall.",
    source: "transcript",
    detect: (session) => countToolCalls(session, (n) => n === "WebSearch" || n === "WebFetch"),
  },
  {
    id: "verify-with-tests",
    skill: "recovery-verification",
    title: "Verifying with tests",
    lesson:
      "After the AI edits code, a test run is the cheapest truth serum. Sessions that run tests after edit bursts catch breakage while the context to fix it is still loaded.",
    source: "transcript",
    detect: (session) =>
      countToolCalls(
        session,
        (n, i) =>
          n === "Bash" &&
          typeof i.command === "string" &&
          /\b(vitest|jest|pytest|go test|cargo test|npm (run )?test|mvn test|rspec|phpunit)\b/.test(i.command),
      ),
  },
  // ---- environment-derived (probed at profile time, not per transcript) ----
  {
    id: "hooks",
    skill: "workflow-automation",
    title: "Hooks",
    lesson:
      "Hooks run commands automatically on events — format after every edit, notify when attention is needed. Anything you do manually after every AI action is a hook waiting to be written.",
    source: "environment",
  },
  {
    id: "claude-md",
    skill: "workflow-automation",
    title: "Project memory (CLAUDE.md)",
    lesson:
      "A CLAUDE.md in your project is loaded every session: conventions, commands, constraints. Instructions you've typed twice belong in it — the third session gets them for free.",
    source: "environment",
  },
  {
    id: "permission-allowlists",
    skill: "workflow-automation",
    title: "Permission allowlists",
    lesson:
      "Commands you approve every time (your test runner, your build) belong in permissions.allow. Each allowlist entry converts a recurring interruption into silence.",
    source: "environment",
  },
];

export const TECHNIQUE_BY_ID = new Map(TECHNIQUES.map((t) => [t.id, t]));

/** Pure per-session technique counts (transcript-derived only). */
export function detectTechniques(session: Session, metrics: MetricsBundle): Record<string, number> {
  const out: Record<string, number> = {};
  for (const technique of TECHNIQUES) {
    if (technique.source !== "transcript" || !technique.detect) continue;
    const count = technique.detect(session, metrics);
    if (count > 0) out[technique.id] = count;
  }
  return out;
}
