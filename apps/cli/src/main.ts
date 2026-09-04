import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import {
  defaultProjectsRoot,
  discoverSessions,
  parseSessionWithChildren,
} from "@damame/adapter-claude-code";
import { computeMetrics } from "@damame/metrics";
import { DETECTORS, gradingVersion, runRules } from "@damame/rules";
import { renderHtmlReport } from "@damame/report-html";
import { renderTerminal } from "./render-terminal.js";
import { feedbackStats, indexFindings, recordAnswer, type Question } from "./feedback.js";

const DAMAME_VERSION = "0.7.0";

const program = new Command()
  .name("damame")
  .description("A profiler for your AI coding sessions — evidence-linked, deterministic, local-first.")
  .version(DAMAME_VERSION);

program
  .command("ui", { isDefault: true })
  .description("Open the interactive dashboard (default) — local server, prints a clickable link")
  .option("--port <n>", "port (default: random free port)")
  .option("--root <dir>", "projects root", defaultProjectsRoot())
  .option("--no-open", "don't auto-open the browser")
  .action(async (opts: { port?: string; root: string; open: boolean }) => {
    const { startUiServer } = await import("./ui/server.js");
    const { url } = await startUiServer({
      root: opts.root,
      ...(opts.port ? { port: Number(opts.port) } : {}),
      openBrowser: opts.open,
    });
    console.log(`\n  ${pc.bold("damame")} is running — open ${pc.underline(pc.green(url))}\n`);
    console.log(pc.dim("  local only (127.0.0.1); nothing leaves this machine. Ctrl-C to stop.\n"));
  });

program
  .command("list")
  .description("List Claude Code sessions on this machine (newest first)")
  .option("--root <dir>", "projects root", defaultProjectsRoot())
  .option("-n, --limit <n>", "max sessions", "20")
  .action(async (opts: { root: string; limit: string }) => {
    const sessions = await discoverSessions(opts.root);
    for (const s of sessions.slice(0, Number(opts.limit))) {
      const size = s.sizeBytes > 1_000_000 ? `${(s.sizeBytes / 1_000_000).toFixed(0)}MB` : `${(s.sizeBytes / 1_000).toFixed(0)}KB`;
      console.log(
        `${pc.dim(s.modifiedAt.toISOString().slice(0, 16))}  ${size.padStart(6)}  ${pc.bold(s.sessionId.slice(0, 8))}  ${pc.dim(s.projectDir)}`,
      );
    }
    if (sessions.length === 0) console.log(pc.dim(`no sessions under ${opts.root}`));
  });

program
  .command("rules")
  .description("List the detector registry (id, version, category, summary)")
  .action(() => {
    for (const d of DETECTORS) {
      console.log(`${pc.bold(d.id.padEnd(26))} ${pc.dim(`v${d.version}`)} ${d.category.padEnd(20)} ${d.summary}`);
    }
  });

program
  .command("analyze")
  .description("Analyze a session transcript (path, session-id prefix, or --latest)")
  .argument("[target]", "transcript path or session id prefix")
  .option("--latest", "analyze the most recently modified session")
  .option("--root <dir>", "projects root", defaultProjectsRoot())
  .option("--json", "emit findings + facts as JSON")
  .option("--html <file>", "also write a self-contained HTML report")
  .option("--rule <ids...>", "run only these rule ids")
  .action(
    async (
      target: string | undefined,
      opts: { latest?: boolean; root: string; json?: boolean; html?: string; rule?: string[] },
    ) => {
      const path = await resolveTarget(target, opts);
      if (!path) {
        console.error(pc.red("no session found — pass a transcript path, a session id prefix, or --latest"));
        process.exitCode = 1;
        return;
      }
      const analyzed = await parseSessionWithChildren(path);
      const metrics = computeMetrics(analyzed.session);
      const findings = runRules(analyzed.session, metrics, opts.rule ? { only: opts.rule } : {});
      const grading = gradingVersion(analyzed.session, DAMAME_VERSION);
      indexFindings(analyzed.session, findings); // local-only; enables `damame feedback`

      if (opts.json) {
        console.log(
          JSON.stringify(
            { grading, session_id: analyzed.session.id, facts: metrics.totals, findings },
            null,
            2,
          ),
        );
      } else {
        console.log(
          renderTerminal({ session: analyzed.session, metrics, findings, grading, childCount: analyzed.children.length }),
        );
      }

      if (opts.html) {
        const html = renderHtmlReport({ session: analyzed.session, metrics, findings, grading });
        const out = resolve(opts.html);
        writeFileSync(out, html);
        console.error(pc.dim(`html report → ${out}`));
      }
    },
  );

