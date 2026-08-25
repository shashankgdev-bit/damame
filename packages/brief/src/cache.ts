import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseSessionWithChildren } from "@damame/adapter-claude-code";
import { computeMetrics } from "@damame/metrics";
import type { JudgeDriver } from "@damame/judge";
import { buildDigest } from "./digest.js";
import { BRIEF_PROMPT_VERSION, generateBrief, type GeneratedBrief } from "./generate.js";

/**
 * Brief cache: one LLM call per (transcript mtime+size, prompt version);
 * afterwards opening a session is a disk read. Same layout discipline as the
 * profile summary cache.
 */
function cacheDir(): string {
  return join(process.env.DAMAME_DATA_DIR ?? join(homedir(), ".damame"), "cache", "briefs");
}

interface CacheEntry {
  mtime_ms: number;
  size: number;
  prompt_version: string;
  generated: GeneratedBrief;
}

export function cachedBrief(transcriptPath: string): GeneratedBrief | undefined {
  const stat = statSync(transcriptPath);
  const key = createHash("sha256").update(transcriptPath).digest("hex").slice(0, 16);
  const file = join(cacheDir(), `${key}.json`);
  if (!existsSync(file)) return undefined;
  try {
    const cached = JSON.parse(readFileSync(file, "utf8")) as CacheEntry;
    if (
      cached.mtime_ms === stat.mtimeMs &&
      cached.size === stat.size &&
      cached.prompt_version === BRIEF_PROMPT_VERSION
    ) {
      return cached.generated;
    }
  } catch {
    // corrupt entry → regenerate
  }
  return undefined;
}

export async function briefWithCache(transcriptPath: string, driver: JudgeDriver): Promise<GeneratedBrief> {
  const hit = cachedBrief(transcriptPath);
  if (hit) return hit;

  const stat = statSync(transcriptPath);
  const { session } = await parseSessionWithChildren(transcriptPath);
  const metrics = computeMetrics(session);
  const digest = buildDigest(session, metrics);
  const generated = await generateBrief(digest, driver);

  const key = createHash("sha256").update(transcriptPath).digest("hex").slice(0, 16);
  mkdirSync(cacheDir(), { recursive: true });
  writeFileSync(
    join(cacheDir(), `${key}.json`),
    JSON.stringify({
      mtime_ms: stat.mtimeMs,
      size: stat.size,
      prompt_version: BRIEF_PROMPT_VERSION,
      generated,
    } satisfies CacheEntry),
  );
  return generated;
}
