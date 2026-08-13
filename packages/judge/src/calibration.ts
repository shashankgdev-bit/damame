import { readAudits, type AuditRecord } from "./audit.js";

/**
 * The auditor is itself on trial. Two accuracy signals, one label-free and one
 * nearly free:
 *  - honeypot catch-rate: refutation rate on findings wrong by construction
 *  - human agreement: where both the user and auditor answered the same
 *    finding+question, how often they match (per rule)
 * Both are keyed by (model, prompt_version): changing either starts a fresh
 * series, exactly like rule versioning.
 */
export interface AuditorHealth {
  series: string; // "<model>@<prompt_version>"
  audits: number;
  honeypots_total: number;
  honeypots_caught: number;
  honeypot_catch_rate: number | null;
  abstention_rate: number;
  escalation_rate: number;
  invalid_run_rate: number;
}

export interface RuleAgreement {
  rule_id: string;
  compared_questions: number;
  agreed_questions: number;
  agreement_rate: number | null;
}

export function auditorHealth(): AuditorHealth[] {
  const bySeries = new Map<string, AuditRecord[]>();
  for (const record of readAudits()) {
    const key = `${record.model}@${record.prompt_version}`;
    const list = bySeries.get(key) ?? [];
    list.push(record);
    bySeries.set(key, list);
  }
  return [...bySeries.entries()].map(([series, records]) => {
    const honeypots = records.filter((r) => r.honeypot);
    const caught = honeypots.filter((r) => r.accurate.answer === false).length;
    const abstained = records.filter((r) => r.accurate.answer === null || r.applicable.answer === null).length;
    const allRuns = records.flatMap((r) => r.runs);
    return {
      series,
      audits: records.length,
      honeypots_total: honeypots.length,
      honeypots_caught: caught,
      honeypot_catch_rate: honeypots.length > 0 ? caught / honeypots.length : null,
      abstention_rate: records.length > 0 ? abstained / records.length : 0,
      escalation_rate: records.length > 0 ? records.filter((r) => r.escalated).length / records.length : 0,
      invalid_run_rate: allRuns.length > 0 ? allRuns.filter((r) => !r.valid).length / allRuns.length : 0,
    };
  });
}

export function humanAgreement(
  humanAnswers: Map<string, { accurate: boolean | null; applicable: boolean | null }>,
): RuleAgreement[] {
  const latest = new Map<string, AuditRecord>();
  for (const record of readAudits()) {
    if (!record.honeypot) latest.set(record.dedupe_key, record);
  }
  const byRule = new Map<string, RuleAgreement>();
  for (const audit of latest.values()) {
    const human = humanAnswers.get(audit.dedupe_key);
    if (!human) continue;
    const row =
      byRule.get(audit.rule_id) ??
      byRule
        .set(audit.rule_id, { rule_id: audit.rule_id, compared_questions: 0, agreed_questions: 0, agreement_rate: null })
        .get(audit.rule_id)!;
    for (const question of ["accurate", "applicable"] as const) {
      if (human[question] !== null && audit[question].answer !== null) {
        row.compared_questions += 1;
        if (human[question] === audit[question].answer) row.agreed_questions += 1;
      }
    }
  }
  for (const row of byRule.values()) {
    row.agreement_rate = row.compared_questions > 0 ? row.agreed_questions / row.compared_questions : null;
  }
  return [...byRule.values()].sort((a, b) => a.rule_id.localeCompare(b.rule_id));
}
