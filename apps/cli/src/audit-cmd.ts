import { createInterface } from "node:readline";
import pc from "picocolors";
import { parseSessionWithChildren, discoverSessions } from "@damame/adapter-claude-code";
import { computeMetrics } from "@damame/metrics";
import { runRules } from "@damame/rules";
import {
  ApiDriver,
  auditFindings,
  auditorHealth,
  buildExcerpts,
  ClaudeCliDriver,
  humanAgreement,
  type JudgeDriver,
} from "@damame/judge";
import { lastAnswers } from "./feedback.js";

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(`${question} [y/N] `, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

export interface AuditCmdOptions {
  root: string;
  latest?: boolean;
  model: string;
  escalateModel: string;
  runs: string;
  backend: string;
  yes?: boolean;
}

export async function runAuditCommand(target: string | undefined, opts: AuditCmdOptions): Promise<void> {
  const sessions = await discoverSessions(opts.root);
  const candidate = target?.endsWith(".jsonl")
    ? { path: target, sessionId: target }
    : opts.latest || !target
      ? sessions[0]
      : sessions.find((s) => s.sessionId.startsWith(target));
  if (!candidate) {
    console.error(pc.red("no session found — pass a transcript path, id prefix, or --latest"));
    process.exitCode = 1;
    return;
  }

  let driver: JudgeDriver;
  if (opts.backend === "api") {
    try {
      driver = new ApiDriver(opts.model);
    } catch (error) {
      console.error(pc.red(String(error instanceof Error ? error.message : error)));
      process.exitCode = 1;
      return;
    }
  } else {
    if (!(await ClaudeCliDriver.available())) {
      console.error(pc.red("claude CLI not found — install Claude Code, or use --backend api with ANTHROPIC_API_KEY"));
      process.exitCode = 1;
      return;
    }
    driver = new ClaudeCliDriver(opts.model);
  }

  const { session } = await parseSessionWithChildren(candidate.path);
  const metrics = computeMetrics(session);
  const findings = runRules(session, metrics);
  if (findings.length === 0) {
    console.log(pc.dim("no findings to audit in this session"));
    return;
  }

  const runs = Number(opts.runs) || 3;
  const honeypotCount = Math.max(2, Math.floor(findings.length / 5));
  const promptBytes = findings.reduce((sum, f) => sum + buildExcerpts(session, f).length + 1500, 0);
  const estTokens = Math.round(((promptBytes / findings.length) * (findings.length + honeypotCount) * runs) / 4);

  console.log(`\n${pc.bold("damame audit")} — LLM second opinion on ${pc.bold(String(findings.length))} findings`);
  console.log(
    pc.dim(
      `  session: ${session.title ?? session.id}\n` +
        `  will send: evidence excerpts around each finding (never the whole transcript)\n` +
        `  batch: ${findings.length} findings + ${honeypotCount} hidden honeypots × ${runs} runs on ${driver.name}/${opts.model} (escalation: ${opts.escalateModel})\n` +
        `  est. input: ~${Math.round(estTokens / 1000)}k tokens · verdicts stay local in ~/.damame/audits.jsonl`,
    ),
  );
  if (!opts.yes && !(await confirm("proceed?"))) {
    console.log(pc.dim("aborted"));
    return;
  }

  const result = await auditFindings(driver, session, findings, {
    runs,
    escalateModel: opts.escalateModel,
    onProgress: (done, total, label) => process.stderr.write(`\r  auditing ${done}/${total} ${label.padEnd(30)}`),
  });
  process.stderr.write("\n");

  const real = result.records.filter((r) => !r.honeypot);
  const chip = (v: { answer: boolean | null; confidence: string | null; votes_true: number; votes_false: number }) =>
    v.answer === null
      ? pc.dim("abstained")
      : `${v.answer ? pc.green("✓") : pc.red("✗")} (${v.votes_true}/${v.votes_false})${v.confidence === "low" ? pc.yellow(" low") : ""}`;

  console.log(pc.bold("\nverdicts"));
  for (const record of real) {
    console.log(`  ${record.rule_id.padEnd(26)} accurate ${chip(record.accurate)}  applicable ${chip(record.applicable)}  ${pc.dim(record.dedupe_key.slice(0, 8))}`);
  }
  const catchLine =
    result.honeypots_total > 0
      ? `${result.honeypots_caught}/${result.honeypots_total} caught ${result.honeypots_caught === result.honeypots_total ? pc.green("(auditor is reading the evidence)") : pc.yellow("(imperfect — treat verdicts with care)")}`
      : "none";
  console.log(`\n${pc.bold("honeypots:")} ${catchLine}`);
  console.log(pc.dim("verdicts now appear as auditor chips in damame ui; `damame audit stats` for calibration"));
}

export function runAuditStats(): void {
  const health = auditorHealth();
  if (health.length === 0) {
    console.log(pc.dim("no audits recorded yet — run `damame audit --latest` first"));
    return;
  }
  console.log(pc.bold("auditor health (per model@prompt series)"));
  for (const h of health) {
    const catchRate = h.honeypot_catch_rate === null ? "—" : `${(h.honeypot_catch_rate * 100).toFixed(0)}% (${h.honeypots_caught}/${h.honeypots_total})`;
    console.log(
      `  ${h.series.padEnd(26)} audits ${String(h.audits).padEnd(5)} honeypot-catch ${catchRate.padEnd(14)} abstain ${(h.abstention_rate * 100).toFixed(0)}%  escalate ${(h.escalation_rate * 100).toFixed(0)}%  invalid-runs ${(h.invalid_run_rate * 100).toFixed(0)}%`,
    );
  }
  const agreement = humanAgreement(lastAnswers());
  console.log(pc.bold("\nagreement with your answers (per rule)"));
  if (agreement.length === 0) console.log(pc.dim("  no overlap yet — answer accurate?/applicable? on audited findings to calibrate the auditor"));
  for (const row of agreement) {
    console.log(
      `  ${row.rule_id.padEnd(26)} ${row.agreed_questions}/${row.compared_questions} questions agree${row.agreement_rate !== null ? ` (${(row.agreement_rate * 100).toFixed(0)}%)` : ""}`,
    );
  }
  console.log(pc.dim("\nhoneypot-catch needs no labels; agreement grows as you answer findings the auditor also audited. All local."));
}
