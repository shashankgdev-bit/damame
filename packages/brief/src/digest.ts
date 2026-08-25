import type { MetricsBundle } from "@damame/metrics";
import type { Session } from "@damame/ir";

/**
 * The digest is the ONLY thing the brief LLM ever sees — never the raw
 * transcript. Every item carries a stable id so brief claims can cite their
 * sources and the faithfulness gate can verify citations mechanically.
 */
export interface DigestItem {
  id: string;
  kind: "prompt" | "stat" | "file";
  text: string;
}

export interface SessionDigest {
  session_id: string;
  items: DigestItem[];
}

const PROMPT_SAMPLE = 30;
const PROMPT_CHARS = 220;
const STATE_FILE_RE = /CLAUDE\.md|LEDGER|PLAYBOOK|LEARNINGS|BRIEFING|NOTES|PLAN/i;

function clean(text: string, cap = PROMPT_CHARS): string {
  return text.replace(/\s+/g, " ").trim().slice(0, cap);
}

/** First 5 + evenly sampled rest, capped at PROMPT_SAMPLE. */
function samplePrompts(session: Session): Array<{ when: string; text: string }> {
  const human = session.turns.filter((t) => t.origin === "human" && (t.prompt_text ?? "").trim().length > 0);
  // Both ends of the arc are guaranteed: the first prompts (how it began)
  // and the last ones (where it ended up), with the middle sampled evenly.
  const picked =
    human.length <= PROMPT_SAMPLE
      ? human
      : [
          ...human.slice(0, 5),
          ...Array.from({ length: PROMPT_SAMPLE - 8 }, (_, i) => {
            const idx = 5 + Math.floor((i * (human.length - 8 - 5)) / (PROMPT_SAMPLE - 8));
            return human[idx]!;
          }),
          ...human.slice(-3),
        ];
  const seen = new Set<string>();
  const out: Array<{ when: string; text: string }> = [];
  for (const t of picked) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    const when = (session.events[t.first_event_index]?.timestamp ?? "").slice(0, 10);
    out.push({ when, text: clean(t.prompt_text ?? "") });
  }
  return out;
}

export function buildDigest(session: Session, metrics: MetricsBundle): SessionDigest {
  const items: DigestItem[] = [];
  let p = 0;
  let s = 0;
  let f = 0;
  const prompt = (text: string) => items.push({ id: `p${++p}`, kind: "prompt", text });
  const stat = (text: string) => items.push({ id: `s${++s}`, kind: "stat", text });
  const file = (text: string) => items.push({ id: `f${++f}`, kind: "file", text });

  for (const entry of samplePrompts(session)) prompt(`${entry.when} | ${entry.text}`);

  const t = metrics.totals;
  const days =
    session.started_at && session.ended_at
      ? Math.max(1, Math.round((Date.parse(session.ended_at) - Date.parse(session.started_at)) / 86_400_000))
      : null;
  stat(
    `totals: ${t.total_tokens} tokens, ${t.turn_count} turns (${t.human_turn_count} human), ` +
      `${t.tool_call_count} tool calls (${t.tool_error_count} errors)` +
      (days ? `, spanning ~${days} day(s)` : ""),
  );
  stat(`models: ${Object.keys(metrics.per_model).filter((m) => m !== "<synthetic>").join(", ") || "unknown"}`);

  const tools = Object.entries(metrics.per_tool)
    .sort((a, b) => b[1].calls - a[1].calls)
    .slice(0, 10)
    .map(([name, v]) => `${name}×${v.calls}`)
    .join(", ");
  if (tools) stat(`tool usage: ${tools}`);

  // Subagent tasks: what work was delegated (descriptions from spawn calls).
  const callInputs = new Map<string, Record<string, unknown>>();
  for (const e of session.events) if (e.kind === "tool_call") callInputs.set(e.event_id, e.input);
  const agentTasks: string[] = [];
  let workflowCount = 0;
  const workflowNames = new Set<string>();
  for (const e of session.events) {
    if (e.kind !== "subagent_run") continue;
    const input = e.spawn_call_event_id ? (callInputs.get(e.spawn_call_event_id) ?? {}) : {};
    if (e.child_kind === "workflow") {
      workflowCount++;
      const name =
        e.name ??
        (typeof input.name === "string"
          ? input.name
          : typeof input.script === "string"
            ? (/name:\s*['"]([^'"\n]{1,60})['"]/.exec(input.script)?.[1] ?? "")
            : "");
      if (name) workflowNames.add(name);
    } else if (typeof input.description === "string" && agentTasks.length < 8) {
      agentTasks.push(clean(input.description, 80));
    }
  }
  const agentCount = metrics.subagent_runs.length;
  if (agentCount > 0) {
    stat(`subagents: ${agentCount} spawned` + (agentTasks.length ? `; sample tasks: ${agentTasks.join(" | ")}` : ""));
  } else {
    stat("subagents: none spawned");
  }
  if (workflowCount > 0) {
    stat(
      `workflows: ${workflowCount} runs` +
        (workflowNames.size ? ` (${[...workflowNames].slice(0, 8).join(", ")})` : ""),
    );
  }

  if (metrics.compactions.length > 0) {
    const biggest = metrics.compactions.reduce(
      (best, c) => ((c.pre_tokens ?? 0) > (best.pre_tokens ?? 0) ? c : best),
      metrics.compactions[0]!,
    );
    stat(
      `compactions: ${metrics.compactions.length} (context filled and was summarized; largest squeeze ` +
        `${biggest.pre_tokens ?? "?"} → ${biggest.post_tokens ?? "?"} tokens)`,
    );
  }
  const resumes = session.chain_root_event_ids?.length ?? 0;
  if (resumes > 1) stat(`session resumed/reopened ~${resumes} times`);
  if (metrics.interruption_count > 0) stat(`user interruptions: ${metrics.interruption_count}`);
  const idleMs = metrics.idle_gaps_ms.reduce((a, b) => a + b, 0);
  if (idleMs > 600_000) stat(`idle time between turns: ~${Math.round(idleMs / 60_000)} minutes total`);

  // Touched files: what the work was ON. State files are called out — they
  // signal externalized memory (ledgers, plans).
  const fileCounts = new Map<string, number>();
  for (const e of session.events) {
    if (e.kind !== "tool_call") continue;
    const fp = e.input.file_path;
    if (typeof fp !== "string") continue;
    const short = fp.split("/").slice(-2).join("/");
    fileCounts.set(short, (fileCounts.get(short) ?? 0) + 1);
  }
  const topFiles = [...fileCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  if (topFiles.length) {
    file(`most-touched files: ${topFiles.map(([name, n]) => `${name}×${n}`).join(", ")}`);
    const stateFiles = topFiles.filter(([name]) => STATE_FILE_RE.test(name)).map(([name]) => name);
    if (stateFiles.length) file(`state/memory files maintained: ${stateFiles.join(", ")}`);
  }

  return { session_id: session.id, items };
}

/** Render the digest for the prompt: one `[id] kind: text` line per item. */
export function renderDigest(digest: SessionDigest): string {
  return digest.items.map((i) => `[${i.id}] ${i.kind}: ${i.text}`).join("\n");
}