program
  .command("profile")
  .description("Your AI development skills across sessions — opportunity-aware, evidence-linked")
  .option("--root <dir>", "projects root", defaultProjectsRoot())
  .option("--json", "emit the profile as JSON")
  .action(async (opts: { root: string; json?: boolean }) => {
    const { buildProfile, probeEnvironment, summarizeWithCache } = await import("@damame/profile");
    const { renderProfile } = await import("./render-profile.js");
    const sessions = await discoverSessions(opts.root);
    if (sessions.length === 0) {
      console.log(pc.dim(`no sessions under ${opts.root}`));
      return;
    }
    const summaries = [];
    for (const s of sessions) {
      try {
        summaries.push(await summarizeWithCache(s.path));
      } catch {
        console.error(pc.dim(`skipped unreadable session ${s.sessionId.slice(0, 8)}`));
      }
    }
    const cwds = [...new Set(summaries.map((s) => s.cwd).filter((c): c is string => !!c))];
    const profile = buildProfile(summaries, probeEnvironment(cwds));
    if (opts.json) console.log(JSON.stringify(profile, null, 2));
    else console.log(renderProfile(profile));
  });

program
  .command("eval")
  .description("Ground-truth evaluation: planted-defect corpus → per-rule recall/precision table (see EVAL.md)")
  .option("--per <n>", "sessions generated per archetype", "10")
  .option("--seed <n>", "corpus seed — failures reproduce byte-identically", "42")
  .action(async (opts: { per: string; seed: string }) => {
    const { runEval } = await import("./eval-cmd.js");
    await runEval(opts);
  });

program
  .command("audit")
  .description("LLM second opinion: adversarially re-check findings against their evidence (opt-in)")
  .argument("[target]", "transcript path or session id prefix")
  .option("--latest", "audit the most recent session")
  .option("--root <dir>", "projects root", defaultProjectsRoot())
  .option("--model <model>", "audit model", "haiku")
  .option("--escalate-model <model>", "model for splits/abstentions", "sonnet")
  .option("--runs <n>", "runs per finding", "3")
  .option("--backend <backend>", "claude-cli | api", "claude-cli")
  .option("--yes", "skip the confirmation prompt")
  .action(async (target: string | undefined, opts) => {
    const { runAuditCommand, runAuditStats } = await import("./audit-cmd.js");
    if (target === "stats") runAuditStats();
    else await runAuditCommand(target, opts);
  });

program
  .command("export")
  .description("machine-readable dump of all sessions' analysis (stable schema — feeds damame-py, spreadsheets, CI)")
  .option("--out <file>", "write to a file instead of stdout")
  .option("--root <dir>", "projects root", defaultProjectsRoot())
  .action(async (opts) => {
    const { runExport } = await import("./export-cmd.js");
    await runExport(opts, DAMAME_VERSION);
  });

program
  .command("share")
  .description("numbers-only calibration stats with a preview file + prefilled GitHub issue URL — nothing sent until you submit")
  .option("--root <dir>", "projects root", defaultProjectsRoot())
  .action(async (opts) => {
    const { runShare } = await import("./share-cmd.js");
    await runShare(opts, DAMAME_VERSION);
  });

