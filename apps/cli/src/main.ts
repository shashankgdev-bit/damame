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

const DAMAME_VERSION = "0.1.0";

const program = new Command()
  .name("damame")
  .description("A profiler for your AI coding sessions — evidence-linked, deterministic, local-first.")
  .version(DAMAME_VERSION);

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
