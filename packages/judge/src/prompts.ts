/**
 * Versioned prompt templates. The template text is part of the published
 * methodology (docs/judge.md); any change bumps PROMPT_VERSION and starts a
 * fresh calibration series, exactly like a rule version bump.
 */
export const PROMPT_VERSION = "audit@1";

export interface AuditCase {
  title: string;
  description: string;
  savings_line: string | null;
  recommendation: string;
  rule_id: string;
  rule_definition: string;
  excerpts: string;
}

export function auditPrompt(c: AuditCase): string {
  return `You are an adversarial auditor for damame, a tool that analyzes AI coding-session transcripts. A detector produced the CLAIM below. Your job is to try to PROVE IT WRONG using only the EVIDENCE excerpts. Be skeptical: if the evidence does not clearly support a part of the claim, answer false for it.

CLAIM (finding "${c.rule_id}"):
Title: ${c.title}
Description: ${c.description}
${c.savings_line ? `Claimed cost: ${c.savings_line}` : ""}
Recommendation: ${c.recommendation}

RULE DEFINITION (what this detector is supposed to fire on):
${c.rule_definition}

EVIDENCE (the only material you may rely on — numbered transcript excerpts):
${c.excerpts}

Answer with STRICT JSON only — no markdown fences, no prose outside the JSON:
{"accurate": <bool>, "applicable": <bool>, "quotes": ["..."], "reasoning": "..."}

Definitions:
- "accurate": true only if the excerpts clearly show the events the claim describes (right kind, right target, plausible counts). If the evidence is unrelated, contradicts the claim, or is insufficient — false.
- "applicable": true only if the recommendation would have actually fit the situation shown in the evidence. If the recommendation is irrelevant to what happened — false.
- "quotes": 1-4 VERBATIM substrings copied character-for-character from the EVIDENCE section that your verdict rests on. They are checked mechanically; a quote that does not appear in the evidence invalidates your entire answer.
- "reasoning": 1-3 sentences.
- When uncertain, answer false. An unsupported claim must not pass.`;
}