const ANSWER_MAP: Record<string, { question: Question; answer: boolean }> = {
  accurate: { question: "accurate", answer: true },
  inaccurate: { question: "accurate", answer: false },
  applicable: { question: "applicable", answer: true },
  "not-applicable": { question: "applicable", answer: false },
};

program
  .command("feedback")
  .description("Answer a finding's eval questions (accurate|inaccurate|applicable|not-applicable), or show stats")
  .argument("[key]", "finding dedupe key (or unique prefix) printed in the evidence line")
  .argument("[answer]", `one of: ${Object.keys(ANSWER_MAP).join(" | ")}`)
  .option("--note <text>", "why (recorded alongside the answer)")
  .option("--root <dir>", "projects root (for recurrence stats)", defaultProjectsRoot())
  .action(async (key: string | undefined, answer: string | undefined, opts: { note?: string; root: string }) => {
    if (!key || key === "stats") {
      const stats = feedbackStats();
      if (stats.length === 0) {
        console.log(pc.dim("no findings indexed yet — run `damame analyze` first"));
        return;
      }
      const fmt = (v: number | null) => (v === null ? pc.dim("—") : (v >= 0.8 ? pc.green : pc.yellow)(v.toFixed(2)));
      console.log(pc.bold("rule".padEnd(28) + "emitted  accurate(y/n)  applicable(y/n)  factual  applies"));
      for (const s of stats) {
        console.log(
          `${s.rule_id.padEnd(28)}${String(s.emitted).padEnd(9)}${`${s.accurate_yes}/${s.accurate_no}`.padEnd(15)}${`${s.applicable_yes}/${s.applicable_no}`.padEnd(17)}${fmt(s.factual_precision)}     ${fmt(s.applicability_rate)}`,
        );
      }
      console.log(pc.bold("\nActed on (behavioral — findings per 100 human turns, before → after first surfacing)"));
      const { computeRecurrence } = await import("./recurrence.js");
      const recurrence = await computeRecurrence(await discoverSessions(opts.root));
      if (recurrence.length === 0) console.log(pc.dim("  nothing surfaced yet"));
      for (const r of recurrence) {
        const line =
          r.verdict === "insufficient_history"
            ? pc.dim("not enough history yet")
            : `${r.rate_before!.toFixed(1)} → ${r.rate_after!.toFixed(1)}  ${
                r.verdict === "improving" ? pc.green(`improving ${Math.round(r.change_pct!)}%`) : r.verdict === "worsening" ? pc.yellow("worsening") : pc.dim("unchanged")
              }`;
        console.log(`${r.rule_id.padEnd(28)}${line}`);
      }
      console.log(pc.dim("\nfactual = accurate-yes / all accurate answers. Recurrence is measured from your later sessions — no opinion involved. Local only."));
      return;
    }
    const mapped = ANSWER_MAP[answer ?? ""];
    if (!mapped) {
      console.error(pc.red(`answer must be one of: ${Object.keys(ANSWER_MAP).join(" | ")}`));
      process.exitCode = 1;
      return;
    }
    const result = recordAnswer(key, mapped.question, mapped.answer, opts.note);
    if (!result.ok) {
      console.error(pc.red(result.error));
      process.exitCode = 1;
      return;
    }
    console.log(`${pc.green("recorded")} ${mapped.question}=${mapped.answer} on ${pc.bold(result.rule_id)} — “${result.title}”`);
  });

async function resolveTarget(
  target: string | undefined,
  opts: { latest?: boolean; root: string },
): Promise<string | undefined> {
  if (target?.endsWith(".jsonl")) return resolve(target);
  const sessions = await discoverSessions(opts.root);
  if (opts.latest || !target) return sessions[0]?.path;
  return sessions.find((s) => s.sessionId.startsWith(target))?.path;
}

await program.parseAsync();
