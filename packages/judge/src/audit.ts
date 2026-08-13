import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Finding, Session } from "@damame/ir";
import type { JudgeDriver } from "./driver.js";
import { auditPrompt, PROMPT_VERSION, type AuditCase } from "./prompts.js";
import { buildExcerpts, quoteAppears, ruleDefinition } from "./excerpts.js";
import { makeHoneypots, type Honeypot } from "./honeypots.js";

export interface RunVote {
  valid: boolean; // parsed AND passed the quote gate
  accurate?: boolean;
  applicable?: boolean;
  invalid_reason?: string;
  model: string;
}

export interface QuestionVerdict {
  answer: boolean | null; // null = abstained
  confidence: "high" | "low" | null;
  votes_true: number;
  votes_false: number;
}

export interface AuditRecord {
  dedupe_key: string;
  session_id: string;
  rule_id: string;
  honeypot: { type: string; base_key: string } | null;
  accurate: QuestionVerdict;
  applicable: QuestionVerdict;
  runs: RunVote[];
  escalated: boolean;
  model: string;
  prompt_version: string;
  at: string;
}

export interface AuditOptions {
  runs?: number; // default 3
  escalateModel?: string; // one extra run on splits/abstentions
  honeypotEvery?: number; // 1 honeypot per N real findings (default 5, min 2 total)
  onProgress?: (done: number, total: number, label: string) => void;
}

function dataDir(): string {
  return process.env.DAMAME_DATA_DIR ?? join(homedir(), ".damame");
}
const auditsPath = () => join(dataDir(), "audits.jsonl");

function parseRun(raw: string, excerpts: string, model: string): RunVote {
  let parsed: { accurate?: unknown; applicable?: unknown; quotes?: unknown };
  try {
    // tolerate accidental fences
    const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    parsed = JSON.parse(cleaned);
  } catch {
    return { valid: false, invalid_reason: "unparseable", model };
  }
  if (typeof parsed.accurate !== "boolean" || typeof parsed.applicable !== "boolean" || !Array.isArray(parsed.quotes)) {
    return { valid: false, invalid_reason: "bad_shape", model };
  }
  // Mechanical quote gate: every quote must literally appear in the evidence.
  // A verdict resting on invented text is discarded — no judgment involved.
  const quotes = parsed.quotes.filter((q): q is string => typeof q === "string");
  if (quotes.length === 0 || !quotes.every((q) => quoteAppears(q, excerpts))) {
    return { valid: false, invalid_reason: "quote_gate", model };
  }
  return { valid: true, accurate: parsed.accurate, applicable: parsed.applicable, model };
}

function vote(runs: RunVote[], question: "accurate" | "applicable"): QuestionVerdict {
  const valid = runs.filter((r) => r.valid);
  const votesTrue = valid.filter((r) => r[question] === true).length;
  const votesFalse = valid.filter((r) => r[question] === false).length;
  if (valid.length < 2 || votesTrue === votesFalse) {
    return { answer: null, confidence: null, votes_true: votesTrue, votes_false: votesFalse };
  }
  const answer = votesTrue > votesFalse;
  const unanimous = (answer ? votesFalse : votesTrue) === 0;
  return { answer, confidence: unanimous ? "high" : "low", votes_true: votesTrue, votes_false: votesFalse };
}

async function auditOne(
  driver: JudgeDriver,
  auditCase: AuditCase,
  excerpts: string,
  runs: number,
  escalateModel: string | undefined,
): Promise<{ runs: RunVote[]; escalated: boolean }> {
  const prompt = auditPrompt(auditCase);
  const votes: RunVote[] = [];
  for (let i = 0; i < runs; i++) {
    try {
      votes.push(parseRun(await driver.run(prompt), excerpts, driver.model));
    } catch (error) {
      votes.push({ valid: false, invalid_reason: `driver_error: ${String(error).slice(0, 120)}`, model: driver.model });
    }
  }
  // Escalate once on a split or abstention — Trust-or-Escalate.
  let escalated = false;
  const needsEscalation = (["accurate", "applicable"] as const).some((q) => {
    const v = vote(votes, q);
    return v.answer === null || v.confidence === "low";
  });
  if (needsEscalation && escalateModel && escalateModel !== driver.model) {
    escalated = true;
    try {
      votes.push(parseRun(await driver.withModel(escalateModel).run(prompt), excerpts, escalateModel));
    } catch (error) {
      votes.push({ valid: false, invalid_reason: `driver_error: ${String(error).slice(0, 120)}`, model: escalateModel });
    }
  }
  return { runs: votes, escalated };
}

