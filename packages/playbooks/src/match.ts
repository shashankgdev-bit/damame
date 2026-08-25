import type { Finding } from "@damame/ir";
import { PlaybookSchema, type Playbook, type PlaybookEntry } from "./schema.js";
import { repetitiveTaskProduction } from "./playbooks/repetitive-task-production.js";

/** All shipped playbooks, schema-validated at load time. */
export const PLAYBOOKS: Playbook[] = [repetitiveTaskProduction].map((p) => PlaybookSchema.parse(p));

export interface MatchedEntry {
  playbook_id: string;
  playbook_name: string;
  entry: PlaybookEntry;
  /** Dedupe keys of the session findings that evidence this entry. */
  finding_keys: string[];
}

export interface PlaybookMatch {
  playbook_id: string;
  playbook_name: string;
  description: string;
  matched_by: Array<"tags" | "signatures">;
  /** Entries whose signature actually fired in THIS session — the only ones rendered as recommendations. */
  evidenced: MatchedEntry[];
  /** The playbook's remaining knowledge — reference only, never a recommendation. */
  unevidenced: PlaybookEntry[];
}

/**
 * A playbook applies to a session via either path:
 * - tags: the LLM brief classified the session with a tag the playbook claims
 *   (exact tag, or a tag containing one of the playbook's keywords);
 * - signatures: ≥2 of the playbook's signature rules fired — a deterministic
 *   quorum that works with no LLM at all.
 * Entries then individually require their evidence to have fired here.
 */
export function matchPlaybooks(useCaseTags: string[], findings: Finding[]): PlaybookMatch[] {
  const tags = useCaseTags.map((t) => t.toLowerCase());
  const byRule = new Map<string, string[]>();
  for (const f of findings) {
    const keys = byRule.get(f.rule.id) ?? [];
    keys.push(f.dedupe_key);
    byRule.set(f.rule.id, keys);
  }

  const out: PlaybookMatch[] = [];
  for (const pb of PLAYBOOKS) {
    const tagHit =
      pb.use_case_tags.some((t) => tags.includes(t)) ||
      tags.some((tag) => pb.match_keywords.some((kw) => tag.includes(kw)));
    const signatureRules = pb.entries.flatMap((e) => (e.evidence.kind === "signature" ? [e.evidence.rule_id] : []));
    const firedRules = new Set(signatureRules.filter((r) => byRule.has(r)));
    const quorumHit = firedRules.size >= 2;
    if (!tagHit && !quorumHit) continue;

    const evidenced: MatchedEntry[] = [];
    const unevidenced: PlaybookEntry[] = [];
    for (const entry of pb.entries) {
      if (entry.evidence.kind === "signature" && byRule.has(entry.evidence.rule_id)) {
        evidenced.push({
          playbook_id: pb.id,
          playbook_name: pb.name,
          entry,
          finding_keys: byRule.get(entry.evidence.rule_id)!,
        });
      } else {
        unevidenced.push(entry);
      }
    }
    if (evidenced.length === 0) continue; // nothing evidenced → nothing to recommend

    const matched_by: Array<"tags" | "signatures"> = [];
    if (tagHit) matched_by.push("tags");
    if (quorumHit) matched_by.push("signatures");
    out.push({
      playbook_id: pb.id,
      playbook_name: pb.name,
      description: pb.description,
      matched_by,
      evidenced,
      unevidenced,
    });
  }
  return out;
}
