import { describe, expect, it } from "vitest";
import { fixture } from "@damame/testkit";
import { parseTranscriptFile } from "@damame/adapter-claude-code";
import { computeMetrics } from "@damame/metrics";
import { abandonedWork } from "../src/detectors/abandoned-work.js";
import type { Finding, Session } from "@damame/ir";

async function run(path: string): Promise<{ session: Session; findings: Finding[] }> {
  const { session } = await parseTranscriptFile(path);
  const metrics = computeMetrics(session);
  const findings = abandonedWork.detect({
    session,
    metrics,
    env: session.environment,
    config: { ...abandonedWork.defaults },
  });
  return { session, findings };
}

/**
 * Builds a session where a branch is abandoned via rewind: spend happens after
 * `forkPoint`, then the parent pointer rewinds there and a new live branch
 * continues (lastPrompt's leafUuid marks it live). Non-zero cacheRead on the
 * spend proves cache reads are excluded from the measured savings.
 */
function rewindFixture(perMessage: { input: number; output: number; cacheCreate: number }, messages = 3): string {
  const b = fixture();
  b.human("implement the caching layer");
  b.assistantText("looking at the code", { usage: { input: 20, output: 40, cacheRead: 0, cacheCreate: 0 } });
  const forkPoint = b.currentUuid()!;
  for (let i = 0; i < messages; i++) {
    b.assistantText(`working on approach A, step ${i}`, { usage: { ...perMessage, cacheRead: 5_000 } });
  }
  b.rewindTo(forkPoint);
  b.human("actually, different approach");
  b.assistantText("ok", { usage: { input: 20, output: 40, cacheRead: 0, cacheCreate: 0 } });
  b.lastPrompt();
  return b.writeTemp();
}

describe("abandoned-work", () => {
  it("fires on a rewound branch with >= 200k tokens of recorded usage", async () => {
    // 3 × (40k + 25k + 5k) = 210k on the abandoned branch (cache reads excluded).
    const path = rewindFixture({ input: 40_000, output: 25_000, cacheCreate: 5_000 });
    const { session, findings } = await run(path);

    // The adapter itself must have resolved the fork — the rule adds no inference.
    const branches = session.metadata?.abandoned_branches as Array<{ usage_tokens: number }>;
    expect(branches.length).toBeGreaterThan(0);

    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.rule.id).toBe("abandoned-work");
    expect(f.confidence.source).toBe("deterministic");
    expect(f.severity).toBe("moderate");
    expect(f.evidence.events.length).toBeGreaterThanOrEqual(1);
    // Evidence is the branch root, an event the adapter marked abandoned.
    const root = session.events.find((e) => e.event_id === f.evidence.events[0]!.event_id);
    expect(root?.on_abandoned_branch).toBe(true);
    expect(f.savings?.basis).toBe("measured");
    // Exactly the recorded input+output+cache-write spend; the 5k cacheRead per message is excluded.
    expect(f.savings?.tokens?.value).toBe(210_000);
    expect(f.dedupe_key).toHaveLength(16);
  });

  it("escalates to major at >= 1M abandoned tokens", async () => {
    // 3 × (250k + 80k + 20k) = 1,050k.
    const path = rewindFixture({ input: 250_000, output: 80_000, cacheCreate: 20_000 });
    const { findings } = await run(path);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("major");
    expect(findings[0]!.savings?.tokens?.value).toBe(1_050_000);
  });

  it("does NOT fire just under the threshold (abandoned branch exists but spend is 198k)", async () => {
    // 3 × (40k + 20k + 6k) = 198k < 200k.
    const path = rewindFixture({ input: 40_000, output: 20_000, cacheCreate: 6_000 });
    const { session, findings } = await run(path);
    // The branch is real — only the threshold keeps this quiet.
    const branches = session.metadata?.abandoned_branches as Array<{ usage_tokens: number }>;
    expect(branches.length).toBeGreaterThan(0);
    expect(findings).toHaveLength(0);
  });

  it("does NOT fire on a sequential direction change without a rewind (look-alike)", async () => {
    // Same spend and the same "actually, different approach" — but no fork:
    // the earlier work stays on the live path, so nothing was discarded.
    const b = fixture();
    b.human("implement the caching layer");
    for (let i = 0; i < 3; i++) {
      b.assistantText(`working on approach A, step ${i}`, {
        usage: { input: 40_000, output: 25_000, cacheRead: 5_000, cacheCreate: 5_000 },
      });
    }
    b.human("actually, different approach");
    b.assistantText("ok", { usage: { input: 20, output: 40, cacheRead: 0, cacheCreate: 0 } });
    b.lastPrompt();
    const { session, findings } = await run(b.writeTemp());
    const branches = session.metadata?.abandoned_branches as unknown[];
    expect(branches).toHaveLength(0);
    expect(findings).toHaveLength(0);
  });

  it("is idempotent: same session → same dedupe keys", async () => {
    const path = rewindFixture({ input: 40_000, output: 25_000, cacheCreate: 5_000 });
    const [a, b] = [await run(path), await run(path)];
    expect(a.findings.map((f) => f.dedupe_key)).toEqual(b.findings.map((f) => f.dedupe_key));
  });
});

