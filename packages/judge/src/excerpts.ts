import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Event, Finding, Session } from "@damame/ir";

const PER_EVENT_CAP = 600;
const TOTAL_CAP = 9_000;
const MAX_EVIDENCE_EVENTS = 6;
const WINDOW = 2;

function renderEvent(event: Event): string {
  switch (event.kind) {
    case "user_message":
      return `[user${event.is_meta ? " harness" : ""}] ${event.text.slice(0, PER_EVENT_CAP)}`;
    case "assistant_message":
      return `[assistant${event.model ? ` ${event.model}` : ""}] ${(event.text ?? "(tool use)").slice(0, PER_EVENT_CAP)}`;
    case "thinking":
      return `[thinking] ${event.text.slice(0, 200)}`;
    case "tool_call":
      return `[tool_call ${event.name}] ${JSON.stringify(event.input).slice(0, PER_EVENT_CAP)}`;
    case "tool_result":
      return `[tool_result${event.tool_name ? ` ${event.tool_name}` : ""}${event.is_error ? " ERROR" : ""}${event.error_signature ? ` sig=${event.error_signature}` : ""}] ${(event.output_text ?? "").slice(0, PER_EVENT_CAP)}`;
    case "compaction":
      return `[compaction] pre=${event.pre_tokens ?? "?"} post=${event.post_tokens ?? "?"} duration_ms=${event.duration_ms ?? "?"}`;
    case "interruption":
      return `[interruption ${event.scope}]`;
    case "permission_denial":
      return `[permission_denial${event.tool_name ? ` ${event.tool_name}` : ""}]`;
    case "subagent_run":
      return `[subagent_run ${event.spawn_tool}${event.agent_type ? ` ${event.agent_type}` : ""}]`;
    case "system_event":
      return `[system ${event.subtype}] ${JSON.stringify(event.detail).slice(0, 300)}`;
  }
}

/**
 * Evidence windows: for each cited event, ±WINDOW surrounding events, rendered
 * compactly. The auditor sees ONLY this — never the whole session — and per
 * finding it also carries the cache-miss metrics the rule keyed on.
 */
export function buildExcerpts(session: Session, finding: Finding): string {
  const indexById = new Map(session.events.map((e, i) => [e.event_id, i]));
  const included = new Set<number>();
  for (const ref of finding.evidence.events.slice(0, MAX_EVIDENCE_EVENTS)) {
    const idx = indexById.get(ref.event_id);
    if (idx === undefined) continue;
    for (let i = Math.max(0, idx - WINDOW); i <= Math.min(session.events.length - 1, idx + WINDOW); i++) {
      included.add(i);
    }
  }
  const cited = new Set(finding.evidence.events.map((e) => e.event_id));
  const lines: string[] = [];
  let total = 0;
  for (const i of [...included].sort((a, b) => a - b)) {
    const event = session.events[i]!;
    const line = `${cited.has(event.event_id) ? ">> " : "   "}#${i} ${renderEvent(event)}`;
    total += line.length;
    if (total > TOTAL_CAP) {
      lines.push("   … (truncated)");
      break;
    }
    lines.push(line);
  }
  if (finding.evidence.metrics) {
    lines.push(`   [detector metrics] ${JSON.stringify(finding.evidence.metrics).slice(0, 400)}`);
  }
  return lines.join("\n");
}

/** The rule's documented definition, if the docs are on disk (best effort). */
export function ruleDefinition(ruleId: string, repoDocsDir?: string): string {
  const candidates = [
    ...(repoDocsDir ? [join(repoDocsDir, `${ruleId}.md`)] : []),
    join(process.cwd(), "docs", "rules", `${ruleId}.md`),
  ];
  for (const path of candidates) {
    try {
      if (existsSync(path)) {
        const text = readFileSync(path, "utf8");
        const section = /## What it detects\n([\s\S]*?)\n## /.exec(text)?.[1];
        return (section ?? text).slice(0, 1200).trim();
      }
    } catch {
      // docs missing in packed installs — fall through
    }
  }
  return `Rule "${ruleId}": a deterministic detector; judge the claim strictly against the evidence shown.`;
}

/** Normalized substring check for the mechanical quote gate. */
export function quoteAppears(quote: string, excerpts: string): boolean {
  const normalize = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const q = normalize(quote);
  return q.length >= 8 && normalize(excerpts).includes(q);
}
