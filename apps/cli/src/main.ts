#!/usr/bin/env node
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
import { feedbackStats, indexFindings, recordFeedback, VERDICTS, type Verdict } from "./feedback.js";

const DAMAME_VERSION = "0.1.0";

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
  .command("feedback")
  .description("Mark a finding helpful/wrong (feeds local per-rule precision stats), or show stats")
  .argument("[key]", "finding dedupe key (or unique prefix) printed in the evidence line")
  .argument("[verdict]", `one of: ${VERDICTS.join(" | ")}`)
  .option("--note <text>", "why (recorded alongside the verdict)")
  .action((key: string | undefined, verdict: string | undefined, opts: { note?: string }) => {
    if (!key || key === "stats") {
      const stats = feedbackStats();
      if (stats.length === 0) {
        console.log(pc.dim("no findings indexed yet — run `damame analyze` first"));
        return;
      }
      console.log(pc.bold("rule".padEnd(28) + "series  emitted  helpful  wrong  n/a  precision"));
      for (const s of stats) {
        const precision =
          s.precision === null ? pc.dim("—") : (s.precision >= 0.8 ? pc.green : pc.red)(s.precision.toFixed(2));
        console.log(
          `${s.rule_id.padEnd(28)}${s.rule_series.padEnd(8)}${String(s.emitted).padEnd(9)}${String(s.helpful).padEnd(9)}${String(s.wrong).padEnd(7)}${String(s.not_actionable).padEnd(5)}${precision}`,
        );
      }
      console.log(pc.dim("\nprecision = helpful / (helpful + wrong); a series resets when a rule's thresholds change. Local only — nothing is uploaded."));
      return;
    }
    if (!verdict || !VERDICTS.includes(verdict as Verdict)) {
      console.error(pc.red(`verdict must be one of: ${VERDICTS.join(" | ")}`));
      process.exitCode = 1;
      return;
    }
    const result = recordFeedback(key, verdict as Verdict, opts.note);
    if (!result.ok) {
      console.error(pc.red(result.error));
      process.exitCode = 1;
      return;
    }
    console.log(`${pc.green("recorded")} ${verdict} on ${pc.bold(result.entry.rule_id)} — “${result.title}”`);
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
