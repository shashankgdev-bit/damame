import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Finding, Session } from "@damame/ir";

/**
 * The local feedback loop — per-rule precision measured, not asserted.
 *
 * "Helpful/wrong" turned out to bundle questions of very different judgment
 * difficulty, so feedback is decomposed into two narrow, more objective
 * questions per finding:
 *   - accurate:   did the cited events happen as described? (checkable
 *                 against the evidence links — anyone can judge this)
 *   - applicable: was the suggested alternative actually usable there?
 * The third dimension — "did it change anything" — is deliberately NOT an
 * opinion question: recurrence tracking measures it from later sessions.
 *
 * Answers join findings on (dedupe_key, rule id, rule major.minor); a
 * threshold change starts a fresh precision series. Everything stays on disk
 * under ~/.damame; nothing is uploaded.
 */

export type Question = "accurate" | "applicable";
export const QUESTIONS: Question[] = ["accurate", "applicable"];

export const QUESTION_COPY: Record<Question, { ask: string; yes: string; no: string }> = {
  accurate: { ask: "Accurate?", yes: "events happened as described", no: "the description is factually wrong" },
  applicable: { ask: "Applicable?", yes: "the suggestion was usable here", no: "the suggestion didn't fit this situation" },
};

interface IndexEntry {
  dedupe_key: string;
  rule_id: string;
  rule_version: string;
  session_id: string;
  title: string;
  first_seen: string;
}

interface AnswerEntry {
  dedupe_key: string;
  rule_id: string;
  rule_series: string; // major.minor — precision series key
  question: Question;
  answer: boolean;
  at: string;
  note?: string;
}

/** Legacy v1 entries (helpful | wrong | not-actionable). */
interface LegacyEntry {
  dedupe_key: string;
  rule_id: string;
  rule_series: string;
  verdict: "helpful" | "wrong" | "not-actionable";
  at: string;
  note?: string;
}

export function dataDir(): string {
  return process.env.DAMAME_DATA_DIR ?? join(homedir(), ".damame");
}

const indexPath = () => join(dataDir(), "findings-index.jsonl");
const feedbackPath = () => join(dataDir(), "feedback.jsonl");

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as T];
      } catch {
        return [];
      }
    });
}

function series(version: string): string {
  return version.split(".").slice(0, 2).join(".");
}

/** All answers, with legacy verdicts mapped onto the question model. */
function readAnswers(): AnswerEntry[] {
  const out: AnswerEntry[] = [];
  for (const raw of readJsonl<AnswerEntry | LegacyEntry>(feedbackPath())) {
    if ("question" in raw) {
      out.push(raw);
      continue;
    }
    const base = { dedupe_key: raw.dedupe_key, rule_id: raw.rule_id, rule_series: raw.rule_series, at: raw.at, ...(raw.note ? { note: raw.note } : {}) };
    if (raw.verdict === "helpful") {
      out.push({ ...base, question: "accurate", answer: true }, { ...base, question: "applicable", answer: true });
    } else if (raw.verdict === "wrong") {
      out.push({ ...base, question: "accurate", answer: false });
    } else {
      out.push({ ...base, question: "applicable", answer: false });
    }
  }
  return out;
}

/** Record emitted findings so later feedback can resolve keys. Idempotent. */
export function indexFindings(session: Session, findings: Finding[], now = new Date()): number {
  if (findings.length === 0) return 0;
  const known = new Set(readJsonl<IndexEntry>(indexPath()).map((e) => e.dedupe_key));
  const fresh = findings.filter((f) => !known.has(f.dedupe_key));
  if (fresh.length === 0) return 0;
  mkdirSync(dataDir(), { recursive: true });
  const lines = fresh
    .map((f) =>
      JSON.stringify({
        dedupe_key: f.dedupe_key,
        rule_id: f.rule.id,
        rule_version: f.rule.version,
        session_id: session.id,
        title: f.title,
        first_seen: now.toISOString(),
      } satisfies IndexEntry),
    )
    .join("\n");
  appendFileSync(indexPath(), lines + "\n");
  return fresh.length;
}

