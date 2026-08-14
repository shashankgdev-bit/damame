import { TranscriptBuilder } from "@damame/testkit";

/**
 * Synthetic session archetypes with PLANTED ground truth — the recall
 * instrument. Each archetype builds a full transcript through the same
 * builder the tests use, plus a manifest declaring which rules MUST fire
 * (expected) and which MUST NOT (forbidden). Detectors are deterministic, so
 * on this corpus any miss is a bug, not noise: the eval gate demands 100%.
 *
 * All randomness is a seeded PRNG — same seed, same corpus, forever.
 */
export interface Manifest {
  archetype: string;
  seed: number;
  expected: string[]; // rule ids that must fire ≥1
  forbidden: string[]; // rule ids that must fire 0 times
}

export interface GeneratedSession {
  jsonl: string;
  manifest: Manifest;
}

/** mulberry32 — tiny deterministic PRNG. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const int = (r: () => number, min: number, max: number) => min + Math.floor(r() * (max - min + 1));

const ALL_RULES = [
  "edit-fail-loop",
  "cache-thrash",
  "duplicate-tool-call",
  "compaction-burn",
  "permission-churn",
  "bash-error-loop",
  "abandoned-work",
  "missed-delegation",
  "oversized-context-reads",
  "retry-storm",
];

/** forbidden = everything except the expected rules and rules the noise may legitimately brush. */
function forbid(expected: string[], except: string[] = []): string[] {
  return ALL_RULES.filter((r) => !expected.includes(r) && !except.includes(r));
}

function base(seed: number, name: string): TranscriptBuilder {
  const b = new TranscriptBuilder(
    `${name.padEnd(8, "x").slice(0, 8)}-0000-4000-8000-${String(seed).padStart(12, "0")}`,
    `2026-07-${String(1 + (seed % 27)).padStart(2, "0")}T09:00:00.000Z`,
  );
  b.skillListing(["code-review", "dataviz"]);
  return b;
}

/** Benign filler activity that must never trip a detector. */
function noise(b: TranscriptBuilder, r: () => number, turns: number): void {
  for (let i = 0; i < turns; i++) {
    b.human(`work item ${i}: implement the ${["parser", "cache", "router", "logger"][int(r, 0, 3)]}`);
    b.assistantText("Looking at the relevant code first.");
    b.tool("Grep", { pattern: `symbol_${int(r, 0, 999)}` }, { content: "src/a.ts: match" });
    b.readOk(`/proj/src/file_${int(r, 0, 20)}.ts`, int(r, 300, 2000), { offset: 1, limit: 120 });
    b.editOk(`/proj/src/file_${int(r, 0, 20)}.ts`);
    b.tool("Bash", { command: "npm test" }, { content: `${int(r, 3, 40)} passed` });
    b.assistantText("Done; tests pass.");
  }
}

