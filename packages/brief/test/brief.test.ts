import { describe, expect, it } from "vitest";
import { fixture } from "@damame/testkit";
import { parseTranscriptFile } from "@damame/adapter-claude-code";
import { computeMetrics } from "@damame/metrics";
import { MockDriver } from "@damame/judge";
import { buildDigest, renderDigest } from "../src/digest.js";
import {
  applyFaithfulnessGate,
  BriefSchema,
  generateBrief,
  parseBriefJson,
} from "../src/generate.js";

async function digestFor() {
  const b = fixture().human("build me a calculator app");
  const { id } = b.toolCall("Write", { file_path: "/app/calc.html", content: "<html>" });
  b.toolResult(id);
  const { id: id2 } = b.toolCall("Bash", { command: "open calc.html" });
  b.toolResult(id2, { content: "Error: not found", isError: true });
  b.human("fix the error please");
  b.assistantText("done");
  const path = b.writeTemp();
  const { session } = await parseTranscriptFile(path);
  const metrics = computeMetrics(session);
  return buildDigest(session, metrics);
}

describe("digest builder", () => {
  it("produces uniquely-id'd items covering prompts, stats, and files", async () => {
    const digest = await digestFor();
    const ids = digest.items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    const prompts = digest.items.filter((i) => i.kind === "prompt");
    expect(prompts.length).toBe(2);
    expect(prompts[0]!.text).toContain("calculator");
    const stats = digest.items.filter((i) => i.kind === "stat");
    expect(stats.some((s) => s.text.startsWith("totals:"))).toBe(true);
    expect(stats.some((s) => s.text.startsWith("tool usage:"))).toBe(true);
    const files = digest.items.filter((i) => i.kind === "file");
    expect(files.some((f) => f.text.includes("calc.html"))).toBe(true);
    expect(renderDigest(digest)).toContain("[p1] prompt:");
  });
});

function validBriefJson(refs: string[]): string {
  return JSON.stringify({
    what_this_was: [{ text: "A small calculator app build.", refs: [refs[0]] }],
    story: [
      { one_liner: "You asked for a calculator — Claude wrote it.", detail: "One file written.", capability: "agentic-loop", refs: [refs[0]] },
      { one_liner: "A command failed — Claude read the error and fixed it.", detail: "One Bash error, then done.", capability: "agentic-loop", refs: [refs[1] ?? refs[0]] },
    ],
    working_pattern: [{ text: "User prompted twice; Claude wrote and ran code.", refs }],
    how_claude_worked: [{ text: "Wrote a file, hit a Bash error, then fixed it.", refs: [refs[1] ?? refs[0]] }],
    use_case_tags: ["web-app-development"],
  });
}

describe("brief generation", () => {
  it("returns a gated brief with zero drops when refs are real", async () => {
    const digest = await digestFor();
    const ids = digest.items.map((i) => i.id);
    const driver = new MockDriver("mock-model", () => validBriefJson([ids[0]!, ids[1]!]));
    const out = await generateBrief(digest, driver);
    expect(out.dropped_claims).toBe(0);
    expect(out.degraded).toBe(false);
    expect(out.prompt_version).toBe("brief@5");
    expect(out.model).toBe("mock-model");
    expect(out.brief.use_case_tags).toEqual(["web-app-development"]);
    expect(driver.calls[0]).toContain("DIGEST:");
  });

  it("retries once on invalid JSON, then succeeds", async () => {
    const digest = await digestFor();
    const ids = digest.items.map((i) => i.id);
    const driver = new MockDriver("m", (_p, call) => (call === 0 ? "not json at all" : validBriefJson([ids[0]!])));
    const out = await generateBrief(digest, driver);
    expect(driver.calls.length).toBe(2);
    expect(out.brief.what_this_was.length).toBe(1);
  });

  it("throws after two invalid responses", async () => {
    const digest = await digestFor();
    const driver = new MockDriver("m", () => "still not json");
    await expect(generateBrief(digest, driver)).rejects.toThrow(/failed after retry/);
  });

  it("faithfulness gate drops claims whose every ref is fabricated and flags degradation", async () => {
    const digest = await digestFor();
    const real = digest.items[0]!.id;
    const brief = BriefSchema.parse({
      what_this_was: [{ text: "made up entirely", refs: ["z99"] }],
      story: [
        { one_liner: "fabricated beat", detail: "d", capability: "none", refs: ["z97"] },
        { one_liner: "real beat", detail: "d", capability: "subagents", refs: [real] },
      ],
      working_pattern: [{ text: "half real", refs: ["z98", real] }],
      how_claude_worked: [{ text: "real", refs: [real] }],
      use_case_tags: ["x"],
    });
    const { brief: gated, dropped } = applyFaithfulnessGate(brief, digest);
    expect(dropped).toBe(2); // the headline claim and the fabricated beat
    expect(gated.what_this_was).toHaveLength(0);
    expect(gated.story).toHaveLength(1);
    expect(gated.story[0]!.one_liner).toBe("real beat");
    expect(gated.working_pattern[0]!.refs).toEqual([real]);

    const driver = new MockDriver("m", () =>
      JSON.stringify({
        what_this_was: [{ text: "fabricated", refs: ["nope"] }],
        story: [{ one_liner: "real", detail: "d", capability: "none", refs: [real] }, { one_liner: "real2", detail: "d", capability: "none", refs: [real] }],
        working_pattern: [{ text: "real", refs: [real] }],
        how_claude_worked: [{ text: "real", refs: [real] }],
        use_case_tags: ["x"],
      }),
    );
    const out = await generateBrief(digest, driver);
    expect(out.dropped_claims).toBe(1);
    expect(out.degraded).toBe(true); // a section was emptied
  });

  it("parseBriefJson strips markdown fences", () => {
    const parsed = parseBriefJson('```json\n{"a": 1}\n```') as { a: number };
    expect(parsed.a).toBe(1);
  });
});
