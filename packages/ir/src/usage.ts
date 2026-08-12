import { z } from "zod";

/**
 * Token usage attached to an assistant message, a turn rollup, or a session total.
 *
 * All count fields are optional because several sources (Cursor, Aider) supply
 * none of them. `attribution` is required whenever a Usage object exists:
 *  - "measured": copied verbatim from the source's own usage record
 *  - "aggregated": summed from measured child records (turn/session rollups)
 *  - "estimated": derived (e.g. bytes/4); never mixed silently with measured
 */
export const UsageSchema = z.object({
  input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative().optional(),
  cache_read_input_tokens: z.number().int().nonnegative().optional(),
  cache_creation_input_tokens: z.number().int().nonnegative().optional(),
  cache_creation: z
    .object({
      ephemeral_1h: z.number().int().nonnegative().optional(),
      ephemeral_5m: z.number().int().nonnegative().optional(),
    })
    .optional(),
  attribution: z.enum(["measured", "aggregated", "estimated"]),
});

export type Usage = z.infer<typeof UsageSchema>;

export function emptyAggregatedUsage(): Usage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    attribution: "aggregated",
  };
}

/** Sum `b` into `a` (mutating `a`), treating missing fields as 0. */
export function addUsage(a: Usage, b: Usage | undefined): Usage {
  if (!b) return a;
  a.input_tokens = (a.input_tokens ?? 0) + (b.input_tokens ?? 0);
  a.output_tokens = (a.output_tokens ?? 0) + (b.output_tokens ?? 0);
  a.cache_read_input_tokens = (a.cache_read_input_tokens ?? 0) + (b.cache_read_input_tokens ?? 0);
  a.cache_creation_input_tokens =
    (a.cache_creation_input_tokens ?? 0) + (b.cache_creation_input_tokens ?? 0);
  return a;
}

export function totalTokens(u: Usage | undefined): number {
  if (!u) return 0;
  return (
    (u.input_tokens ?? 0) +
    (u.output_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0)
  );
}
