import pc from "picocolors";
import type { Finding, GradingVersion, Session } from "@damame/ir";
import { totalTokens } from "@damame/ir";
import type { MetricsBundle } from "@damame/metrics";
import { formatDuration, formatTokens } from "@damame/rules";

const SEVERITY_BADGE: Record<Finding["severity"], string> = {
  major: pc.red("MAJOR"),
  moderate: pc.yellow("MODERATE"),
  minor: pc.cyan("MINOR"),
  info: pc.dim("INFO"),
};

export function renderTerminal(input: {
  session: Session;
  metrics: MetricsBundle;
  findings: Finding[];
  grading: GradingVersion;
  childCount: number;
}): string {
  const { session, metrics: m, findings, grading, childCount } = input;
  const lines: string[] = [];
  const u = m.totals.usage;

  lines.push("");
  lines.push(pc.bold(`damame · ${session.title ?? session.slug ?? session.id}`));
  lines.push(
    pc.dim(
      `${session.project?.cwd ?? "?"} · ${session.started_at?.slice(0, 10) ?? "?"} → ${session.ended_at?.slice(0, 10) ?? "?"} · CLI ${session.source.tool_version_min ?? "?"}${session.source.tool_version_max !== session.source.tool_version_min ? `–${session.source.tool_version_max}` : ""}`,
    ),
  );
  lines.push("");

  lines.push(pc.bold("Facts (deterministic)"));
  lines.push(
    `  tokens     ${pc.bold(formatTokens(totalTokens(u)))}  (in ${formatTokens(u.input_tokens ?? 0)} · out ${formatTokens(u.output_tokens ?? 0)} · cache-read ${formatTokens(u.cache_read_input_tokens ?? 0)} · cache-write ${formatTokens(u.cache_creation_input_tokens ?? 0)})`,
  );
  lines.push(
    `  turns      ${m.totals.turn_count} (${m.totals.human_turn_count} human) · tool calls ${m.totals.tool_call_count} (${m.totals.tool_error_count} errors) · subagents ${m.subagent_runs.length}${childCount ? ` (${childCount} transcripts)` : ""}`,
  );
  lines.push(
    `  friction   compactions ${m.compactions.length} · interruptions ${m.interruption_count} · denials ${m.permission_denials.length} · api-error bursts ${m.api_error_runs.length} · cache misses ${m.cache_misses.length}`,
  );
  const abandonedTokens = m.abandoned_branches.reduce((s, b) => s + b.usage_tokens, 0);
  if (abandonedTokens > 0) {
    lines.push(`  rewinds    ${m.abandoned_branches.length} abandoned branches · ${formatTokens(abandonedTokens)} tokens discarded`);
  }
  lines.push("");

  const infra = findings.filter((f) => f.category === "infra");
  const rest = findings.filter((f) => f.category !== "infra");

  if (rest.length === 0) {
    lines.push(pc.green("No rule fired. The facts above still apply — nothing here means the session was flawless, only that no conservative detector found unambiguous waste."));
  } else {
    lines.push(pc.bold(`Findings (${rest.length})`));
    for (const f of rest) lines.push(...renderFinding(f, session));
  }

  if (infra.length > 0) {
    lines.push("");
    lines.push(pc.bold(pc.dim("Not your inefficiency (infrastructure)")));
    for (const f of infra) lines.push(...renderFinding(f, session));
  }

  lines.push("");
  lines.push(
    pc.dim(
      `grading: damame ${grading.damame_version} · ir ${grading.ir_version} · adapter ${grading.adapter}@${grading.adapter_version} · ${Object.keys(grading.rule_versions).length} rules — reports are comparable only when these match`,
    ),
  );
  lines.push("");
  return lines.join("\n");
}

function renderFinding(f: Finding, session: Session): string[] {
  const lines: string[] = [];
  lines.push("");
  lines.push(`  ${SEVERITY_BADGE[f.severity]} ${pc.bold(f.title)}  ${pc.dim(`[${f.rule.id}@${f.rule.version}]`)}`);
  lines.push(wrap(f.description, "    "));
  if (f.savings) {
    const parts: string[] = [];
    if (f.savings.tokens) parts.push(`~${formatTokens(f.savings.tokens.value)} tokens`);
    if (f.savings.wall_clock_ms) parts.push(formatDuration(f.savings.wall_clock_ms.value));
    const basis = f.savings.basis === "measured" ? pc.green("measured") : pc.yellow("modeled estimate");
    lines.push(`    ${pc.bold("cost:")} ${parts.join(" · ")} (${basis}) ${pc.dim(`— ${f.savings.method}`)}`);
  }
  const res = f.recommendation.resource;
  const avail =
    res.available_in_session === true
      ? pc.green(" (was available this session)")
      : res.available_in_session === false
        ? pc.dim(" (not installed)")
        : "";
  lines.push(`    ${pc.bold("fix:")} ${res.kind}: ${pc.underline(res.ref)}${avail} — ${f.recommendation.rationale}`);
  if (f.recommendation.example_invocation) {
    lines.push(pc.dim(`    e.g. ${f.recommendation.example_invocation}`));
  }
  const evidence = f.evidence.events
    .slice(0, 4)
    .map((ref) => {
      const ev = session.events.find((e) => e.event_id === ref.event_id);
      return ev ? `${ev.raw_ref.file.split("/").pop()}:${ev.raw_ref.line}` : ref.event_id;
    })
    .join(", ");
  lines.push(pc.dim(`    evidence: ${evidence}${f.evidence.events.length > 4 ? ` +${f.evidence.events.length - 4} more` : ""} · ${f.dedupe_key}`));
  return lines;
}

function wrap(text: string, indent: string, width = 100): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = indent;
  for (const word of words) {
    if (line.length + word.length + 1 > width && line.trim()) {
      lines.push(line);
      line = indent;
    }
    line += (line.trim() ? " " : "") + word;
  }
  if (line.trim()) lines.push(line);
  return lines.join("\n");
}
