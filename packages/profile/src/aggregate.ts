import { SKILLS, STATE_COPY, STATE_THRESHOLDS, type PracticeState, type SkillId } from "./taxonomy.js";
import { TECHNIQUES, TECHNIQUE_BY_ID } from "./techniques.js";
import type { SessionSummary } from "./summarize.js";

export interface EnvProbeResult {
  /** environment-derived technique observations: hooks, claude-md, allowlists */
  techniques: Record<string, boolean>;
}

export interface SkillProfile {
  id: SkillId;
  title: string;
  tagline: string;
  state: PracticeState;
  state_label: string;
  state_blurb: string;
  /** rate = uses/(uses+misses); null when no opportunities. */
  rate: number | null;
  uses: number;
  misses: number;
  missed_tokens: number;
  missed_wall_ms: number;
  /** rate in the prior window, when it had opportunities. */
  prior_rate: number | null;
  trend: "up" | "down" | "flat" | null;
  /** Per-week [uses, misses] for sparklines, oldest → newest. */
  weekly: Array<{ week: string; uses: number; misses: number }>;
  techniques: Array<{ id: string; title: string; count: number; tried: boolean; source: string; lesson: string }>;
  suggestion?: { technique_id: string; title: string; lesson: string; reason: string };
  measurement_note?: string;
  /** dedupe_keys of miss findings in the window (evidence). */
  miss_keys: string[];
}

export interface Recommendation {
  skill: SkillId;
  skill_title: string;
  headline: string;
  technique_id: string;
  technique_title: string;
  lesson: string;
  missed_tokens: number;
  missed_wall_ms: number;
  session_titles: string[];
  miss_keys: string[];
}

export interface Profile {
  generated_from: { sessions: number; from?: string; to?: string; window_days: number };
  sparse: boolean;
  skills: SkillProfile[];
  recommendations: Recommendation[];
  technique_coverage: { tried: number; total: number };
  methodology_note: string;
}

const WINDOW_DAYS = 28;

function inWindow(summary: SessionSummary, now: number, fromDays: number, toDays: number): boolean {
  const when = Date.parse(summary.ended_at ?? summary.started_at ?? "");
  if (Number.isNaN(when)) return fromDays === WINDOW_DAYS; // undated → current window
  const age = (now - when) / 86_400_000;
  return age >= toDays && age < fromDays;
}

function isoWeek(dateMs: number): string {
  const d = new Date(dateMs);
  return `${d.getUTCFullYear()}-W${String(Math.ceil(((dateMs - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7)).padStart(2, "0")}`;
}

