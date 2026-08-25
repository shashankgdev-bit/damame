import { z } from "zod";
import type { JudgeDriver } from "@damame/judge";
import { renderDigest, type SessionDigest } from "./digest.js";

export const BRIEF_PROMPT_VERSION = "brief@5";

/** The Claude Code mechanisms a story beat may credit — fixed vocabulary so
 * the UI can attach a glossary explanation to each. */
export const CAPABILITIES = [
  "agentic-loop",
  "subagents",
  "workflows",
  "state-files",
  "scheduling",
  "compaction",
  "web-access",
  "none",
] as const;

/**
 * A brief claim must cite digest item ids. The schema demands ≥1 ref per
 * claim; the faithfulness gate then verifies each ref actually exists in the
 * digest — a claim whose every citation is fabricated is dropped outright.
 */
const ClaimSchema = z.object({
  text: z.string().min(1).max(700),
  refs: z.array(z.string()).min(1).max(8),
});
export type BriefClaim = z.infer<typeof ClaimSchema>;

/** One story beat: a one-liner anyone can read, with depth underneath. */
const BeatSchema = z.object({
  one_liner: z.string().min(1).max(140),
  detail: z.string().min(1).max(600),
  capability: z.enum(CAPABILITIES),
  refs: z.array(z.string()).min(1).max(8),
});
export type StoryBeat = z.infer<typeof BeatSchema>;

export const BriefSchema = z.object({
  what_this_was: z.array(ClaimSchema).min(1).max(3),
  story: z.array(BeatSchema).min(2).max(9),
  working_pattern: z.array(ClaimSchema).min(1).max(5),
  how_claude_worked: z.array(ClaimSchema).min(1).max(5),
  use_case_tags: z
    .array(z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/))
    .min(1)
    .max(3),
});
export type Brief = z.infer<typeof BriefSchema>;

export interface GeneratedBrief {
  brief: Brief;
  prompt_version: string;
  model: string;
  /** Claims removed because every ref they cited does not exist in the digest. */
  dropped_claims: number;
  /** True when the gate removed a meaningful share — render with a caution banner. */
  degraded: boolean;
  /** The exact digest the claims cite — kept so refs stay resolvable in the UI. */
  digest: SessionDigest;
}

export function buildBriefPrompt(digest: SessionDigest): string {
  return [
    "You are writing a short factual brief about an AI coding session, addressed to its owner.",
    "The reader IS the person who ran this session: address them directly as \"you\" — never \"the user\", never third person.",
    '(e.g. "You asked Claude to work overnight", not "The user asked Claude to work overnight".)',
    "You are given a DIGEST of the session transcript — sampled user prompts, measured statistics, and touched files.",
    "You never saw the full transcript. Claim ONLY what the digest supports.",
    "",
    "Every claim object must cite the digest item ids it relies on in `refs` (e.g. [\"p3\",\"s1\"]).",
    "A claim you cannot back with specific items must not be written.",
    "Plain language for a non-expert; concrete over generic; no praise, no filler.",
    "Keep each claim's text under 500 characters. Do not confuse distinct stats (e.g. compaction count vs resume count).",
    "",
    "Respond with ONLY a JSON object, no markdown fences, in exactly this shape:",
    "{",
    '  "what_this_was": [{"text": "1-3 sentences on what this session/project is about", "refs": ["p1"]}],',
    '  "story": [{"one_liner": "...", "detail": "...", "capability": "...", "refs": ["p2","s1"]}],',
    '  "working_pattern": [{"text": "one observation about HOW the human and Claude worked (the loop, who did what)", "refs": ["s1"]}],',
    '  "how_claude_worked": [{"text": "one observation about the mechanics (tools, delegation, compactions, state files)", "refs": ["s2"]}],',
    '  "use_case_tags": ["kebab-case-use-case"]',
    "}",
    "",
    "story: the JOURNEY as 2-9 milestone beats — the chapters of the work, not incidents.",
    "Each beat is a major movement in the arc: how the work began; the approach or system that got established;",
    "how it scaled, pivoted, or automated; and — always as the final beat — where things ended up (what was",
    "delivered, achieved, or left in progress). One failing run, one config problem, or one review comment is",
    "NEVER its own beat unless the whole project changed direction because of it; fold small events into the",
    "milestone they belong to. Each beat:",
    '- one_liner (max 130 chars): milestone phrasing ("You and Claude set up X", "The work scaled to Y", "By the end, Z was delivered"). Plain words.',
    "- detail (1-3 sentences): the concrete substance of that chapter, with numbers from the digest where they exist.",
    '- capability: which Claude Code mechanism made this beat work — exactly one of: "agentic-loop" (write→run→fix cycles with tools), "subagents" (delegated helper Claudes), "workflows" (scripted multi-agent fan-outs), "state-files" (memory kept in project files), "scheduling" (self-scheduled/overnight work), "compaction" (context-limit summarization events), "web-access" (search/fetch), "none".',
    "- refs: the digest items the beat rests on, like every other claim.",
    "",
    "use_case_tags: 1-3 tags naming the kind of work (e.g. web-app-development, repetitive-task-production, data-analysis, research-writing, infra-ops).",
    "",
    "DIGEST:",
    renderDigest(digest),
  ].join("\n");
}

