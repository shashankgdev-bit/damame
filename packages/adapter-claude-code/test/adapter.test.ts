import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixture } from "@damame/testkit";
import { parseTranscriptFile } from "../src/index.js";
import type {
  AssistantMessageEvent,
  PermissionDenialEvent,
  ToolCallEvent,
  ToolResultEvent,
  Usage,
  UserMessageEvent,
} from "@damame/ir";
import { addUsage, emptyAggregatedUsage } from "@damame/ir";

/** Write raw JSONL content to a fresh temp file (for hand-mangled fixtures). */
function writeRaw(content: string, name = "fixture.jsonl"): string {
  const dir = mkdtempSync(join(tmpdir(), "damame-adapter-test-"));
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

interface AbandonedBranchSummary {
  fork_parent_uuid: string;
  root_event_id?: string;
  event_count: number;
  usage_tokens: number;
}

describe("adapter-claude-code parse", () => {
  it("dedupes usage across the multiple transcript lines of one API response", async () => {
    // One API response streamed as 3 lines (text + thinking + tool_use) that
    // share message.id and each repeat the identical usage object.
    const path = fixture()
      .human("do the thing")
      .assistant(
        [
          { type: "text", text: "on it" },
          { type: "thinking", thinking: "let me think" },
          { type: "tool_use", id: "toolu_dedup_01", name: "Bash", input: { command: "ls" } },
        ],
        { usage: { input: 11, output: 22, cacheRead: 33, cacheCreate: 44 } },
      )
      .writeTemp();

    const { session } = await parseTranscriptFile(path);

    const assistantEvents = session.events.filter(
      (e): e is AssistantMessageEvent => e.kind === "assistant_message",
    );
    expect(assistantEvents).toHaveLength(1);
    expect(assistantEvents[0]!.source_ids?.message_id).toBe("msg_fixture_001");

    // Usage counted exactly once despite 3 lines repeating it.
    expect(session.usage_totals?.input_tokens).toBe(11);
    expect(session.usage_totals?.output_tokens).toBe(22);
    expect(session.usage_totals?.cache_read_input_tokens).toBe(33);
    expect(session.usage_totals?.cache_creation_input_tokens).toBe(44);

    // Naive line counting would over-count: 3 assistant lines, 1 event.
    const naiveAssistantLineCount = readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { type?: string })
      .filter((l) => l.type === "assistant").length;
    expect(naiveAssistantLineCount).toBe(3);
    expect(naiveAssistantLineCount).toBeGreaterThan(assistantEvents.length);
  });

  it("pairs every tool_call bijectively with a tool_result or permission_denial", async () => {
    const path = fixture()
      .human("do several things")
      .bashOk("ls", "files")
      .readOk("/home/user/project/a.ts")
      .editOk("/home/user/project/a.ts")
      .bashFail("false")
      .permissionDenied("Bash", { command: "rm -rf /" })
      .writeTemp();

    const { session } = await parseTranscriptFile(path);

    const calls = session.events.filter((e): e is ToolCallEvent => e.kind === "tool_call");
    expect(calls).toHaveLength(5);
    const callIds = calls.map((c) => c.call_id).filter((id): id is string => id !== undefined);
    expect(callIds).toHaveLength(5);
    expect(new Set(callIds).size).toBe(5);

    const responders = session.events.filter(
      (e): e is ToolResultEvent | PermissionDenialEvent =>
        e.kind === "tool_result" || e.kind === "permission_denial",
    );
    expect(responders.filter((r) => r.kind === "permission_denial")).toHaveLength(1);

    // Bijection: each call_id answered exactly once, no orphan responders.
    const responderIds = responders.map((r) => r.call_id);
    expect(responderIds).toHaveLength(callIds.length);
    for (const id of callIds) {
      expect(responderIds.filter((r) => r === id)).toHaveLength(1);
    }
    // ...and each responder's call_event_id points back at the matching call.
    const callByCallId = new Map(calls.map((c) => [c.call_id, c]));
    for (const responder of responders) {
      expect(responder.call_event_id).toBe(callByCallId.get(responder.call_id)?.event_id);
    }
  });

  it("survives unknown line types and malformed JSON (drift canary)", async () => {
    const content =
      fixture().human("hello").assistantText("hi").build() +
      '{"type":"future-nonsense-type","uuid":"u1","foo":1}\n' +
      "not json{{\n";
    const path = writeRaw(content, "drift.jsonl");

    // Must not throw.
    const { session } = await parseTranscriptFile(path);

    expect(session.unknown_line_types).toEqual({ "future-nonsense-type": 1 });
    expect(session.metadata?.malformed_lines).toBe(1);
    // The recognized lines still parsed normally.
    expect(session.events.some((e) => e.kind === "user_message")).toBe(true);
    expect(session.events.some((e) => e.kind === "assistant_message")).toBe(true);
  });

  it("marks forked-off work as abandoned and keeps its prompts out of turns", async () => {
    const b = fixture();
    b.human("first prompt").assistantText("ok");
    const forkPoint = b.currentUuid()!;
    // Dead branch: a re-prompted-over user message plus assistant work.
    b.human("dead prompt try approach A");
    b.assistantText("dead work", { usage: { input: 40, output: 400, cacheRead: 0, cacheCreate: 0 } });
    // User escaped and re-prompted from the fork point; last-prompt marks the live leaf.
    b.rewindTo(forkPoint);
    b.human("live prompt try approach B");
    b.assistantText("live work");
    b.lastPrompt();

    const { session } = await parseTranscriptFile(b.writeTemp());

    const userEvents = session.events.filter((e): e is UserMessageEvent => e.kind === "user_message");
    const deadPrompt = userEvents.find((e) => e.text.includes("dead prompt"));
    const livePrompt = userEvents.find((e) => e.text.includes("live prompt"));
    const deadWork = session.events.find(
      (e): e is AssistantMessageEvent => e.kind === "assistant_message" && e.text === "dead work",
    );
    expect(deadPrompt?.on_abandoned_branch).toBe(true);
    expect(deadWork?.on_abandoned_branch).toBe(true);
    expect(livePrompt?.on_abandoned_branch).toBeUndefined();

    const branches = session.metadata?.abandoned_branches as AbandonedBranchSummary[];
    expect(branches).toHaveLength(1);
    expect(branches[0]!.event_count).toBe(2);
    expect(branches[0]!.usage_tokens).toBeGreaterThan(0);

    const prompts = session.turns.map((t) => t.prompt_text);
    expect(prompts).toEqual(["first prompt", "live prompt try approach B"]);
  });

  it("starts turns only on human lines, not harness-tagged ones, and rolls up usage", async () => {
    const u1 = { input: 1, output: 2, cacheRead: 3, cacheCreate: 4 };
    const u2 = { input: 10, output: 20, cacheRead: 30, cacheCreate: 40 };
    const path = fixture()
      .meta("<ide_opened_file>the user opened /home/user/project/a.ts</ide_opened_file>")
      .human("<local-command-stdout>some command output</local-command-stdout>")
      .human("real prompt")
      .assistantText("reply 1", { usage: u1 })
      .assistantText("reply 2", { usage: u2 })
      .writeTemp();

    const { session } = await parseTranscriptFile(path);

    // Both harness lines became synthetic user_message events, not turn starts.
    const userEvents = session.events.filter((e): e is UserMessageEvent => e.kind === "user_message");
    expect(userEvents).toHaveLength(3);
    expect(userEvents[0]!.origin).toBe("synthetic");
    expect(userEvents[0]!.is_meta).toBe(true);
    expect(userEvents[1]!.origin).toBe("synthetic");
    expect(userEvents[2]!.origin).toBe("human");

    expect(session.turns).toHaveLength(1);
    const turn = session.turns[0]!;
    expect(turn.origin).toBe("human");
    expect(turn.prompt_text).toBe("real prompt");

    // Turn usage rollup equals the sum of its assistant events' usage.
    const summed = session.events
      .filter(
        (e): e is AssistantMessageEvent => e.kind === "assistant_message" && e.turn_id === turn.id,
      )
      .reduce<Usage>((acc, e) => addUsage(acc, e.usage), emptyAggregatedUsage());
    expect(turn.usage).toEqual(summed);
    expect(turn.usage?.input_tokens).toBe(11);
    expect(turn.usage?.output_tokens).toBe(22);
    expect(turn.usage?.cache_read_input_tokens).toBe(33);
    expect(turn.usage?.cache_creation_input_tokens).toBe(44);
  });

  it("populates the environment snapshot from listing attachments", async () => {
    const path = fixture()
      .skillListing(["commit-helper"], { "commit-helper": "Writes conventional commits" })
      .agentListing(["code-reviewer"], { "code-reviewer": "Reviews diffs for bugs" })
      .human("hello")
      .assistantText("hi")
      .writeTemp();

    const { session } = await parseTranscriptFile(path);

    expect(session.environment?.skills).toEqual([
      { name: "commit-helper", description: "Writes conventional commits", source: "session_listing" },
    ]);
    const agents = session.environment?.agents ?? [];
    expect(agents).toHaveLength(1);
    expect(agents[0]!.type).toBe("code-reviewer");
    expect(agents[0]!.description).toContain("Reviews diffs for bugs");
    expect(agents[0]!.removed).toBe(false);
  });

  it("parses a user interrupt as an interruption event and marks the turn", async () => {
    const path = fixture()
      .human("do something long")
      .assistantText("working on it")
      .interrupt()
      .writeTemp();

    const { session } = await parseTranscriptFile(path);

    const interruptions = session.events.filter((e) => e.kind === "interruption");
    expect(interruptions).toHaveLength(1);
    expect(interruptions[0]!.kind === "interruption" && interruptions[0]!.scope).toBe("request");

    expect(session.turns).toHaveLength(1);
    expect(session.turns[0]!.interrupted).toBe(true);
  });
});
