import { ENTRIES } from "./entries.js";
import { RegistryEntrySchema, type RegistryEntry } from "./schema.js";

export * from "./schema.js";

/** All shipped entries, schema-validated at load time. */
export const REGISTRY: RegistryEntry[] = ENTRIES.map((e) => RegistryEntrySchema.parse(e));

const byId = new Map(REGISTRY.map((e) => [e.id, e]));

/** Recommendation refs that intentionally have no recipe (nothing to do). */
export const NO_ACTION_REFS = new Set(["no-user-action", "none-required"]);

/**
 * Resolve a finding recommendation (kind + ref) to a shelf entry.
 * Direct ids resolve as-is; subagent/skill refs are dynamic (the agent type or
 * skill name observed in the session) and fall back to generic entries.
 */
export function entryFor(kind: string, ref: string): RegistryEntry | undefined {
  const direct = byId.get(ref);
  if (direct) return direct;
  if (kind === "subagent") return byId.get(`subagent-${ref.toLowerCase()}`) ?? byId.get("custom-subagents");
  if (kind === "skill") return byId.get(`skill-${ref.toLowerCase()}`) ?? byId.get("using-skills");
  return undefined;
}
