import { describe, expect, it } from "vitest";
import { fixture } from "@damame/testkit";
import { parseTranscriptFile } from "@damame/adapter-claude-code";
import { computeMetrics } from "@damame/metrics";
import type { Finding } from "@damame/ir";
import { normalizeCommand, postEditRitual } from "../src/detectors/post-edit-ritual.js";

async function run(path: string): Promise<Finding[]> {
  const { session } = await parseTranscriptFile(path);
  const metrics = computeMetrics(session);
  return postEditRitual.detect({ session, metrics, env: session.environment, config: { ...postEditRitual.defaults } });
}

/** n edit→check pairs of the same ritual, varying paths/digits per pair. */
function ritualSession(n: number, command: (i: number) => string): string {
  const b = fixture().human("build the tasks");
  for (let i = 0; i < n; i++) {
    const { id } = b.toolCall("Edit", { file_path: `/proj/day${i}/test.py`, old_string: "a", new_string: "b" });
    b.toolResult(id);
    const { id: id2 } = b.toolCall("Bash", { command: command(i) });
    b.toolResult(id2);
  }
  b.assistantText("done");
  return b.writeTemp();
}

describe("post-edit-ritual", () => {
  it("normalizes location/digit noise into one family", () => {
    expect(normalizeCommand("cd /proj/day101/scan-bus && python3 - <<'PY'")).toBe(normalizeCommand("cd /proj/day7/arc-blink && python3 - <<'PY'"));
    expect(normalizeCommand("npm test")).not.toBe(normalizeCommand("npm run build"));
  });

  it("fires when the same check follows edits 10+ times across different folders", async () => {
    const findings = await run(ritualSession(12, (i) => `cd /proj/day${i} && python3 - <<'PY'\nprint(1)\nPY`));
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.rule.id).toBe("post-edit-ritual");
    expect(f.severity).toBe("minor");
    expect(f.savings).toBeUndefined();
    expect(f.evidence.metrics?.occurrences).toBe(12);
    expect(f.recommendation.resource.ref).toBe("hooks-post-edit");
    expect(f.evidence.events.length).toBeLessThanOrEqual(8);
  });

  it("does NOT fire at 9 occurrences (just under threshold)", async () => {
    const findings = await run(ritualSession(9, (i) => `cd /proj/day${i} && python3 - <<'PY'\nprint(1)\nPY`));
    expect(findings).toHaveLength(0);
  });

  it("does NOT fire on varied post-edit commands (no single family accumulates)", async () => {
    const cmds = ["npm test", "ls -la", "git status", "python3 x.py", "make build", "cat out.txt", "grep foo bar", "node app.js", "rm tmp", "echo hi", "wc -l f", "date"];
    const findings = await run(ritualSession(12, (i) => cmds[i % cmds.length]! + ` # run ${i}`));
    expect(findings).toHaveLength(0);
  });

  it("counts only the FIRST Bash after each edit", async () => {
    const b = fixture().human("work");
    for (let i = 0; i < 12; i++) {
      const { id } = b.toolCall("Edit", { file_path: "/proj/a.ts", old_string: "x", new_string: "y" });
      b.toolResult(id);
      const varied = ["ls -la", "git status", "cat notes.md", "pwd", "date", "whoami", "df -h", "uptime", "hostname", "uname -a", "env", "true"];
      const { id: first } = b.toolCall("Bash", { command: varied[i]! }); // genuinely varied first command
      b.toolResult(first);
      const { id: second } = b.toolCall("Bash", { command: "npm test" }); // same second command — must NOT count
      b.toolResult(second);
    }
    b.assistantText("done");
    const findings = await run(b.writeTemp());
    expect(findings).toHaveLength(0);
  });
});
