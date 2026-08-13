export * from "./sanitize.js";

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Builds synthetic Claude Code transcript JSONL for fixtures. Emits the same
 * line shapes the real CLI writes (verified against v2.1.18x–2.2x transcripts)
 * so fixtures exercise the actual adapter path, not a shortcut.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

export interface UsageOpts {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheCreate?: number;
}

export class TranscriptBuilder {
  private lines: Json[] = [];
  private lastUuid: string | null = null;
  private clockMs: number;
  private counter = 0;
  private msgCounter = 0;
  readonly sessionId: string;

  constructor(sessionId = "00000000-0000-4000-8000-000000000001", startIso = "2026-08-01T10:00:00.000Z") {
    this.sessionId = sessionId;
    this.clockMs = Date.parse(startIso);
  }

  /** Advance the fixture clock. */
  tick(ms: number): this {
    this.clockMs += ms;
    return this;
  }

  private uuid(): string {
    this.counter += 1;
    return `fixture-uuid-${String(this.counter).padStart(4, "0")}`;
  }

  private ts(): string {
    this.clockMs += 250;
    return new Date(this.clockMs).toISOString();
  }

  private envelope(overrides: Json = {}): Json {
    const uuid = overrides.uuid ?? this.uuid();
    const line: Json = {
      uuid,
      parentUuid: overrides.parentUuid !== undefined ? overrides.parentUuid : this.lastUuid,
      sessionId: this.sessionId,
      timestamp: this.ts(),
      cwd: "/home/user/project",
      gitBranch: "main",
      version: "2.1.200",
      userType: "external",
      entrypoint: "cli",
      isSidechain: false,
      slug: "fixture-session",
      ...overrides,
    };
    this.lastUuid = uuid;
    return line;
  }

  push(line: Json): this {
    this.lines.push(line);
    return this;
  }

  human(text: string, opts: { permissionMode?: string } = {}): this {
    return this.push(
      this.envelope({
        type: "user",
        message: { role: "user", content: [{ type: "text", text }] },
        origin: { kind: "human" },
        ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
      }),
    );
  }

  meta(text: string): this {
    return this.push(
      this.envelope({
        type: "user",
        isMeta: true,
        message: { role: "user", content: [{ type: "text", text }] },
      }),
    );
  }

  interrupt(scope: "request" | "tool_use" = "request"): this {
    const text = scope === "tool_use" ? "[Request interrupted by user for tool use]" : "[Request interrupted by user]";
    return this.push(
      this.envelope({
        type: "user",
        message: { role: "user", content: [{ type: "text", text }] },
      }),
    );
  }