/** Strip accidental code fences and parse. */
export function parseBriefJson(raw: string): unknown {
  const text = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON object in response");
  return JSON.parse(text.slice(start, end + 1));
}

/**
 * Mechanical faithfulness gate: refs that don't exist in the digest are
 * removed; a claim left with zero valid refs is dropped. No judgment involved.
 */
export function applyFaithfulnessGate(
  brief: Brief,
  digest: SessionDigest,
): { brief: Brief; dropped: number } {
  const valid = new Set(digest.items.map((i) => i.id));
  let dropped = 0;
  const gateSection = (claims: BriefClaim[]): BriefClaim[] => {
    const kept: BriefClaim[] = [];
    for (const claim of claims) {
      const refs = claim.refs.filter((r) => valid.has(r));
      if (refs.length === 0) {
        dropped++;
        continue;
      }
      kept.push({ text: claim.text, refs });
    }
    return kept;
  };
  const gateBeats = (beats: StoryBeat[]): StoryBeat[] => {
    const kept: StoryBeat[] = [];
    for (const beat of beats) {
      const refs = beat.refs.filter((r) => valid.has(r));
      if (refs.length === 0) {
        dropped++;
        continue;
      }
      kept.push({ ...beat, refs });
    }
    return kept;
  };
  const gated = {
    what_this_was: gateSection(brief.what_this_was),
    story: gateBeats(brief.story),
    working_pattern: gateSection(brief.working_pattern),
    how_claude_worked: gateSection(brief.how_claude_worked),
    use_case_tags: brief.use_case_tags,
  };
  return { brief: gated as Brief, dropped };
}

export async function generateBrief(digest: SessionDigest, driver: JudgeDriver): Promise<GeneratedBrief> {
  const prompt = buildBriefPrompt(digest);
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await driver.run(prompt);
      const parsed = BriefSchema.parse(parseBriefJson(raw));
      const total =
        parsed.what_this_was.length +
        parsed.story.length +
        parsed.working_pattern.length +
        parsed.how_claude_worked.length;
      const { brief, dropped } = applyFaithfulnessGate(parsed, digest);
      const emptySection =
        brief.what_this_was.length === 0 ||
        brief.story.length === 0 ||
        brief.working_pattern.length === 0 ||
        brief.how_claude_worked.length === 0;
      return {
        brief,
        prompt_version: BRIEF_PROMPT_VERSION,
        model: driver.model,
        dropped_claims: dropped,
        degraded: emptySection || dropped / Math.max(total, 1) > 0.25,
        digest,
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`brief generation failed after retry: ${String(lastError)}`);
}
