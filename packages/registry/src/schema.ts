import { z } from "zod";

/**
 * The resource registry is damame's recipe shelf: every concrete thing the
 * tool can point a user at, written so a person who has never heard the term
 * can follow it. Entries are DATA with public provenance — where the recipe
 * came from and whether it has been verified — so the shelf can later grow
 * from community submissions without diluting the `verified` badge.
 *
 * The honesty rule lives elsewhere: nothing on this shelf is ever PUSHED at
 * a user without a fired detector pointing to it. The whole shelf is always
 * BROWSABLE (the library view) — pulling is allowed, pushing needs evidence.
 */
export const RegistryEntrySchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  kind: z.enum(["config", "pattern", "mcp", "skill", "subagent", "script", "workflow"]),
  title: z.string(),
  /** One or two plain-language sentences: what this thing IS. */
  what_it_is: z.string(),
  /** Literal steps a beginner can follow. */
  how_to: z.array(z.string()).min(1).max(8),
  /** Optional caveats/extras. */
  notes: z.string().optional(),
  /** Rule ids whose recommendations resolve to this entry (informational). */
  applies_to: z.array(z.string()),
  /** Where this recipe came from (public provenance). */
  source: z.string(),
  status: z.enum(["verified", "candidate"]),
  /** How it was verified — required when status is "verified". */
  verified_by: z.string().optional(),
});
export type RegistryEntry = z.infer<typeof RegistryEntrySchema>;
