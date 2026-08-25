import { z } from "zod";

/**
 * A playbook is curated, pre-verified knowledge about one KIND of session —
 * known mistakes and their fixes. Entries are never invented at analysis
 * time: they are authored here (in the open repo — provenance is public),
 * and a session only ever sees an entry whose evidence actually fired in
 * THAT session (opportunity honesty). Entries without a deterministic
 * signature stay `unevidenced` and are rendered only as an optional
 * "more in this playbook" reference, never as a recommendation.
 */
export const PlaybookEntrySchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  title: z.string(),
  /** What usually goes wrong, in plain language. */
  mistake: z.string(),
  /** What to do instead. */
  fix: z.string(),
  rationale: z.string(),
  /**
   * signature: entry renders only when this rule fired in the session.
   * narrative: no deterministic detector exists yet — never auto-recommended.
   */
  evidence: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("signature"), rule_id: z.string() }),
    z.object({ kind: z.literal("narrative") }),
  ]),
  verified_by: z.enum(["corpus", "recurrence", "manual"]),
  status: z.enum(["active", "candidate"]),
});
export type PlaybookEntry = z.infer<typeof PlaybookEntrySchema>;

export const PlaybookSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  name: z.string(),
  description: z.string(),
  /** Exact brief use_case_tags this playbook claims. */
  use_case_tags: z.array(z.string()).min(1),
  /** Substring keywords: any brief tag containing one of these also matches. */
  match_keywords: z.array(z.string()).min(1),
  /** Where this playbook's knowledge came from (public provenance). */
  source: z.string(),
  version: z.string(),
  entries: z.array(PlaybookEntrySchema).min(1),
});
export type Playbook = z.infer<typeof PlaybookSchema>;
