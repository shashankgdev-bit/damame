import { summarizeWithCache, type SessionSummary } from "@damame/profile";
import type { SessionCandidate } from "@damame/adapter-claude-code";
import { readIndex } from "./feedback.js";

/**
 * Recurrence tracking — the behavioral eval that needs no judge.
 *
 * For each rule: the moment its findings were FIRST surfaced to the user
 * (first_seen in the local findings index) splits session history into
 * before/after. If the pattern's per-session frequency drops afterwards, the
 * findings were correct AND actionable — proven by behavior, not opinion. If
 * it doesn't move, the rule is either wrong or not actionable; equally worth
 * knowing. Rates are normalized per 100 human turns so a huge session doesn't
 * masquerade as regression.
 */
export interface RuleRecurrence {
  rule_id: string;
  surfaced_at: string;
  sessions_before: number;
  sessions_after: number;
  /** findings per 100 human turns */
  rate_before: number | null;
  rate_after: number | null;
  change_pct: number | null; // negative = improving
  verdict: "improving" | "unchanged" | "worsening" | "insufficient_history";
}

export async function computeRecurrence(sessions: SessionCandidate[]): Promise<RuleRecurrence[]> {
  const summaries: SessionSummary[] = [];
  for (const s of sessions) {
    try {
      summaries.push(await summarizeWithCache(s.path));
    } catch {
      // unreadable session — skip
    }
  }

  // earliest surfacing moment per rule
  const surfacedAt = new Map<string, string>();
  for (const entry of readIndex()) {
    const existing = surfacedAt.get(entry.rule_id);
    if (!existing || entry.first_seen < existing) surfacedAt.set(entry.rule_id, entry.first_seen);
  }

  const out: RuleRecurrence[] = [];
  for (const [ruleId, surfaced] of surfacedAt) {
    const surfacedMs = Date.parse(surfaced);
    const before: SessionSummary[] = [];
    const after: SessionSummary[] = [];
    for (const s of summaries) {
      const end = Date.parse(s.ended_at ?? s.started_at ?? "");
      if (Number.isNaN(end)) continue;
      // a session already underway when surfaced counts as "before" — the user
      // hadn't seen the finding while working it
      (end <= surfacedMs ? before : after).push(s);
    }

    const rate = (set: SessionSummary[]): number | null => {
      const turns = set.reduce((sum, s) => sum + s.human_turns, 0);
      if (turns === 0) return null;
      const findings = set.reduce((sum, s) => sum + (s.rule_counts[ruleId] ?? 0), 0);
      return (findings / turns) * 100;
    };

    const rateBefore = rate(before);
    const rateAfter = rate(after);
    const enough = before.length >= 1 && after.length >= 1 && rateBefore !== null && rateAfter !== null;
    const changePct =
      enough && rateBefore! > 0 ? ((rateAfter! - rateBefore!) / rateBefore!) * 100 : enough && rateAfter! > 0 ? 100 : enough ? 0 : null;

    out.push({
      rule_id: ruleId,
      surfaced_at: surfaced,
      sessions_before: before.length,
      sessions_after: after.length,
      rate_before: rateBefore,
      rate_after: rateAfter,
      change_pct: changePct,
      verdict: !enough
        ? "insufficient_history"
        : changePct! <= -20
          ? "improving"
          : changePct! >= 20
            ? "worsening"
            : "unchanged",
    });
  }
  return out.sort((a, b) => a.rule_id.localeCompare(b.rule_id));
}