describe("abandoned-work v0.2.0 resume-fork attribution", () => {
  it("files a resume-orphaned branch as info/infra with no savings claim", async () => {
    const b = fixture();
    b.human("start the work");
    // Dead tail written by sitting A: heavy assistant usage under the fork parent.
    const forkParent = "fork-parent-0001";
    b.push({
      uuid: forkParent, parentUuid: null, sessionId: b.sessionId,
      timestamp: "2026-07-01T10:00:00.000Z", type: "user", userType: "external",
      cwd: "/proj", isSidechain: false, version: "2.1.200", entrypoint: "cli", gitBranch: "main",
      message: { role: "user", content: [{ type: "text", text: "continue the plan" }] },
    });
    b.push({
      uuid: "dead-child-0001", parentUuid: forkParent, sessionId: b.sessionId,
      timestamp: "2026-07-01T10:01:00.000Z", type: "assistant", userType: "external",
      cwd: "/proj", isSidechain: false, version: "2.1.200", entrypoint: "cli", gitBranch: "main",
      requestId: "req_dead1",
      message: { id: "msg_dead1", role: "assistant", model: "claude-opus-4-8",
        content: [{ type: "text", text: "overnight work happening" }],
        usage: { input_tokens: 150_000, output_tokens: 160_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    });
    // Live continuation written by a DIFFERENT sitting (new sessionId) → resume fork.
    b.push({
      uuid: "live-child-0001", parentUuid: forkParent, sessionId: "99999999-0000-4000-8000-000000000099",
      timestamp: "2026-07-02T09:00:00.000Z", type: "user", userType: "external",
      cwd: "/proj", isSidechain: false, version: "2.1.200", entrypoint: "cli", gitBranch: "main",
      message: { role: "user", content: [{ type: "text", text: "pick up where we left off" }] },
    });
    b.push({
      type: "last-prompt", lastPrompt: "pick up", leafUuid: "live-child-0001", sessionId: b.sessionId,
    });
    const path = b.writeTemp();
    const { session } = await parseTranscriptFile(path);
    const metrics = computeMetrics(session);
    const branch = metrics.abandoned_branches.find((x) => x.usage_tokens >= 300_000);
    expect(branch?.fork_kind).toBe("resume");
    const findings = abandonedWork.detect({ session, metrics, env: session.environment, config: { ...abandonedWork.defaults } });
    const f = findings.find((x) => x.evidence.metrics?.fork_kind === "resume");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("info");
    expect(f!.category).toBe("infra");
    expect(f!.savings).toBeUndefined();
    expect(f!.title).toContain("orphaned by a session resume");
  });
});