export function buildProfile(summaries: SessionSummary[], env: EnvProbeResult, now = Date.now()): Profile {
  const current = summaries.filter((s) => inWindow(s, now, WINDOW_DAYS, 0));
  const prior = summaries.filter((s) => inWindow(s, now, WINDOW_DAYS * 2, WINDOW_DAYS));
  const sparse = current.length < 5;

  const titleById = new Map(summaries.map((s) => [s.session_id, s.title ?? s.session_id.slice(0, 8)]));

  const skills: SkillProfile[] = SKILLS.map((def) => {
    const tally = (set: SessionSummary[]) => {
      let uses = 0, misses = 0, tokens = 0, wallMs = 0;
      const keys: string[] = [];
      for (const s of set) {
        const t = s.skills[def.id];
        if (!t) continue;
        uses += t.uses;
        misses += t.misses;
        tokens += t.missed_tokens;
        wallMs += t.missed_wall_ms;
        keys.push(...t.miss_keys);
      }
      return { uses, misses, tokens, wallMs, keys };
    };
    const cur = tally(current);
    const prev = tally(prior);

    // environment-derived technique credit (hooks, claude-md, allowlists)
    for (const techniqueId of def.use_techniques) {
      const t = TECHNIQUE_BY_ID.get(techniqueId);
      if (t?.source === "environment" && env.techniques[techniqueId]) cur.uses += 1;
    }

    const opportunities = cur.uses + cur.misses;
    // Rate is only meaningful in opportunity mode WITH a measured miss side.
    const rateApplies = def.mode === "opportunity" && def.miss_rules.length > 0;
    const rate = rateApplies && opportunities > 0 ? cur.uses / opportunities : null;
    const priorOpportunities = prev.uses + prev.misses;
    const priorRate = rateApplies && priorOpportunities > 0 ? prev.uses / priorOpportunities : null;

    let state: PracticeState;
    if (def.miss_rules.length === 0 && def.mode === "opportunity") {
      // A skill with no deterministic miss detector yet (prompt-engineering in
      // v1) can never honestly claim "practiced well" — there is no measured
      // opportunity side. It stays getting_started with its measurement note.
      state = "getting_started";
    } else if (def.mode === "coverage") {
      // Breadth skill: no "miss" concept and no nagging — you're either
      // exploring the ecosystem or still getting started, never "failing".
      const distinct = def.use_techniques.filter(
        (id) => current.some((s) => (s.techniques[id] ?? 0) > 0) || env.techniques[id],
      ).length;
      const needed = Math.max(STATE_THRESHOLDS.coverage_started, def.use_techniques.length - 1);
      state = distinct >= needed ? "practiced_well" : "getting_started";
    } else if (opportunities === 0) {
      state = "not_needed";
    } else if (opportunities < STATE_THRESHOLDS.min_opportunities) {
      state = "getting_started";
    } else {
      state = rate! >= STATE_THRESHOLDS.practiced_rate ? "practiced_well" : "opportunities_missed";
    }

    const trend =
      rate !== null && priorRate !== null
        ? rate > priorRate + 0.05
          ? ("up" as const)
          : rate < priorRate - 0.05
            ? ("down" as const)
            : ("flat" as const)
        : null;

    // weekly buckets for sparkline
    const weeks = new Map<string, { uses: number; misses: number }>();
    for (const s of current) {
      const when = Date.parse(s.ended_at ?? s.started_at ?? "");
      if (Number.isNaN(when)) continue;
      const week = isoWeek(when);
      const bucket = weeks.get(week) ?? { uses: 0, misses: 0 };
      bucket.uses += s.skills[def.id]?.uses ?? 0;
      bucket.misses += s.skills[def.id]?.misses ?? 0;
      weeks.set(week, bucket);
    }

    const techniqueRows = def.use_techniques
      .map((id) => TECHNIQUE_BY_ID.get(id))
      .filter((t): t is NonNullable<typeof t> => t !== undefined)
      .map((t) => {
        const count =
          t.source === "environment"
            ? env.techniques[t.id]
              ? 1
              : 0
            : summaries.reduce((sum, s) => sum + (s.techniques[t.id] ?? 0), 0);
        return { id: t.id, title: t.title, count, tried: count > 0, source: t.source, lesson: t.lesson };
      });

    // suggestion: untried technique, preferring the one that would address misses
    const untried = techniqueRows.filter((t) => !t.tried);
    const suggestion =
      untried.length > 0
        ? {
            technique_id: untried[0]!.id,
            title: untried[0]!.title,
            lesson: untried[0]!.lesson,
            reason:
              cur.misses > 0
                ? `${cur.misses} missed ${cur.misses === 1 ? "opportunity" : "opportunities"} in the last ${WINDOW_DAYS} days point here.`
                : "Untried so far — worth one deliberate attempt to know when it fits.",
          }
        : undefined;

    return {
      id: def.id,
      title: def.title,
      tagline: def.tagline,
      state,
      state_label: STATE_COPY[state].label,
      state_blurb: STATE_COPY[state].blurb,
      rate,
      uses: cur.uses,
      misses: cur.misses,
      missed_tokens: cur.tokens,
      missed_wall_ms: cur.wallMs,
      prior_rate: priorRate,
      trend,
      weekly: [...weeks.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([week, v]) => ({ week, ...v })),
      techniques: techniqueRows,
      ...(suggestion ? { suggestion } : {}),
      ...(def.measurement_note ? { measurement_note: def.measurement_note } : {}),
      miss_keys: cur.keys,
    };
  });

  // recommendations: skills with misses, ranked by measured waste
  const recommendations: Recommendation[] = skills
    .filter((s) => s.misses > 0)
    .sort((a, b) => b.missed_tokens + b.missed_wall_ms / 100 - (a.missed_tokens + a.missed_wall_ms / 100))
    .slice(0, 5)
    .map((s) => {
      const sessionsWithMisses = current
        .filter((sum) => (sum.skills[s.id]?.misses ?? 0) > 0)
        .map((sum) => titleById.get(sum.session_id)!)
        .slice(0, 3);
      // Prefer the untried-technique suggestion; else the least-practiced one
      // (never recommend the technique the user already leans on most).
      const leastUsed = [...s.techniques].sort((a, b) => a.count - b.count)[0];
      const pick = s.suggestion ?? {
        technique_id: leastUsed?.id ?? "",
        title: leastUsed?.title ?? s.title,
        lesson: leastUsed?.lesson ?? "",
      };
      return {
        skill: s.id,
        skill_title: s.title,
        headline: recommendationHeadline(s, sessionsWithMisses.length),
        technique_id: pick.technique_id,
        technique_title: pick.title,
        lesson: pick.lesson,
        missed_tokens: s.missed_tokens,
        missed_wall_ms: s.missed_wall_ms,
        session_titles: sessionsWithMisses,
        miss_keys: s.miss_keys.slice(0, 12),
      };
    });

  const dates = summaries
    .map((s) => s.ended_at ?? s.started_at)
    .filter((d): d is string => d !== undefined)
    .sort();

  const triedTechniques = TECHNIQUES.filter(
    (t) =>
      (t.source === "environment" && env.techniques[t.id]) ||
      summaries.some((s) => (s.techniques[t.id] ?? 0) > 0),
  ).length;

  return {
    generated_from: {
      sessions: summaries.length,
      ...(dates[0] ? { from: dates[0].slice(0, 10) } : {}),
      ...(dates[dates.length - 1] ? { to: dates[dates.length - 1]!.slice(0, 10) } : {}),
      window_days: WINDOW_DAYS,
    },
    sparse,
    skills,
    recommendations,
    technique_coverage: { tried: triedTechniques, total: TECHNIQUES.length },
    methodology_note:
      "Measures practice from your transcripts, not ability. Every rate is uses ÷ (uses + missed opportunities), " +
      "with opportunity definitions documented per rule. No opportunities detected means no judgment. " +
      "Trends compare you to your own prior weeks only.",
  };
}

function recommendationHeadline(s: SkillProfile, sessionCount: number): string {
  const where = sessionCount > 1 ? `${sessionCount} recent sessions` : "a recent session";
  const cost =
    s.missed_tokens > 0
      ? ` — about ${formatTokensPlain(s.missed_tokens)} tokens of measured waste`
      : s.missed_wall_ms > 60_000
        ? ` — about ${Math.round(s.missed_wall_ms / 60_000)} minutes of measured stalls`
        : "";
  return `${where} had scope for ${s.title.toLowerCase()} that went unused${cost}.`;
}

function formatTokensPlain(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}
