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
  "paste-relay",
  "repeated-delegation",
  "eternal-session",
  "idle-gap-notifications",
  "post-edit-ritual",
  "compaction-rework",
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

  "paste-relay"(seed) {
    const r = rng(seed);
    const b = base(seed, "pasterly");
    b.human("I'll paste each reviewer verdict block as I collect them");
    b.assistantText("Ready — paste them in and I'll log each one.");
    for (let i = 0; i < int(r, 8, 12); i++) {
      b.human(`Difficulty: ${i + 1} | Reviewer verdict for pasted block\n` + "data ".repeat(int(r, 500, 700)));
      b.assistantText("Recorded that verdict block.");
    }
    b.assistantText("All verdict blocks recorded and summarized.");
    noise(b, r, 1);
    b.lastPrompt();
    return {
      jsonl: b.build(),
      manifest: { archetype: "paste-relay", seed, expected: ["paste-relay"], forbidden: forbid(["paste-relay"]) },
    };
  },

  "paste-relay-under"(seed) {
    // Five structurally-similar large pastes — one short of min_occurrences — must NOT fire.
    const r = rng(seed);
    const b = base(seed, "pasteund");
    b.human("Pasting the verdicts I have so far");
    b.assistantText("Go ahead.");
    for (let i = 0; i < 5; i++) {
      b.human(`Difficulty: ${i + 1} | Reviewer verdict for pasted block\n` + "data ".repeat(int(r, 500, 700)));
      b.assistantText("Recorded.");
    }
    b.lastPrompt();
    return { jsonl: b.build(), manifest: { archetype: "paste-relay-under", seed, expected: [], forbidden: ALL_RULES } };
  },

  "repeated-delegation"(seed) {
    const r = rng(seed);
    const b = base(seed, "redelegn");
    b.agentListing(["general-purpose"]);
    b.human("run the cold-opus probe over every open case");
    const n = int(r, 6, 10);
    for (let i = 0; i < n; i++) {
      b.tool(
        "Task",
        {
          subagent_type: "general-purpose",
          description: `Cold-Opus probe ${i + 1}`,
          prompt: `Run the standard probe procedure against case ${i + 1} and report the outcome.`,
        },
        { content: `probe ${i + 1} complete`, toolUseResult: { agentId: `agent-probe-${i + 1}`, status: "completed" } },
      );
    }
    b.assistantText("All probes complete.");
    noise(b, r, 1);
    b.lastPrompt();
    return {
      jsonl: b.build(),
      manifest: { archetype: "repeated-delegation", seed, expected: ["repeated-delegation"], forbidden: forbid(["repeated-delegation"]) },
    };
  },

  "few-repeated-spawns"(seed) {
    // The same delegation improvised only 4 times — one under threshold → must NOT fire.
    const r = rng(seed);
    const b = base(seed, "fewspawn");
    b.agentListing(["general-purpose"]);
    b.human("probe the first few cases");
    for (let i = 0; i < 4; i++) {
      b.tool(
        "Task",
        {
          subagent_type: "general-purpose",
          description: `Cold-Opus probe ${i + 1}`,
          prompt: `Run the standard probe procedure against case ${i + 1} and report the outcome.`,
        },
        { content: `probe ${i + 1} complete`, toolUseResult: { agentId: `agent-probe-${i + 1}`, status: "completed" } },
      );
    }
    b.assistantText("Done with the first batch.");
    noise(b, r, 1);
    b.lastPrompt();
    return { jsonl: b.build(), manifest: { archetype: "few-repeated-spawns", seed, expected: [], forbidden: ALL_RULES } };
  },

  "eternal-session"(seed) {
    // One transcript resumed for weeks: many chain roots (parentUuid: null
    // lines), repeated compactions, a multi-week span, and a ledger file that
    // already carries the memory. compaction-burn legitimately overlaps here
    // (3+ compactions), hence the forbid() exception.
    const r = rng(seed);
    const b = base(seed, "eternalz");
    const startMs = Date.parse(`2026-07-${String(1 + (seed % 27)).padStart(2, "0")}T09:00:00.000Z`);
    b.human("continue the ongoing project work");
    b.readOk("/proj/LEDGER.md", int(r, 400, 1_200));
    b.assistantText("Resuming from the ledger.");
    const resumes = int(r, 18, 30);
    for (let i = 0; i < resumes; i++) {
      b.push({
        uuid: `resume-root-${i + 1}`,
        parentUuid: null,
        sessionId: b.sessionId,
        timestamp: new Date(startMs + 60_000 + i * 1_000).toISOString(),
        cwd: "/home/user/project",
        gitBranch: "main",
        version: "2.1.200",
        userType: "external",
        entrypoint: "cli",
        isSidechain: false,
        slug: "fixture-session",
        type: "user",
        message: { role: "user", content: [{ type: "text", text: `pick up where we left off (${i + 1})` }] },
        origin: { kind: "human" },
      });
    }
    for (let i = 0, n = int(r, 3, 6); i < n; i++) b.compactBoundary();
    b.tick(int(r, 10, 40) * 86_400_000);
    b.assistantText("Ledger updated; stopping here.");
    noise(b, r, 1);
    b.lastPrompt();
    return {
      jsonl: b.build(),
      manifest: {
        archetype: "eternal-session",
        seed,
        expected: ["eternal-session"],
        forbidden: forbid(["eternal-session"], ["compaction-burn"]),
      },
    };
  },

  "multi-sitting-task"(seed) {
    // A normal task picked up across two days: a handful of resumes and a
    // single compaction — below eternal-session on every axis (and below
    // compaction-burn's 2-compaction floor). Must NOT fire anything.
    const r = rng(seed);
    const b = base(seed, "twositng");
    const startMs = Date.parse(`2026-07-${String(1 + (seed % 27)).padStart(2, "0")}T09:00:00.000Z`);
    b.human("continue yesterday's refactor");
    b.assistantText("Picking the task back up.");
    const resumes = int(r, 3, 5);
    for (let i = 0; i < resumes; i++) {
      b.push({
        uuid: `resume-root-${i + 1}`,
        parentUuid: null,
        sessionId: b.sessionId,
        timestamp: new Date(startMs + 60_000 + i * 1_000).toISOString(),
        cwd: "/home/user/project",
        gitBranch: "main",
        version: "2.1.200",
        userType: "external",
        entrypoint: "cli",
        isSidechain: false,
        slug: "fixture-session",
        type: "user",
        message: { role: "user", content: [{ type: "text", text: `pick up where we left off (${i + 1})` }] },
        origin: { kind: "human" },
      });
    }
    b.compactBoundary();
    b.tick(2 * 86_400_000);
    b.assistantText("Refactor finished.");
    noise(b, r, 1);
    b.lastPrompt();
    return {
      jsonl: b.build(),
      manifest: { archetype: "multi-sitting-task", seed, expected: [], forbidden: ALL_RULES },
    };
  },

  "idle-gap-notifications"(seed) {
    const r = rng(seed);
    const b = base(seed, "idlegaps");
    b.human("kick off the refactor");
    b.assistantText("Refactor step complete; ready for the next instruction.");
    // 6 gaps of 10-15 minutes each: count >= 5 and total >= 30min, safely
    // above every default threshold. No tools run, so nothing else can trip.
    for (let i = 0; i < 6; i++) {
      b.tick(int(r, 600_000, 900_000));
      b.human(`continue with step ${i + 1}`);
      b.assistantText(`Step ${i + 1} complete; waiting for the next instruction.`);
    }
    b.lastPrompt();
    return {
      jsonl: b.build(),
      manifest: {
        archetype: "idle-gap-notifications",
        seed,
        expected: ["idle-gap-notifications"],
        forbidden: forbid(["idle-gap-notifications"]),
      },
    };
  },

  "post-edit-ritual"(seed) {
    // The same verification ritual follows every edit across task folders —
    // 11-14 pairs, safely above the calibrated threshold of 10.
    const r = rng(seed);
    const b = base(seed, "ritualzz");
    b.human("build and verify each task");
    const n = int(r, 11, 14);
    for (let i = 0; i < n; i++) {
      b.readOk(`/proj/day${i}/test.py`, int(r, 300, 900), { offset: 1, limit: 60 });
      b.tool("Edit", { file_path: `/proj/day${i}/test.py`, old_string: "a", new_string: "b" }, { content: "ok", toolUseResult: { filePath: `/proj/day${i}/test.py` } });
      b.tool("Bash", { command: `cd /proj/day${i} && python3 - <<'PY'\nprint("oracle")\nPY` }, { content: "oracle ok" });
    }
    b.assistantText("all verified");
    noise(b, r, 1);
    b.lastPrompt();
    return {
      jsonl: b.build(),
      manifest: { archetype: "post-edit-ritual", seed, expected: ["post-edit-ritual"], forbidden: forbid(["post-edit-ritual"]) },
    };
  },

  "post-edit-varied"(seed) {
    // Edits followed by genuinely different commands — no family accumulates.
    const r = rng(seed);
    const b = base(seed, "variedcm");
    b.human("assorted work");
    const cmds = ["npm test", "git status", "cat notes.md", "make lint", "pwd", "df -h", "uname -a", "true", "env", "uptime", "hostname", "date"];
    for (let i = 0; i < 12; i++) {
      b.tool("Edit", { file_path: `/proj/f${i}.ts`, old_string: "x", new_string: "y" }, { content: "ok", toolUseResult: { filePath: `/proj/f${i}.ts` } });
      b.tool("Bash", { command: cmds[i % cmds.length]! }, { content: "ok" });
    }
    b.assistantText("done");
    noise(b, r, 1);
    b.lastPrompt();
    return { jsonl: b.build(), manifest: { archetype: "post-edit-varied", seed, expected: [], forbidden: ALL_RULES } };
  },

  "overnight-resume-gaps"(seed) {
    // A feature worked on across several days of overnight gaps. Both real
    // resume encodings are planted: three nights end in an explicit resume
    // boundary (new chain root — older CLI format; suppressed structurally
    // in the metric), and three nights are plain 9-13h gaps on an unbroken
    // chain (newer CLI format; excluded by the detector's walk-away
    // ceiling). Neither is "finished work waiting unnoticed" — idle-gap
    // must stay silent. This is idle-gap v0.3.0's vaccine: on a real
    // 16-day session, 260 reported idle hours were mostly the user's
    // nights. Kept safely under eternal-session's gates (3 resumes < 15,
    // 0 compactions) and under idle-gap's own count gate for in-day gaps.
    const r = rng(seed);
    const b = base(seed, "overnight");
    b.human("start the export feature");
    b.assistantText("First increment done; ready when you are.");
    for (let i = 0; i < 6; i++) {
      b.tick(int(r, 9, 13) * 3_600_000); // the night: app closed
      if (i % 2 === 0) {
        b.resume(`morning ${i + 1}: continue the feature`); // old format: chain root
      } else {
        b.human(`morning ${i + 1}: continue the feature`); // new format: chained
      }
      b.assistantText(`Day ${i + 1} increment complete; ready for review.`);
    }
    noise(b, r, 1);
    b.lastPrompt();
    return {
      jsonl: b.build(),
      manifest: { archetype: "overnight-resume-gaps", seed, expected: [], forbidden: ALL_RULES },
    };
  },

  "compaction-rework"(seed) {
    // The measured price of a summary: three files loaded before a
    // compaction get re-read byte-identically after it — nothing changed
    // except the pile forgetting them. Expect compaction-rework; forbid
    // everything else — especially duplicate-tool-call, which must respect
    // the era split (cross-compaction repeats are rework's crime, not
    // redundant work). Sizes stay under oversized-context-reads' 80KB
    // floor; one compaction stays under compaction-burn's 2-count gate.
    const r = rng(seed);
    const b = base(seed, "cmprework");
    const sizes = [int(r, 28_000, 40_000), int(r, 22_000, 34_000), int(r, 25_000, 38_000)];
    b.human("load the modules we're refactoring");
    for (let i = 0; i < 3; i++) b.readOk(`/proj/src/module_${i}.ts`, sizes[i]!);
    b.assistantText("Modules loaded; starting the refactor plan.");
    b.compactBoundary();
    b.human("continue the refactor");
    for (let i = 0; i < 3; i++) b.readOk(`/proj/src/module_${i}.ts`, sizes[i]!);
    b.assistantText("Re-oriented; continuing.");
    noise(b, r, 1);
    b.lastPrompt();
    return {
      jsonl: b.build(),
      manifest: {
        archetype: "compaction-rework",
        seed,
        expected: ["compaction-rework"],
        forbidden: forbid(["compaction-rework"]),
      },
    };
  },

  "compaction-refresh-changed"(seed) {
    // The innocent twin: files are re-read after a compaction, but their
    // content CHANGED in the meantime (different sizes → different output
    // hashes). Re-reading changed content is correct behavior, not waste —
    // the output-identity guard must keep compaction-rework silent, with
    // no timing heuristics involved.
    const r = rng(seed);
    const b = base(seed, "cmprefresh");
    b.human("load the modules");
    for (let i = 0; i < 3; i++) b.readOk(`/proj/src/module_${i}.ts`, int(r, 24_000, 36_000));
    b.assistantText("Loaded; editing externally now per your note.");
    b.compactBoundary();
    b.human("the files changed outside the session — reload and continue");
    for (let i = 0; i < 3; i++) b.readOk(`/proj/src/module_${i}.ts`, int(r, 40_000, 52_000));
    b.assistantText("Reloaded the changed files; continuing.");
    noise(b, r, 1);
    b.lastPrompt();
    return {
      jsonl: b.build(),
      manifest: { archetype: "compaction-refresh-changed", seed, expected: [], forbidden: ALL_RULES },
    };
  },

  "brief-think-pauses"(seed) {
    // Frequent short pauses between turns — normal human think time, each
    // under the 5-minute minimum gap → must NOT fire.
    const r = rng(seed);
    const b = base(seed, "quickres");
    b.human("start the task");
    b.assistantText("Started; here is the first result.");
    for (let i = 0; i < 8; i++) {
      b.tick(int(r, 60_000, 150_000));
      b.human(`tweak ${i + 1}`);
      b.assistantText(`Tweak ${i + 1} applied.`);
    }
    b.lastPrompt();
    return {
      jsonl: b.build(),
      manifest: { archetype: "brief-think-pauses", seed, expected: [], forbidden: ALL_RULES },
    };
  },
};