export interface AuditBatchResult {
  records: AuditRecord[];
  honeypots_caught: number;
  honeypots_total: number;
}

export async function auditFindings(
  driver: JudgeDriver,
  session: Session,
  findings: Finding[],
  options: AuditOptions = {},
): Promise<AuditBatchResult> {
  const runs = options.runs ?? 3;
  const honeypots = makeHoneypots(
    session,
    findings,
    Math.max(findings.length > 0 ? 2 : 0, Math.floor(findings.length / (options.honeypotEvery ?? 5))),
  );

  type Case = { finding: Finding; excerpts: string; honeypot: Honeypot | null };
  const cases: Case[] = [
    ...findings.map((f) => ({ finding: f, excerpts: buildExcerpts(session, f), honeypot: null })),
    ...honeypots.map((h) => ({ finding: h.finding, excerpts: h.excerpts, honeypot: h })),
  ];
  // Deterministic interleave so honeypots aren't clustered at the end.
  cases.sort((a, b) => a.finding.dedupe_key.localeCompare(b.finding.dedupe_key));

  const records: AuditRecord[] = [];
  let done = 0;
  for (const c of cases) {
    options.onProgress?.(done, cases.length, c.finding.rule.id);
    const savings = c.finding.savings;
    const result = await auditOne(
      driver,
      {
        title: c.finding.title,
        description: c.finding.description,
        savings_line: savings
          ? `${savings.tokens ? `~${savings.tokens.value} tokens` : ""}${savings.wall_clock_ms ? ` ${Math.round(savings.wall_clock_ms.value / 1000)}s` : ""} (${savings.basis}) — ${savings.method}`
          : null,
        recommendation: `${c.finding.recommendation.resource.kind}: ${c.finding.recommendation.resource.ref} — ${c.finding.recommendation.rationale}`,
        rule_id: c.finding.rule.id,
        rule_definition: ruleDefinition(c.finding.rule.id),
        excerpts: c.excerpts,
      },
      c.excerpts,
      runs,
      options.escalateModel,
    );
    records.push({
      dedupe_key: c.finding.dedupe_key,
      session_id: session.id,
      rule_id: c.finding.rule.id,
      honeypot: c.honeypot ? { type: c.honeypot.type, base_key: c.honeypot.base_key } : null,
      accurate: vote(result.runs, "accurate"),
      applicable: vote(result.runs, "applicable"),
      runs: result.runs,
      escalated: result.escalated,
      model: driver.model,
      prompt_version: PROMPT_VERSION,
      at: new Date().toISOString(),
    });
    done += 1;
    options.onProgress?.(done, cases.length, c.finding.rule.id);
  }

  mkdirSync(dataDir(), { recursive: true });
  appendFileSync(auditsPath(), records.map((r) => JSON.stringify(r)).join("\n") + "\n");

  // a honeypot is "caught" when the auditor refuted its accuracy
  const honeypotRecords = records.filter((r) => r.honeypot);
  return {
    records,
    honeypots_caught: honeypotRecords.filter((r) => r.accurate.answer === false).length,
    honeypots_total: honeypotRecords.length,
  };
}

export function readAudits(): AuditRecord[] {
  if (!existsSync(auditsPath())) return [];
  return readFileSync(auditsPath(), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as AuditRecord];
      } catch {
        return [];
      }
    });
}

/** Latest non-honeypot audit per finding (for UI overlay). */
export function lastAudits(): Map<string, AuditRecord> {
  const map = new Map<string, AuditRecord>();
  for (const record of readAudits()) {
    if (!record.honeypot) map.set(record.dedupe_key, record);
  }
  return map;
}