  private usageObject(u: UsageOpts = {}): Json {
    return {
      input_tokens: u.input ?? 10,
      output_tokens: u.output ?? 100,
      cache_read_input_tokens: u.cacheRead ?? 1000,
      cache_creation_input_tokens: u.cacheCreate ?? 200,
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: u.cacheCreate ?? 200 },
      service_tier: "standard",
    };
  }

  /** One assistant API response with text and/or tool_use blocks (shared message.id). */
  assistant(
    blocks: Array<
      | { type: "text"; text: string }
      | { type: "thinking"; thinking: string }
      | { type: "tool_use"; id: string; name: string; input: Json }
    >,
    opts: { usage?: UsageOpts; model?: string; stopReason?: string; cacheMiss?: { reason: string; tokens: number } } = {},
  ): this {
    this.msgCounter += 1;
    const messageId = `msg_fixture_${String(this.msgCounter).padStart(3, "0")}`;
    const usage = this.usageObject(opts.usage);
    blocks.forEach((block, i) => {
      const isLast = i === blocks.length - 1;
      this.push(
        this.envelope({
          type: "assistant",
          requestId: `req_fixture_${String(this.msgCounter).padStart(3, "0")}`,
          message: {
            id: messageId,
            role: "assistant",
            model: opts.model ?? "claude-test-1",
            content: [block.type === "thinking" ? { ...block, signature: "sig" } : block],
            stop_reason: isLast ? (opts.stopReason ?? "end_turn") : null,
            stop_sequence: null,
            usage,
            ...(opts.cacheMiss
              ? {
                  diagnostics: {
                    cache_miss_reason: {
                      type: opts.cacheMiss.reason,
                      cache_missed_input_tokens: opts.cacheMiss.tokens,
                    },
                  },
                }
              : {}),
          },
        }),
      );
    });
    return this;
  }

  assistantText(text: string, opts: { usage?: UsageOpts; model?: string } = {}): this {
    return this.assistant([{ type: "text", text }], opts);
  }

  toolCall(
    name: string,
    input: Json,
    opts: { id?: string; usage?: UsageOpts; model?: string } = {},
  ): { builder: TranscriptBuilder; id: string } {
    const id = opts.id ?? `toolu_fixture_${String(this.counter + 1).padStart(4, "0")}`;
    this.assistant([{ type: "tool_use", id, name, input }], { ...opts, stopReason: "tool_use" });
    return { builder: this, id };
  }

  toolResult(
    callId: string,
    opts: {
      content?: string;
      isError?: boolean;
      /** string → error shape; object → structured success shape */
      toolUseResult?: unknown;
      durationMs?: number;
    } = {},
  ): this {
    if (opts.durationMs) this.tick(opts.durationMs);
    return this.push(
      this.envelope({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: callId,
              content: opts.content ?? "ok",
              ...(opts.isError !== undefined ? { is_error: opts.isError } : {}),
            },
          ],
        },
        toolUseResult: opts.toolUseResult ?? (opts.isError ? `Error: ${opts.content ?? "failed"}` : { ok: true }),
      }),
    );
  }

  /** Convenience: a full call+result pair. Returns this for chaining. */
  tool(
    name: string,
    input: Json,
    result: { content?: string; isError?: boolean; toolUseResult?: unknown; durationMs?: number } = {},
  ): this {
    const { id } = this.toolCall(name, input);
    return this.toolResult(id, result);
  }

  bashOk(command: string, stdout = ""): this {
    return this.tool("Bash", { command }, { content: stdout, toolUseResult: { stdout, stderr: "", interrupted: false } });
  }

  bashFail(command: string, stderr = "boom"): this {
    return this.tool("Bash", { command }, { content: stderr, isError: true, toolUseResult: "Error: Exit code 1" });
  }

  editFail(filePath: string, error = "String to replace not found in file."): this {
    return this.tool(
      "Edit",
      { file_path: filePath, old_string: "a", new_string: "b" },
      { content: `Error: ${error}`, isError: true, toolUseResult: `Error: ${error}` },
    );
  }

  editOk(filePath: string): this {
    return this.tool(
      "Edit",
      { file_path: filePath, old_string: "a", new_string: "b" },
      { content: "ok", toolUseResult: { filePath, oldString: "a", newString: "b" } },
    );
  }

  readOk(filePath: string, contentBytes = 500, opts: { offset?: number; limit?: number } = {}): this {
    const content = "x".repeat(contentBytes);
    return this.tool(
      "Read",
      { file_path: filePath, ...(opts.offset !== undefined ? { offset: opts.offset } : {}), ...(opts.limit !== undefined ? { limit: opts.limit } : {}) },
      { content, toolUseResult: { type: "text" } },
    );
  }

  permissionDenied(name: string, input: Json): this {
    const { id } = this.toolCall(name, input);
    return this.toolResult(id, {
      content: "The user doesn't want to proceed with this tool use.",
      isError: true,
      toolUseResult: "User rejected tool use",
    });
  }

  attachment(attachment: Json): this {
    return this.push(this.envelope({ type: "attachment", attachment }));
  }

  skillListing(names: string[], descriptions: Record<string, string> = {}): this {
    return this.attachment({
      type: "skill_listing",
      isInitial: true,
      skillCount: names.length,
      names,
      content: names.map((n) => `- ${n}: ${descriptions[n] ?? "a skill"}`).join("\n"),
    });
  }

  agentListing(types: string[], descriptions: Record<string, string> = {}): this {
    return this.attachment({
      type: "agent_listing_delta",
      isInitial: true,
      addedTypes: types,
      addedLines: types.map((t) => `- ${t}: ${descriptions[t] ?? "an agent"} (Tools: *)`),
      removedTypes: [],
    });
  }

  compactBoundary(opts: { preTokens?: number; postTokens?: number; durationMs?: number } = {}): this {
    return this.push(
      this.envelope({
        type: "system",
        subtype: "compact_boundary",
        level: "info",
        compactMetadata: {
          trigger: "auto",
          preTokens: opts.preTokens ?? 1_000_000,
          postTokens: opts.postTokens ?? 15_000,
          durationMs: opts.durationMs ?? 120_000,
        },
      }),
    );
  }

  apiError(retryAttempt: number, retryInMs = 5000): this {
    return this.push(
      this.envelope({
        type: "system",
        subtype: "api_error",
        level: "error",
        error: '{"message":"overloaded"}',
        retryAttempt,
        maxRetries: 10,
        retryInMs,
      }),
    );
  }

  lastPrompt(): this {
    // Written by the CLI after each prompt; the adapter uses leafUuid for fork resolution.
    this.lines.push({ type: "last-prompt", sessionId: this.sessionId, leafUuid: this.lastUuid, lastPrompt: "..." });
    return this;
  }

  /** Rewind the parent pointer to a given uuid to create a fork. */
  rewindTo(uuid: string): this {
    this.lastUuid = uuid;
    return this;
  }

  currentUuid(): string | null {
    return this.lastUuid;
  }

  build(): string {
    return this.lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  }

  /** Write to a temp dir; returns the transcript path. */
  writeTemp(name = "fixture.jsonl"): string {
    const dir = mkdtempSync(join(tmpdir(), "damame-fixture-"));
    const path = join(dir, name);
    writeFileSync(path, this.build());
    return path;
  }
}

export function fixture(sessionId?: string, startIso?: string): TranscriptBuilder {
  return sessionId !== undefined && startIso !== undefined
    ? new TranscriptBuilder(sessionId, startIso)
    : new TranscriptBuilder(sessionId);
}
