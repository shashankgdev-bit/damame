import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Judge backends. Default is Claude Code headless (`claude -p`) — it uses the
 * user's existing auth/subscription, so damame's audience needs zero setup.
 * `--no-session-persistence` keeps audit runs out of the user's transcript
 * history (damame must never pollute the data it analyzes), and the process
 * runs from an empty temp cwd so no project context leaks into the judgment.
 */
export interface JudgeDriver {
  readonly name: string;
  readonly model: string;
  run(prompt: string): Promise<string>;
  withModel(model: string): JudgeDriver;
}

export class ClaudeCliDriver implements JudgeDriver {
  readonly name = "claude-cli";
  constructor(
    readonly model: string,
    private readonly cwd = mkdtempSync(join(tmpdir(), "damame-audit-")),
  ) {}

  withModel(model: string): JudgeDriver {
    return new ClaudeCliDriver(model, this.cwd);
  }

  static async available(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn("claude", ["--version"], { stdio: "ignore" });
      child.on("error", () => resolve(false));
      child.on("exit", (code) => resolve(code === 0));
    });
  }

  run(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        "claude",
        ["-p", "--output-format", "json", "--model", this.model, "--no-session-persistence"],
        { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"] },
      );
      let out = "";
      let err = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("claude -p timed out after 180s"));
      }, 180_000);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(new Error(`could not run claude CLI: ${e.message}`));
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`claude -p exited ${code}: ${err.slice(0, 300)}`));
          return;
        }
        try {
          // headless JSON wrapper: {result: "<assistant text>", ...}
          const wrapper = JSON.parse(out);
          resolve(typeof wrapper.result === "string" ? wrapper.result : out);
        } catch {
          resolve(out);
        }
      });
      child.stdin.write(prompt);
      child.stdin.end();
    });
  }
}

const API_MODEL_IDS: Record<string, string> = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-5",
  opus: "claude-opus-5",
};

export class ApiDriver implements JudgeDriver {
  readonly name = "api";
  constructor(
    readonly model: string,
    private readonly apiKey = process.env.ANTHROPIC_API_KEY ?? "",
  ) {
    if (!this.apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  }

  withModel(model: string): JudgeDriver {
    return new ApiDriver(model, this.apiKey);
  }

  async run(prompt: string): Promise<string> {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: API_MODEL_IDS[this.model] ?? this.model,
        max_tokens: 1024,
        temperature: 0,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!response.ok) throw new Error(`api ${response.status}: ${(await response.text()).slice(0, 300)}`);
    const body = (await response.json()) as { content: Array<{ type: string; text?: string }> };
    return body.content.find((c) => c.type === "text")?.text ?? "";
  }
}

/** Deterministic scripted driver for tests — CI never touches a live model. */
export class MockDriver implements JudgeDriver {
  readonly name = "mock";
  readonly calls: string[] = [];
  constructor(
    readonly model: string,
    private readonly respond: (prompt: string, call: number) => string,
  ) {}

  withModel(model: string): JudgeDriver {
    const parent = this;
    const child = new MockDriver(model, (p, c) => parent.respond(p, c));
    return child;
  }

  async run(prompt: string): Promise<string> {
    this.calls.push(prompt);
    return this.respond(prompt, this.calls.length - 1);
  }
}
