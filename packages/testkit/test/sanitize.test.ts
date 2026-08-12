import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixture } from "../src/index.js";
import { sanitizeTranscript } from "../src/sanitize.js";
import { parseTranscriptFile } from "@damame/adapter-claude-code";
import { computeMetrics } from "@damame/metrics";

const SECRETS = [
  "SuperSecretToken123",
  "rm -rf /home/user/production",
  "const apiKey = 'sk-live-999'",
  "shashank@example-corp.com",
];

function sensitiveTranscript(): string {
  return fixture()
    .human(`please run this: ${SECRETS[1]} and use ${SECRETS[0]}`)
    .assistantText(`I'll use the key ${SECRETS[2]} for ${SECRETS[3]}`)
    .tool("Bash", { command: SECRETS[1] }, { content: `output containing ${SECRETS[0]}` })
    .tool(
      "Edit",
      { file_path: "/home/user/project/secret.ts", old_string: SECRETS[2], new_string: "const apiKey = process.env.KEY" },
      { content: "ok", toolUseResult: { filePath: "/home/user/project/secret.ts", oldString: SECRETS[2], structuredPatch: [{ lines: [`-${SECRETS[2]}`] }] } },
    )
    .editFail("/home/user/project/secret.ts")
    .editFail("/home/user/project/secret.ts")
    .editFail("/home/user/project/secret.ts")
    .build();
}

async function parseText(jsonl: string) {
  const dir = mkdtempSync(join(tmpdir(), "damame-sanitize-"));
  const path = join(dir, "t.jsonl");
  writeFileSync(path, jsonl);
  return (await parseTranscriptFile(path)).session;
}

describe("sanitizeTranscript", () => {
  it("no sensitive content survives — commands, edit strings, patches, output, prompts, emails, paths", () => {
    const { output } = sanitizeTranscript(sensitiveTranscript());
    for (const secret of SECRETS) expect(output).not.toContain(secret);
    expect(output).not.toContain("secret.ts");
    expect(output).not.toContain("/home/user");
    // fragments too, not just whole strings
    expect(output).not.toContain("rm -rf");
    expect(output).not.toContain("sk-live");
  });

  it("keeps what detectors need: tool names, error strings, structure", () => {
    const { output, audit } = sanitizeTranscript(sensitiveTranscript());
    expect(output).toContain('"Bash"');
    expect(output).toContain('"Edit"');
    expect(output).toContain("Error: String to replace not found in file.");
    expect(audit).toContain("name=Bash");
  });

  it("analysis is invariant under sanitization: same usage totals, same rule-relevant metrics", async () => {
    const raw = sensitiveTranscript();
    const { output: scrubbed } = sanitizeTranscript(raw);
    const [a, b] = [await parseText(raw), await parseText(scrubbed)];

    expect(b.usage_totals).toEqual(a.usage_totals);
    expect(b.events.map((e) => e.kind)).toEqual(a.events.map((e) => e.kind));
    expect(b.turns.length).toBe(a.turns.length);

    const [ma, mb] = [computeMetrics(a), computeMetrics(b)];
    expect(mb.totals.tool_call_count).toBe(ma.totals.tool_call_count);
    expect(mb.error_runs.map((r) => [r.signature, r.length])).toEqual(
      ma.error_runs.map((r) => [r.signature, r.length]),
    );
    // identical inputs scrub identically → duplicate structure preserved
    expect(mb.duplicate_tool_calls.length).toBe(ma.duplicate_tool_calls.length);
  });

  it("is deterministic: same input → byte-identical output", () => {
    const raw = sensitiveTranscript();
    expect(sanitizeTranscript(raw).output).toBe(sanitizeTranscript(raw).output);
  });

  it("object KEYS leak nothing: path keys, question-text keys", () => {
    const line = JSON.stringify({
      type: "file-history-snapshot",
      snapshot: {
        trackedFileBackups: {
          "/Users/someone/company/secret-plan.md": { backupTime: "2026-01-01T00:00:00Z" },
        },
      },
      toolUseResult: {
        answers: { "How should we protect the admin page for AcmeCorp?": "with auth" },
      },
    });
    const { output } = sanitizeTranscript(line + "\n");
    expect(output).not.toContain("secret-plan");
    expect(output).not.toContain("/Users/someone");
    expect(output).not.toContain("AcmeCorp");
    expect(output).not.toContain("admin page");
  });

  it("error strings keep only the canonical prefix — stack traces are scrubbed", () => {
    const line = JSON.stringify({
      type: "user",
      uuid: "u1",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "Error: Exit code 1\nat /Users/someone/company/app.ts:12 SECRET_ENV=abc", is_error: true }] },
      toolUseResult: "Error: Exit code 1\nat /Users/someone/company/app.ts:12 SECRET_ENV=abc",
    });
    const { output } = sanitizeTranscript(line + "\n");
    expect(output).toContain("Error: Exit code 1");
    expect(output).not.toContain("SECRET_ENV");
    expect(output).not.toContain("/Users/someone");
  });

  it("content QUOTING an error sentence is not kept (anchoring)", () => {
    const line = JSON.stringify({
      type: "user",
      uuid: "u1",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "report about AcmeCorp: the string \"The user doesn't want to proceed with this tool use.\" appears in transcripts" }] },
      toolUseResult: { ok: true },
    });
    const { output } = sanitizeTranscript(line + "\n");
    expect(output).not.toContain("AcmeCorp");
    expect(output).not.toContain("appears in transcripts");
  });

  it("unknown future fields leak nothing (allowlist posture)", () => {
    const line = JSON.stringify({
      type: "future-type",
      uuid: "u1",
      brand_new_field: "proprietary code: const k = 'sk-live-42'",
      nested: { another_new_one: "internal-hostname.corp.example.com" },
    });
    const { output } = sanitizeTranscript(line + "\n");
    expect(output).not.toContain("sk-live-42");
    expect(output).not.toContain("internal-hostname");
    expect(output).toContain('"future-type"');
  });
});
