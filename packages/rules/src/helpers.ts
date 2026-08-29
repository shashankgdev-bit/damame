import { createHash } from "node:crypto";
import type { Event, EventRef, Finding, Session } from "@damame/ir";

export function eventRef(session: Session, event: Event | string): EventRef {
  return { session_id: session.id, event_id: typeof event === "string" ? event : event.event_id };
}

export function eventRefs(session: Session, ids: Array<Event | string>): EventRef[] {
  return ids.map((e) => eventRef(session, e));
}

/** Stable identity of a finding: rule + primary evidence. Powers feedback joining and idempotent re-runs. */
export function dedupeKey(ruleId: string, evidence: EventRef[]): string {
  const basis = `${ruleId}|${evidence.map((e) => `${e.session_id}:${e.event_id}`).join(",")}`;
  return createHash("sha256").update(basis).digest("hex").slice(0, 16);
}

/** Fills the derivable fields; detectors supply the substance. */
export function finding(input: Omit<Finding, "dedupe_key">): Finding {
  return { ...input, dedupe_key: dedupeKey(input.rule.id, input.evidence.events) };
}

const SEVERITY_ORDER = { major: 0, moderate: 1, minor: 2, info: 3 } as const;

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (bySeverity !== 0) return bySeverity;
    return (b.savings?.tokens?.value ?? 0) - (a.savings?.tokens?.value ?? 0);
  });
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatBytes(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}MB`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}KB`;
  return `${n}B`;
}

export function formatDuration(ms: number): string {
  if (ms >= 3_600_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${ms}ms`;
}
