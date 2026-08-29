import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pc from "picocolors";

/**
 * `damame share` — the calibration-data loop, privacy-safe by construction.
 *
 * Builds the numbers-only export (analysis outputs — scores, counts, rule
 * ids, byte/token totals; NEVER transcript content), writes a summary the
 * user can read line by line before sharing, and prints a prefilled GitHub
 * issue URL. Nothing is transmitted by this command; sharing is the user
 * opening the URL and pressing submit — consent by action, preview first.
 *
 * Why it exists: every damame threshold is calibrated on measured
 * distributions, and distributions are donatable without privacy cost.
 * Ten users' exports multiply the calibration base at zero content risk.
 */
export async function runShare(opts: { root?: string }, damameVersion: string): Promise<void> {
  const { runExport } = await import("./export-cmd.js");
  const tmp = join(mkdtempSync(join(tmpdir(), "damame-share-")), "export.json");
  await runExport({ out: tmp, root: opts.root }, damameVersion);
  const data = JSON.parse(readFileSync(tmp, "utf8")) as {
    export_schema: number;
    sessions: Array<{
      totals: Record<string, number>;
      score?: { overall?: number };
      findings: Array<{ rule_id: string; severity: string; savings_tokens?: number | null }>;
    }>;
  };

  const s = data.sessions;
  const ruleCounts = new Map<string, number>();
  let wasted = 0;
  for (const sess of s)
    for (const f of sess.findings) {
      ruleCounts.set(f.rule_id, (ruleCounts.get(f.rule_id) ?? 0) + 1);
      wasted += f.savings_tokens ?? 0;
    }
  const scores = s.map((x) => x.score?.overall).filter((n): n is number => typeof n === "number");
  const lines = [
    `## damame anonymous calibration stats`,
    ``,
    `- damame ${damameVersion} · export_schema ${data.export_schema}`,
    `- sessions: ${s.length} · total tokens: ${s.reduce((a, x) => a + (x.totals.tokens ?? 0), 0).toLocaleString()}`,
    `- scores: ${scores.join(", ") || "n/a"}`,
    `- measured waste: ${wasted.toLocaleString()} tokens`,
    `- findings per rule: ${[...ruleCounts.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r}×${n}`).join(" · ") || "none"}`,
    `- compactions: ${s.map((x) => x.totals.compactions ?? 0).join(", ")} · subagent runs: ${s.map((x) => x.totals.subagent_runs ?? 0).join(", ")}`,
    ``,
    `_Numbers only — no prompts, no file names, no transcript content. Full schema: attach export.json if you're comfortable (same guarantee)._`,
  ];
  const body = lines.join("\n");
  const out = join(process.cwd(), "damame-share.md");
  writeFileSync(out, `${body}\n`);

  const url = `https://github.com/shashankgdev-bit/damame/issues/new?title=${encodeURIComponent(
    "calibration stats: " + s.length + " sessions",
  )}&labels=${encodeURIComponent("calibration-data")}&body=${encodeURIComponent(body).slice(0, 6000)}`;

  console.log(`\n${pc.bold("damame share")} — numbers-only stats, preview before anything leaves your machine`);
  console.log(pc.dim(`  wrote ${out} — read it; that is the entirety of what would be shared`));
  console.log(pc.dim(`  full export (numbers only) at ${tmp}`));
  console.log(`\n  open this to share it as a GitHub issue (nothing is sent until you press submit):\n  ${url}\n`);
}
