import { createHash } from "node:crypto";
import type { Finding, Session } from "@damame/ir";
import { buildExcerpts } from "./excerpts.js";

/**
 * Honeypots: findings that are wrong BY CONSTRUCTION, injected into every
 * audit batch. The auditor doesn't know which cases are real; its catch-rate
 * on honeypots is a live, label-free accuracy score for the judge itself.
 * Mutations are seeded from the finding key so batches are deterministic.
 */
export interface Honeypot {
  base_key: string;
  honeypot_key: string;
  type: "evidence_swap" | "count_inflate";
  finding: Finding;
  /** Pre-built excerpts (for evidence_swap they deliberately mismatch the claim). */
  excerpts: string;
}

function seededPick(seed: string, max: number): number {
  return parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 8), 16) % max;
}

/** Inflate every standalone number in a string by 10x (deterministic). */
function inflateNumbers(text: string): string {
  return text.replace(/\b(\d+(?:\.\d+)?)([kM]?)\b/g, (_, n: string, suffix: string) => {
    const value = parseFloat(n) * 10;
    return `${Number.isInteger(value) ? value : value.toFixed(1)}${suffix}`;
  });
}

export function makeHoneypots(session: Session, findings: Finding[], count: number): Honeypot[] {
  const out: Honeypot[] = [];
  const usable = findings.filter((f) => f.evidence.events.length > 0);
  for (let i = 0; i < count && usable.length > 0; i++) {
    const base = usable[seededPick(`pick-${i}`, usable.length)]!;
    let type: Honeypot["type"] = seededPick(`type-${base.dedupe_key}-${i}`, 2) === 0 ? "evidence_swap" : "count_inflate";

    if (type === "evidence_swap") {
      // Small sessions may lack events far enough from the citation to swap
      // in — fall back to inflation rather than under-delivering honeypots.
      const citedIdxProbe = new Set(
        base.evidence.events.map((r) => session.events.findIndex((e) => e.event_id === r.event_id)).filter((n) => n >= 0),
      );
      const hasUnrelated = session.events.some(
        (e, idx) =>
          !citedIdxProbe.has(idx) &&
          [...citedIdxProbe].every((c) => Math.abs(c - idx) > 10) &&
          (e.kind === "user_message" || e.kind === "assistant_message" || e.kind === "tool_result"),
      );
      if (!hasUnrelated) type = "count_inflate";
    }
    const honeypotKey = `hp-${createHash("sha256").update(`${base.dedupe_key}-${type}-${i}`).digest("hex").slice(0, 12)}`;

    if (type === "evidence_swap") {
      // Point the evidence at unrelated events far from the originals: the
      // claim text stays, the support vanishes.
      const citedIdx = new Set(
        base.evidence.events
          .map((r) => session.events.findIndex((e) => e.event_id === r.event_id))
          .filter((n) => n >= 0),
      );
      const unrelated = session.events.filter(
        (e, idx) =>
          !citedIdx.has(idx) &&
          [...citedIdx].every((c) => Math.abs(c - idx) > 10) &&
          (e.kind === "user_message" || e.kind === "assistant_message" || e.kind === "tool_result"),
      );
      if (unrelated.length < 2) continue;
      const start = seededPick(`swap-${base.dedupe_key}`, Math.max(1, unrelated.length - 3));
      const swapped: Finding = {
        ...base,
        evidence: { events: unrelated.slice(start, start + 3).map((e) => ({ session_id: session.id, event_id: e.event_id })) },
        dedupe_key: honeypotKey,
      };
      out.push({ base_key: base.dedupe_key, honeypot_key: honeypotKey, type, finding: swapped, excerpts: buildExcerpts(session, swapped) });
    } else {
      const inflated: Finding = {
        ...base,
        title: inflateNumbers(base.title),
        description: inflateNumbers(base.description),
        ...(base.savings
          ? { savings: { ...base.savings, tokens: base.savings.tokens ? { ...base.savings.tokens, value: base.savings.tokens.value * 10 } : undefined } }
          : {}),
        dedupe_key: honeypotKey,
      };
      out.push({ base_key: base.dedupe_key, honeypot_key: honeypotKey, type, finding: inflated, excerpts: buildExcerpts(session, inflated) });
    }
  }
  return out;
}
