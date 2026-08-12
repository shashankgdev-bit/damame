import { describe, expect, it } from "vitest";
import { fixture } from "@damame/testkit";
import { parseTranscriptFile } from "@damame/adapter-claude-code";
import type { Session, ToolCallEvent } from "@damame/ir";
import { computeMetrics, type MetricsBundle } from "../src/index.js";

async function run(path: string): Promise<{ session: Session; metrics: MetricsBundle }> {
  const { session } = await parseTranscriptFile(path);
  return { session, metrics: computeMetrics(session) };
}

describe("computeMetrics", () => {
  it("totals.usage equals the session's deduped usage_totals", async () => {
    const path = fixture()
      .human("go")
      // Multi-block message: 2 transcript lines, one message.id, usage counted once.
      .assistant(
        [
          { type: "text", text: "step one" },
          { type: "thinking", thinking: "hmm" },
        ],
        { usage: { input: 5, output: 50, cacheRead: 0, cacheCreate: 0 } },
      )
      .assistantText("done", { usage: { input: 7, output: 70, cacheRead: 0, cacheCreate: 0 } })
      .writeTemp();

    const { session, metrics } = await run(path);

    expect(metrics.totals.usage).toEqual(session.usage_totals);
    // Proves dedup flowed through: 5+7, not double-counting the 2-line message.
    expect(metrics.totals.usage.input_tokens).toBe(12);
    expect(metrics.totals.usage.output_tokens).toBe(120);
    expect(metrics.totals.total_tokens).toBe(132);
  });

  it("groups identical repeated calls with identical_results true", async () => {
    const path = fixture()
      .human("check the file")
      .readOk("/home/user/project/a.ts", 500)
      .readOk("/home/user/project/a.ts", 500)
      .writeTemp();

    const { metrics } = await run(path);

    expect(metrics.duplicate_tool_calls).toHaveLength(1);
    const group = metrics.duplicate_tool_calls[0]!;
    expect(group.tool_name).toBe("Read");
    expect(group.call_event_ids).toHaveLength(2);
    expect(group.identical_results).toBe(true);
    expect(group.state_change_between).toBe(false);
    expect(group.repeated_output_bytes).toBe(500);
  });

  it("flags state_change_between when an Edit succeeds between duplicate calls", async () => {
    const path = fixture()
      .human("run it")
      .bashOk("cat a.ts", "hello")
      .editOk("/home/user/project/a.ts")
      .bashOk("cat a.ts", "hello")
      .writeTemp();

    const { metrics } = await run(path);

    expect(metrics.duplicate_tool_calls).toHaveLength(1);
    const group = metrics.duplicate_tool_calls[0]!;
    expect(group.tool_name).toBe("Bash");
    expect(group.state_change_between).toBe(true);
  });

  it("builds one error run from 3 same-file edit failures across an interleaved read", async () => {
    const path = fixture()
      .human("fix it")
      .editFail("/home/user/project/api.ts")
      .readOk("/home/user/project/api.ts") // diagnostic read must not split the run
      .editFail("/home/user/project/api.ts")
      .editFail("/home/user/project/api.ts")
      .writeTemp();

    const { metrics } = await run(path);

    expect(metrics.error_runs).toHaveLength(1);
    const errRun = metrics.error_runs[0]!;
    expect(errRun.signature).toBe("edit_string_not_found");
    expect(errRun.tool_name).toBe("Edit");
    expect(errRun.target).toBe("/home/user/project/api.ts");
    expect(errRun.length).toBe(3);
    expect(errRun.result_event_ids).toHaveLength(3);
    expect(errRun.retry_usage_tokens).toBeGreaterThan(0);
  });

  it("does NOT build an error run from failures on three different files", async () => {
    const path = fixture()
      .human("fix them")
      .editFail("/home/user/project/a.ts")
      .editFail("/home/user/project/b.ts")
      .editFail("/home/user/project/c.ts")
      .writeTemp();

    const { metrics } = await run(path);
    expect(metrics.error_runs).toHaveLength(0);
  });

  it("counts a run of 5 consecutive read-only calls in one turn", async () => {
    const path = fixture()
      .human("look around")
      .readOk("/home/user/project/a.ts")
      .readOk("/home/user/project/b.ts")
      .readOk("/home/user/project/c.ts")
      .readOk("/home/user/project/d.ts")
      .readOk("/home/user/project/e.ts")
      .writeTemp();

    const { session, metrics } = await run(path);

    expect(metrics.read_only_runs).toHaveLength(1);
    const roRun = metrics.read_only_runs[0]!;
    expect(roRun.length).toBe(5);
    expect(roRun.turn_id).toBe(session.turns[0]!.id);
    const readCalls = session.events.filter(
      (e): e is ToolCallEvent => e.kind === "tool_call" && e.name === "Read",
    );
    expect(roRun.first_event_id).toBe(readCalls[0]!.event_id);
    expect(roRun.last_event_id).toBe(readCalls[4]!.event_id);
  });

  it("resets the read-only run when a Bash call interrupts it", async () => {
    const path = fixture()
      .human("look around")
      .readOk("/home/user/project/a.ts")
      .readOk("/home/user/project/b.ts")
      .readOk("/home/user/project/c.ts")
      .bashOk("npm test", "ok")
      .readOk("/home/user/project/d.ts")
      .readOk("/home/user/project/e.ts")
      .writeTemp();

    const { metrics } = await run(path);

    expect(metrics.read_only_runs).toHaveLength(1);
    expect(metrics.read_only_runs[0]!.length).toBe(3);
  });

  it("counts only large full-file reads, not limited or small ones", async () => {
    const path = fixture()
      .human("read stuff")
      .readOk("/home/user/project/big.txt", 100_000)
      .readOk("/home/user/project/big-limited.txt", 100_000, { limit: 500 })
      .readOk("/home/user/project/small.txt", 500)
      .writeTemp();

    const { metrics } = await run(path);

    expect(metrics.large_full_reads).toHaveLength(1);
    const read = metrics.large_full_reads[0]!;
    expect(read.file_path).toBe("/home/user/project/big.txt");
    expect(read.output_bytes).toBe(100_000);
  });

  it("groups consecutive api_error events into one run with summed retry wait", async () => {
    const path = fixture()
      .human("go")
      .apiError(1, 1000)
      .apiError(2, 2000)
      .apiError(3, 4000)
      .assistantText("recovered")
      .writeTemp();

    const { metrics } = await run(path);

    expect(metrics.api_error_runs).toHaveLength(1);
    const apiRun = metrics.api_error_runs[0]!;
    expect(apiRun.event_ids).toHaveLength(3);
    expect(apiRun.total_retry_wait_ms).toBe(7000);
  });
});
