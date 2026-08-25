import type { Playbook } from "../schema.js";

/**
 * Seed playbook #1. Grounded entirely in one real 71-day transcript (the
 * "terminus2" TerminalBench task-factory session: 146 hand-pasted grader
 * verdicts, 23 compactions, ~3.4k resumes, 48 re-improvised probe
 * delegations). Every `signature` entry maps to a deterministic detector
 * with its own corpus gate; `narrative` entries are documented knowledge
 * that no detector can yet evidence — they are never auto-recommended.
 */
export const repetitiveTaskProduction: Playbook = {
  id: "repetitive-task-production",
  name: "Repetitive task production",
  description:
    "Sessions that manufacture many similar deliverables in a produce → external-validation → tune loop " +
    "(benchmark tasks, dataset items, content batches). The failure modes are courier work and lost state, " +
    "not bad prompting.",
  use_case_tags: [
    "repetitive-task-production",
    "benchmark-task-creation",
    "task-factory",
    "dataset-production",
    "ai-evaluation",
  ],
  match_keywords: ["task", "benchmark", "dataset", "batch", "eval"],
  source: "curated from a real 71-day TerminalBench task-production transcript (2026-06 → 2026-08)",
  version: "0.1.0",
  entries: [
    {
      id: "automate-verdict-ingestion",
      title: "Stop hand-carrying external results into the chat",
      mistake:
        "Every external validation result (grader output, review verdict, score block) is copied from a " +
        "browser or tool and pasted into the conversation by hand — the human works as a courier between " +
        "two machines.",
      fix:
        "Give the results a machine path: paste into a watched drop-folder a script parses into state, or " +
        "connect a browser tool (MCP) so Claude reads the source itself.",
      rationale:
        "Each paste costs human attention, delays the loop by however long the human is away, and re-bills " +
        "the pasted block as context on every subsequent turn.",
      evidence: { kind: "signature", rule_id: "paste-relay" },
      verified_by: "corpus",
      status: "active",
    },
    {
      id: "save-repeated-probes-as-workflows",
      title: "Freeze re-improvised delegations into named workflows",
      mistake:
        "The same delegation (a validation probe, a batch build) is re-described to subagents by hand " +
        "dozens of times — each repetition can drift, omit a step, or phrase the task differently.",
      fix:
        "Save the procedure as a named, parameterized workflow (one command, arguments for the variable " +
        "part); the script guarantees every step runs identically every time.",
      rationale:
        "Scripted orchestration survives compaction and context loss; improvised orchestration lives in the " +
        "model's memory, which this kind of session repeatedly wipes.",
      evidence: { kind: "signature", rule_id: "repeated-delegation" },
      verified_by: "corpus",
      status: "active",
    },
    {
      id: "session-per-batch-bootstrap",
      title: "Fresh sessions bootstrapped from state files, not one eternal session",
      mistake:
        "One session becomes the permanent workspace for weeks: thousands of resumes, repeated context " +
        "compactions (each a multi-minute pause plus lossy summarization), ever-costlier turns.",
      fix:
        "Keep durable state in files (ledger, briefing, learnings) — which these sessions usually already " +
        "have — and start a fresh session per day/batch whose first prompt is: read the state files, continue.",
      rationale:
        "The transcript is not the memory; the state files are. A fresh 20k-token bootstrap beats a " +
        "million-token resident context on cost, speed, and compaction risk.",
      evidence: { kind: "signature", rule_id: "eternal-session" },
      verified_by: "corpus",
      status: "active",
    },
    {
      id: "notify-when-waiting",
      title: "Let finished work interrupt you",
      mistake:
        "Claude finishes or needs input, and the work sits unnoticed until the human happens to check back " +
        "— the loop's latency becomes the human's checking frequency.",
      fix: "Enable notifications (terminal bell / system notification via /config) so completion pings you.",
      rationale: "The away-time itself is fine — the waste is that nothing signals when returning is worth it.",
      evidence: { kind: "signature", rule_id: "idle-gap-notifications" },
      verified_by: "corpus",
      status: "active",
    },
    {
      id: "precheck-script-from-rejections",
      title: "Turn every external rejection into a permanent mechanical check",
      mistake:
        "Hard-won submission gotchas accumulate as prose in memory files, where they depend on the model " +
        "re-reading and remembering them under context pressure.",
      fix:
        "Maintain one precheck script that mechanically tests every known rejection cause against a " +
        "deliverable before submission; every new rejection adds a line.",
      rationale:
        "A checklist in prose degrades with every compaction; a script never forgets. (No deterministic " +
        "detector for this yet — documented knowledge, not an auto-recommendation.)",
      evidence: { kind: "narrative" },
      verified_by: "manual",
      status: "candidate",
    },
    {
      id: "submission-queue-file",
      title: "Keep a ranked next-up queue in a file",
      mistake:
        "\"Which one should I submit next?\" is re-asked in chat each time, re-deriving a decision that was " +
        "already determinable when validation finished.",
      fix:
        "Have the validation step maintain a ranked queue file (deliverable, readiness, risk); 'what's next' " +
        "becomes a glance instead of a conversation turn.",
      rationale:
        "Decisions derivable from state belong in state. (No deterministic detector yet — documented " +
        "knowledge, not an auto-recommendation.)",
      evidence: { kind: "narrative" },
      verified_by: "manual",
      status: "candidate",
    },
  ],
};
