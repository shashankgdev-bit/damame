import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { discoverSessions, parseSessionWithChildren } from "@damame/adapter-claude-code";
import { computeMetrics } from "@damame/metrics";
import { runRules } from "@damame/rules";
import { computeScore } from "@damame/score";
import { detectTechniques } from "@damame/profile";
import { computeRecurrence } from "./recurrence.js";
import { dataDir } from "./feedback.js";

/**
 * `damame export` — the stable machine-readable dump that downstream
 * consumers (damame-py, spreadsheets, CI) build on. Everything here is
 * derived from local analysis; the schema is versioned and additive-only:
 * fields may be added under the same export_schema, never renamed/removed
 * without bumping it.
 */
export const EXPORT_SCHEMA = 1;

export async function runExport(opts: { out?: string; root?: string }, damameVersion: string): Promise<void> {
  const sessions = await discoverSessions(opts.root);
  const rows: unknown[] = [];
  for (const s of sessions) {
    process.stderr.write(`analyzing ${s.sessionId.slice(0, 8)} (${(s.sizeBytes / 1e6).toFixed(0)}MB)…\n`);
    try {
      const { session } = await parseSessionWithChildren(s.path);
      const metrics = computeMetrics(session);
      const findings = runRules(session, metrics);
      const fresh =
        (metrics.totals.usage.input_tokens ?? 0) +
        (metrics.totals.usage.output_tokens ?? 0) +
        (metrics.totals.usage.cache_creation_input_tokens ?? 0);
      const score = computeScore(findings, fresh, detectTechniques(session, metrics));
      rows.push({
        id: session.id,
        project: session.project?.cwd ?? null,
        started_at: session.started_at ?? null,
        ended_at: session.ended_at ?? null,
        totals: {
          tokens: metrics.totals.total_tokens,
          fresh_tokens: fresh,
          input_tokens: metrics.totals.usage.input_tokens ?? 0,
          output_tokens: metrics.totals.usage.output_tokens ?? 0,
          cache_read_tokens: metrics.totals.usage.cache_read_input_tokens ?? 0,
          cache_creation_tokens: metrics.totals.usage.cache_creation_input_tokens ?? 0,
          turns: metrics.totals.turn_count,
          human_turns: metrics.totals.human_turn_count,
          tool_calls: metrics.totals.tool_call_count,
          tool_errors: metrics.totals.tool_error_count,
          compactions: metrics.compactions.length,
          subagent_runs: metrics.subagent_runs.length,
        },
        score: {
          version: score.version,
          overall: score.overall,
          buckets: score.buckets.map((b) => ({ id: b.id, score: b.score })),
          capabilities_exercised: score.capabilities.exercised,
        },
        findings: findings.map((f) => ({
          rule_id: f.rule.id,
          rule_version: f.rule.version,
          category: f.category,
          severity: f.severity,
          title: f.title,
          dedupe_key: f.dedupe_key,
          savings_tokens: f.savings?.tokens?.value ?? null,
          savings_ms: f.savings?.wall_clock_ms?.value ?? null,
          savings_basis: f.savings?.basis ?? null,
        })),
        techniques: detectTechniques(session, metrics),
      });
    } catch (error) {
      process.stderr.write(`  skipped (${String(error).slice(0, 120)})\n`);
    }
  }

  // Raw feedback log: every answer with its timestamp, for precision-over-time.
  const fbPath = join(dataDir(), "feedback.jsonl");
  const feedback = existsSync(fbPath)
    ? readFileSync(fbPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line) as unknown;
          } catch {
            return null;
          }
        })
        .filter(Boolean)
    : [];

  const out = {
    export_schema: EXPORT_SCHEMA,
    damame_version: damameVersion,
    exported_at: new Date().toISOString(),
    sessions: rows,
    feedback,
    recurrence: await computeRecurrence(sessions),
  };

  const text = JSON.stringify(out, null, 2);
  if (opts.out) {
    writeFileSync(opts.out, text);
    process.stderr.write(`wrote ${opts.out} (${(text.length / 1024).toFixed(0)}KB, ${rows.length} sessions)\n`);
  } else {
    process.stdout.write(text + "\n");
  }
}
