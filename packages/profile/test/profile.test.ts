import { mkdtempSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixture } from "@damame/testkit";
import { parseTranscriptFile } from "@damame/adapter-claude-code";
import { computeMetrics } from "@damame/metrics";
import { runRules } from "@damame/rules";
import {
  buildProfile,
  detectTechniques,
  sessionSkills,
  summarizeSession,
  summarizeWithCache,
  type SessionSummary,
} from "../src/index.js";

const NOW = Date.parse("2026-08-10T00:00:00Z"); // fixtures start 2026-08-01

async function pipeline(path: string) {
  const { session } = await parseTranscriptFile(path);
  const metrics = computeMetrics(session);
  const findings = runRules(session, metrics);
  return { session, metrics, findings };
}

const NO_ENV = { techniques: {} };

describe("technique detection", () => {
  it("detects transcript techniques from real fixture parsing", async () => {
    const b = fixture().human("do the work", { permissionMode: "plan" });
    b.tool("TodoWrite", { todos: [] }, { content: "ok" });
    b.tool("Grep", { pattern: "foo" }, { content: "match" });
    b.readOk("/home/user/project/a.ts", 500, { offset: 10, limit: 50 });
    b.tool("WebSearch", { query: "docs" }, { content: "results" });
    b.tool("mcp__drive__search", { q: "x" }, { content: "found" });
    b.tool("Bash", { command: "npm test" }, { content: "1 passed" });
    b.tool("Bash", { command: "sleep 100", run_in_background: true }, { content: "started" });
    const { session, metrics } = await pipeline(b.writeTemp());
    const t = detectTechniques(session, metrics);
    expect(t["plan-mode-first"]).toBe(1);
    expect(t["todo-tracking"]).toBe(1);
    expect(t["search-before-read"]).toBe(1);
    expect(t["targeted-reads"]).toBe(1);
    expect(t["web-research"]).toBe(1);
    expect(t["mcp-tools"]).toBe(1);
    expect(t["verify-with-tests"]).toBe(1);
    expect(t["background-tasks"]).toBe(1);
  });

  it("does NOT credit techniques that were not used", async () => {
    const { session, metrics } = await pipeline(fixture().human("hi").assistantText("hello").writeTemp());
    const t = detectTechniques(session, metrics);
    expect(t["plan-mode-first"]).toBeUndefined();
    expect(t["subagent-delegation"]).toBeUndefined();
    expect(t["verify-with-tests"]).toBeUndefined();
  });
});

describe("opportunity model (the core mechanic)", () => {
  it("a clean session yields zero misses everywhere — never penalized without opportunity", async () => {
    const { session, metrics, findings } = await pipeline(
      fixture().human("small fix").assistantText("done").editOk("/a.ts").writeTemp(),
    );
    const summary = summarizeSession(session, metrics, findings);
    for (const tally of Object.values(summary.skills)) {
      expect(tally.misses).toBe(0);
    }
  });

  it("an error loop becomes a recovery-verification miss with measured waste and evidence keys", async () => {
    const { session, metrics, findings } = await pipeline(
      fixture().human("fix").editFail("/x.ts").editFail("/x.ts").editFail("/x.ts").writeTemp(),
    );
    const summary = summarizeSession(session, metrics, findings);
    const recovery = summary.skills["recovery-verification"];
    expect(recovery.misses).toBe(1);
    expect(recovery.miss_keys).toHaveLength(1);
    expect(recovery.missed_tokens).toBeGreaterThan(0);
    // and no cross-contamination into unrelated skills
    expect(summary.skills["agent-orchestration"].misses).toBe(0);
  });
});

function fakeSummary(overrides: Partial<SessionSummary> & { id: string; date: string }): SessionSummary {
  const base = summaryTemplate(overrides.id, overrides.date);
  return { ...base, ...overrides };
}

function summaryTemplate(id: string, date: string): SessionSummary {
  const skills = Object.fromEntries(
    [
      "prompt-engineering",
      "planning-decomposition",
      "agent-orchestration",
      "context-engineering",
      "tooling-fluency",
      "workflow-automation",
      "recovery-verification",
    ].map((s) => [s, { uses: 0, misses: 0, miss_keys: [] as string[], missed_tokens: 0, missed_wall_ms: 0 }]),
  ) as unknown as SessionSummary["skills"];
  return {
    schema: 3,
    session_id: id,
    path: `/tmp/${id}.jsonl`,
    started_at: date,
    ended_at: date,
    total_tokens: 1000,
    human_turns: 5,
    tool_calls: 10,
    skills,
    techniques: {},
    rule_counts: {},
    tools_used: [],
    skills_available: 0,
    skills_invoked: 0,
    api_error_bursts: 0,
  };
}