export function readIndex(): Array<{ dedupe_key: string; rule_id: string; rule_version: string; session_id: string; title: string; first_seen: string }> {
  return readJsonl<IndexEntry>(indexPath());
}

export function recordAnswer(
  keyPrefix: string,
  question: Question,
  answer: boolean,
  note?: string,
  now = new Date(),
): { ok: true; rule_id: string; title: string } | { ok: false; error: string } {
  const index = readJsonl<IndexEntry>(indexPath());
  const matches = index.filter((e) => e.dedupe_key.startsWith(keyPrefix));
  if (matches.length === 0) {
    return { ok: false, error: `no indexed finding matches "${keyPrefix}" — analyze the session first; keys appear in each finding's evidence line` };
  }
  const distinct = new Set(matches.map((m) => m.dedupe_key));
  if (distinct.size > 1) {
    return { ok: false, error: `"${keyPrefix}" is ambiguous (${distinct.size} findings) — use more characters of the key` };
  }
  const target = matches[0]!;
  const entry: AnswerEntry = {
    dedupe_key: target.dedupe_key,
    rule_id: target.rule_id,
    rule_series: series(target.rule_version),
    question,
    answer,
    at: now.toISOString(),
    ...(note ? { note } : {}),
  };
  mkdirSync(dataDir(), { recursive: true });
  appendFileSync(feedbackPath(), JSON.stringify(entry) + "\n");
  return { ok: true, rule_id: target.rule_id, title: target.title };
}

export interface AnswerState {
  accurate: boolean | null;
  applicable: boolean | null;
}

/** Latest answer per finding per question (users change their minds; last wins). */
export function lastAnswers(): Map<string, AnswerState> {
  const map = new Map<string, AnswerState>();
  for (const entry of readAnswers()) {
    const state = map.get(entry.dedupe_key) ?? { accurate: null, applicable: null };
    state[entry.question] = entry.answer;
    map.set(entry.dedupe_key, state);
  }
  return map;
}

export interface RuleStats {
  rule_id: string;
  rule_series: string;
  emitted: number;
  accurate_yes: number;
  accurate_no: number;
  applicable_yes: number;
  applicable_no: number;
  /** Factual precision — the core trust metric. */
  factual_precision: number | null;
  applicability_rate: number | null;
}

export function feedbackStats(): RuleStats[] {
  const index = readJsonl<IndexEntry>(indexPath());
  const seriesByKey = new Map(index.map((e) => [e.dedupe_key, `${e.rule_id}@${series(e.rule_version)}`]));

  // last answer per (finding, question) wins
  const last = new Map<string, AnswerEntry>();
  for (const entry of readAnswers()) last.set(`${entry.dedupe_key}|${entry.question}`, entry);

  const byRule = new Map<string, RuleStats>();
  for (const e of index) {
    const key = `${e.rule_id}@${series(e.rule_version)}`;
    const stats =
      byRule.get(key) ??
      ({ rule_id: e.rule_id, rule_series: series(e.rule_version), emitted: 0, accurate_yes: 0, accurate_no: 0, applicable_yes: 0, applicable_no: 0, factual_precision: null, applicability_rate: null } satisfies RuleStats);
    stats.emitted += 1;
    byRule.set(key, stats);
  }
  for (const entry of last.values()) {
    const stats = byRule.get(seriesByKey.get(entry.dedupe_key) ?? `${entry.rule_id}@${entry.rule_series}`);
    if (!stats) continue;
    if (entry.question === "accurate") entry.answer ? (stats.accurate_yes += 1) : (stats.accurate_no += 1);
    else entry.answer ? (stats.applicable_yes += 1) : (stats.applicable_no += 1);
  }
  for (const stats of byRule.values()) {
    const fa = stats.accurate_yes + stats.accurate_no;
    stats.factual_precision = fa > 0 ? stats.accurate_yes / fa : null;
    const ap = stats.applicable_yes + stats.applicable_no;
    stats.applicability_rate = ap > 0 ? stats.applicable_yes / ap : null;
  }
  return [...byRule.values()].sort((a, b) => a.rule_id.localeCompare(b.rule_id));
}