export const ARCHETYPES: Record<string, (seed: number) => GeneratedSession> = {
  /** Clean sessions: heavy, competent work — zero findings allowed. */
  clean(seed) {
    const r = rng(seed);
    const b = base(seed, "clean");
    b.agentListing(["Explore"]);
    noise(b, r, int(r, 2, 5));
    // healthy delegation mixed in
    const { id } = b.toolCall("Agent", { description: "survey", prompt: "map the modules", subagent_type: "Explore" });
    b.toolResult(id, { content: "launched", toolUseResult: { agentId: "a1", status: "async_launched", isAsync: true } });
    b.lastPrompt();
    return { jsonl: b.build(), manifest: { archetype: "clean", seed, expected: [], forbidden: ALL_RULES } };
  },

  "edit-fail-loop"(seed) {
    const r = rng(seed);
    const b = base(seed, "editloop");
    noise(b, r, int(r, 1, 2));
    const file = `/proj/src/target_${int(r, 0, 9)}.ts`;
    const fails = int(r, 3, 6);
    b.human("fix the flaky assertion");
    for (let i = 0; i < fails; i++) {
      b.editFail(file);
      if (i < fails - 1 && r() > 0.5) b.readOk(file, 800); // diagnostic read must not break the run
    }
    b.editOk(file);
    noise(b, r, 1);
    b.lastPrompt();
    return {
      jsonl: b.build(),
      manifest: { archetype: "edit-fail-loop", seed, expected: ["edit-fail-loop"], forbidden: forbid(["edit-fail-loop"]) },
    };
  },

  "error-loop-near-miss"(seed) {
    const r = rng(seed);
    const b = base(seed, "nearmiss");
    noise(b, r, 1);
    // 2 consecutive fails (under threshold), then fails spread across files
    b.human("tricky refactor");
    b.editFail("/proj/a.ts").editFail("/proj/a.ts").editOk("/proj/a.ts");
    b.editFail("/proj/b.ts").editOk("/proj/b.ts");
    b.bashFail("npm run build").bashOk("npm run build", "ok"); // single bash failure
    noise(b, r, 1);
    b.lastPrompt();
    return {
      jsonl: b.build(),
      manifest: { archetype: "error-loop-near-miss", seed, expected: [], forbidden: ALL_RULES },
    };
  },

  "bash-error-loop"(seed) {
    const r = rng(seed);
    const b = base(seed, "bashloop");
    noise(b, r, 1);
    const cmd = `pytest tests/test_${int(r, 0, 9)}.py`;
    b.human("get the tests passing");
    for (let i = 0; i < int(r, 3, 5); i++) b.bashFail(cmd);
    b.bashOk(cmd, "1 passed");
    b.lastPrompt();
    return {
      jsonl: b.build(),
      manifest: { archetype: "bash-error-loop", seed, expected: ["bash-error-loop"], forbidden: forbid(["bash-error-loop"]) },
    };
  },

  "cache-thrash"(seed) {
    const r = rng(seed);
    const b = base(seed, "cachemis");
    noise(b, r, 1);
    b.human("continue the migration");
    const misses = int(r, 2, 4);
    for (let i = 0; i < misses; i++) {
      b.assistant([{ type: "text", text: `step ${i}` }], {
        cacheMiss: { reason: "tools_changed", tokens: int(r, 60_000, 200_000) },
        usage: { input: 50, output: 200, cacheRead: 10_000, cacheCreate: 400 },
      });
    }
    noise(b, r, 1);
    b.lastPrompt();
    return {
      jsonl: b.build(),
      manifest: { archetype: "cache-thrash", seed, expected: ["cache-thrash"], forbidden: forbid(["cache-thrash"]) },
    };
  },

  "compaction-burn"(seed) {
    const r = rng(seed);
    const b = base(seed, "compact");
    b.agentListing(["Explore"]);
    noise(b, r, 1);
    for (let i = 0; i < int(r, 2, 4); i++) {
      noise(b, r, 1);
      b.compactBoundary({ preTokens: 1_000_000, postTokens: 15_000, durationMs: int(r, 60_000, 150_000) });
    }
    b.lastPrompt();
    return {
      jsonl: b.build(),
      manifest: { archetype: "compaction-burn", seed, expected: ["compaction-burn"], forbidden: forbid(["compaction-burn"]) },
    };
  },

  "single-compaction"(seed) {
    const r = rng(seed);
    const b = base(seed, "onecompt");
    noise(b, r, 2);
    b.compactBoundary({ durationMs: 90_000 });
    noise(b, r, 1);
    b.lastPrompt();
    return { jsonl: b.build(), manifest: { archetype: "single-compaction", seed, expected: [], forbidden: ALL_RULES } };
  },

  rewind(seed) {
    const r = rng(seed);
    const b = base(seed, "rewind");
    noise(b, r, 1);
    b.human("build the exporter");
    const forkPoint = b.currentUuid()!;
    // expensive doomed branch: cache-write-heavy assistant work
    for (let i = 0; i < int(r, 4, 8); i++) {
      b.assistantText(`attempt ${i} of the wrong approach`, {
        usage: { input: 200, output: 8_000, cacheRead: 1_000, cacheCreate: int(r, 40_000, 90_000) },
      });
    }
    b.rewindTo(forkPoint);
    b.human("actually, use the streaming approach instead");
    b.assistantText("Understood, switching approach.");
    noise(b, r, 1);
    b.lastPrompt();
    return {
      jsonl: b.build(),
      manifest: { archetype: "rewind", seed, expected: ["abandoned-work"], forbidden: forbid(["abandoned-work"]) },
    };
  },

  "missed-delegation"(seed) {
    const r = rng(seed);
    const b = base(seed, "nodelegn");
    b.agentListing(["Explore", "general-purpose"]);
    b.human("understand the whole subsystem and summarize it");
    for (let i = 0; i < int(r, 16, 24); i++) {
      b.readOk(`/proj/subsystem/mod_${i}.ts`, int(r, 400, 3_000), { offset: 1, limit: 200 });
    }
    b.assistantText("Here is the summary of all modules.");
    noise(b, r, 1);
    b.lastPrompt();
    return {
      jsonl: b.build(),
      manifest: { archetype: "missed-delegation", seed, expected: ["missed-delegation"], forbidden: forbid(["missed-delegation"]) },
    };
  },

  "long-reads-no-agents"(seed) {
    // Same grind, but NO agent was available that session → must NOT fire.
    const r = rng(seed);
    const b = base(seed, "noagents");
    b.human("survey the modules");
    for (let i = 0; i < 18; i++) b.readOk(`/proj/subsystem/mod_${i}.ts`, int(r, 400, 2_000), { offset: 1, limit: 200 });
    b.assistantText("Summary complete.");
    b.lastPrompt();
    return { jsonl: b.build(), manifest: { archetype: "long-reads-no-agents", seed, expected: [], forbidden: ALL_RULES } };
  },

  "permission-churn"(seed) {
    const r = rng(seed);
    const b = base(seed, "denials");
    noise(b, r, 1);
    for (let i = 0; i < int(r, 3, 5); i++) b.permissionDenied("Bash", { command: `docker compose up service_${i}` });
    noise(b, r, 1);
    b.lastPrompt();
    return {
      jsonl: b.build(),
      manifest: { archetype: "permission-churn", seed, expected: ["permission-churn"], forbidden: forbid(["permission-churn"]) },
    };
  },

  "oversized-reads"(seed) {
    const r = rng(seed);
    const b = base(seed, "bigreads");
    noise(b, r, 1);
    b.human("check the generated bundle");
    for (let i = 0; i < int(r, 1, 3); i++) b.readOk(`/proj/dist/bundle_${i}.js`, int(r, 90_000, 200_000));
    noise(b, r, 1);
    b.lastPrompt();
    return {
      jsonl: b.build(),
      manifest: {
        archetype: "oversized-reads",
        seed,
        expected: ["oversized-context-reads"],
        // an oversized read re-done can legitimately also trip duplicate detection
        forbidden: forbid(["oversized-context-reads"], ["duplicate-tool-call"]),
      },
    };
  },

  "duplicate-calls"(seed) {
    const r = rng(seed);
    const b = base(seed, "dupcalls");
    noise(b, r, 1);
    b.human("compare the configs again");
    const file = "/proj/config/settings.json";
    const content = "x".repeat(int(r, 25_000, 40_000));
    for (let i = 0; i < 3; i++) {
      b.tool("Read", { file_path: file }, { content, toolUseResult: { type: "text" } });
    }
    noise(b, r, 1);
    b.lastPrompt();
    return {
      jsonl: b.build(),
      manifest: {
        archetype: "duplicate-calls",
        seed,
        expected: ["duplicate-tool-call"],
        // 25-40KB repeated full reads may legitimately also be oversized
        forbidden: forbid(["duplicate-tool-call"], ["oversized-context-reads"]),
      },
    };
  },

  "retry-storm"(seed) {
    const r = rng(seed);
    const b = base(seed, "apierrs");
    noise(b, r, 1);
    for (let i = 1; i <= int(r, 3, 6); i++) b.apiError(i, int(r, 2_000, 20_000));
    b.assistantText("finally through");
    noise(b, r, 1);
    b.lastPrompt();
    return {
      jsonl: b.build(),
      manifest: { archetype: "retry-storm", seed, expected: ["retry-storm"], forbidden: forbid(["retry-storm"]) },
    };
  },
};