describe("buildProfile states", () => {
  it("no opportunities → not_needed (neutral), NEVER opportunities_missed", () => {
    const profile = buildProfile([fakeSummary({ id: "a", date: "2026-08-05T00:00:00Z" })], NO_ENV, NOW);
    const orchestration = profile.skills.find((s) => s.id === "agent-orchestration")!;
    expect(orchestration.state).toBe("not_needed");
    expect(orchestration.rate).toBeNull();
    expect(profile.recommendations).toHaveLength(0);
  });

  it("mostly-taken opportunities → practiced_well; mostly-missed → opportunities_missed", () => {
    const good = fakeSummary({ id: "a", date: "2026-08-05T00:00:00Z" });
    good.skills["agent-orchestration"] = { uses: 5, misses: 1, miss_keys: ["k1"], missed_tokens: 100, missed_wall_ms: 0 };
    const bad = fakeSummary({ id: "b", date: "2026-08-06T00:00:00Z" });
    bad.skills["context-engineering"] = { uses: 0, misses: 4, miss_keys: ["k2", "k3", "k4", "k5"], missed_tokens: 2_000_000, missed_wall_ms: 0 };

    const profile = buildProfile([good, bad], NO_ENV, NOW);
    expect(profile.skills.find((s) => s.id === "agent-orchestration")!.state).toBe("practiced_well");
    const context = profile.skills.find((s) => s.id === "context-engineering")!;
    expect(context.state).toBe("opportunities_missed");
    expect(context.rate).toBe(0);
    // recommendation generated, ranked by measured waste, with evidence keys
    expect(profile.recommendations[0]!.skill).toBe("context-engineering");
    expect(profile.recommendations[0]!.miss_keys).toContain("k2");
  });

  it("single opportunity → getting_started (too little data to judge)", () => {
    const s = fakeSummary({ id: "a", date: "2026-08-05T00:00:00Z" });
    s.skills["planning-decomposition"] = { uses: 0, misses: 1, miss_keys: ["k"], missed_tokens: 500_000, missed_wall_ms: 0 };
    const profile = buildProfile([s], NO_ENV, NOW);
    expect(profile.skills.find((p) => p.id === "planning-decomposition")!.state).toBe("getting_started");
  });

  it("environment techniques credit workflow-automation", () => {
    const s = fakeSummary({ id: "a", date: "2026-08-05T00:00:00Z" });
    const withEnv = buildProfile([s], { techniques: { hooks: true, "claude-md": true } }, NOW);
    const automation = withEnv.skills.find((p) => p.id === "workflow-automation")!;
    expect(automation.uses).toBeGreaterThan(0);
    expect(automation.techniques.find((t) => t.id === "hooks")!.tried).toBe(true);
  });

  it("sparse mode flags fewer than 5 recent sessions; determinism holds", () => {
    const s = fakeSummary({ id: "a", date: "2026-08-05T00:00:00Z" });
    const p1 = buildProfile([s], NO_ENV, NOW);
    const p2 = buildProfile([s], NO_ENV, NOW);
    expect(p1.sparse).toBe(true);
    expect(JSON.stringify(p1)).toBe(JSON.stringify(p2));
  });

  it("sessions outside the 28-day window do not affect current states", () => {
    const old = fakeSummary({ id: "old", date: "2026-05-01T00:00:00Z" });
    old.skills["context-engineering"] = { uses: 0, misses: 9, miss_keys: ["x"], missed_tokens: 9e6, missed_wall_ms: 0 };
    const profile = buildProfile([old], NO_ENV, NOW);
    expect(profile.skills.find((s) => s.id === "context-engineering")!.state).toBe("not_needed");
  });
});

describe("sessionSkills (per-session lens)", () => {
  it("clean session: every skill is used or not_needed — no missed verdicts", async () => {
    const { session, metrics, findings } = await pipeline(
      fixture().human("hi").assistantText("hello").writeTemp(),
    );
    const entries = sessionSkills(session, metrics, findings);
    expect(entries.every((e) => e.verdict === "used" || e.verdict === "not_needed")).toBe(true);
  });

  it("error-loop session: recovery gets a 'could have been better' sentence with finding links", async () => {
    const { session, metrics, findings } = await pipeline(
      fixture().human("fix").editFail("/x.ts").editFail("/x.ts").editFail("/x.ts").writeTemp(),
    );
    const entries = sessionSkills(session, metrics, findings);
    const recovery = entries.find((e) => e.skill === "recovery-verification")!;
    expect(recovery.verdict).toBe("missed");
    expect(recovery.sentence).toContain("could have been better");
    expect(recovery.miss_keys).toHaveLength(1);
    // actionable entries sort first
    expect(entries[0]!.verdict).toBe("missed");
  });
});

describe("summary cache", () => {
  beforeEach(() => {
    process.env.DAMAME_DATA_DIR = mkdtempSync(join(tmpdir(), "damame-profile-cache-"));
  });
  afterEach(() => {
    delete process.env.DAMAME_DATA_DIR;
  });

  it("caches by mtime+size and invalidates on change", async () => {
    const path = fixture().human("hi").assistantText("hello").writeTemp();
    const first = await summarizeWithCache(path);
    const second = await summarizeWithCache(path);
    expect(second).toEqual(first); // cache hit, identical

    // touch the file → cache must recompute (not crash, not stale-crash)
    utimesSync(path, new Date(), new Date());
    const third = await summarizeWithCache(path);
    expect(third.session_id).toBe(first.session_id);
  });
});
