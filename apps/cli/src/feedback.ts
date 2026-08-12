import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Finding, Session } from "@damame/ir";

/**
 * The local feedback loop — the seed of per-rule precision tracking.
 *
 * `analyze` appends every emitted finding to a local index (keyed by
 * dedupe_key, so re-analyzing the same session is idempotent). The user can
 * then record a verdict per finding. Verdicts join findings on
 * (dedupe_key, rule id, rule major.minor) — a threshold change bumps the rule
 * version and starts a fresh precision series, exactly as the validation plan
 * specifies. Everything stays on disk under ~/.damame; nothing is uploaded.
 */

export type Verdict = "helpful" | "wrong" | "not-actionable";
export const VERDICTS: Verdict[] = ["helpful", "wrong", "not-actionable"];

interface IndexEntry {
  dedupe_key: string;
  rule_id: string;
  rule_version: string;
  session_id: string;
  title: string;
  first_seen: string;
}

interface FeedbackEntry {
  dedupe_key: string;
  rule_id: string;
  rule_series: string; // major.minor — precision series key
  verdict: Verdict;
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

/** major.minor of a semver string — the precision-series key. */
function series(version: string): string {
  return version.split(".").slice(0, 2).join(".");
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

export function recordFeedback(
  keyPrefix: string,
  verdict: Verdict,
  note?: string,
  now = new Date(),
): { ok: true; entry: FeedbackEntry; title: string } | { ok: false; error: string } {
  const index = readJsonl<IndexEntry>(indexPath());
  const matches = index.filter((e) => e.dedupe_key.startsWith(keyPrefix));
  if (matches.length === 0) {
    return { ok: false, error: `no indexed finding matches "${keyPrefix}" — run \`damame analyze\` first; keys are printed in each finding's evidence line` };
  }
  const distinct = new Set(matches.map((m) => m.dedupe_key));
  if (distinct.size > 1) {
    return { ok: false, error: `"${keyPrefix}" is ambiguous (${distinct.size} findings) — use more characters of the key` };
  }
  const target = matches[0]!;
  const entry: FeedbackEntry = {
    dedupe_key: target.dedupe_key,
    rule_id: target.rule_id,
    rule_series: series(target.rule_version),
    verdict,
    at: now.toISOString(),
    ...(note ? { note } : {}),
  };
  mkdirSync(dataDir(), { recursive: true });
  appendFileSync(feedbackPath(), JSON.stringify(entry) + "\n");
  return { ok: true, entry, title: target.title };
}

export interface RuleStats {
  rule_id: string;
  rule_series: string;
  helpful: number;
  wrong: number;
  not_actionable: number;
  /** helpful / (helpful + wrong); not-actionable is excluded from precision. */
  precision: number | null;
  emitted: number;
}

export function feedbackStats(): RuleStats[] {
  const index = readJsonl<IndexEntry>(indexPath());
  const feedback = readJsonl<FeedbackEntry>(feedbackPath());

  // Last verdict per finding wins (users change their minds).
  const lastVerdict = new Map<string, FeedbackEntry>();
  for (const entry of feedback) lastVerdict.set(entry.dedupe_key, entry);

  const byRule = new Map<string, RuleStats>();
  for (const e of index) {
    const key = `${e.rule_id}@${series(e.rule_version)}`;
    const stats =
      byRule.get(key) ??
      ({ rule_id: e.rule_id, rule_series: series(e.rule_version), helpful: 0, wrong: 0, not_actionable: 0, precision: null, emitted: 0 } satisfies RuleStats);
    stats.emitted += 1;
    byRule.set(key, stats);
  }
  for (const entry of lastVerdict.values()) {
    const stats = byRule.get(`${entry.rule_id}@${entry.rule_series}`);
    if (!stats) continue;
    if (entry.verdict === "helpful") stats.helpful += 1;
    else if (entry.verdict === "wrong") stats.wrong += 1;
    else stats.not_actionable += 1;
  }
  for (const stats of byRule.values()) {
    const judged = stats.helpful + stats.wrong;
    stats.precision = judged > 0 ? stats.helpful / judged : null;
  }
  return [...byRule.values()].sort((a, b) => a.rule_id.localeCompare(b.rule_id));
}
