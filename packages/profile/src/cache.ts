import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseSessionWithChildren } from "@damame/adapter-claude-code";
import { computeMetrics } from "@damame/metrics";
import { runRules } from "@damame/rules";
import { summarizeSession, type SessionSummary } from "./summarize.js";

/**
 * Per-session summary cache: a transcript is fully parsed once per (mtime,
 * size); afterwards the profile reads a ~1KB summary. Keeps `damame profile`
 * instant even over hundreds of sessions including 200MB+ files.
 */
function cacheDir(): string {
  return join(process.env.DAMAME_DATA_DIR ?? join(homedir(), ".damame"), "cache", "summaries");
}

interface CacheEntry {
  mtime_ms: number;
  size: number;
  summary: SessionSummary;
}

export async function summarizeWithCache(transcriptPath: string): Promise<SessionSummary> {
  const stat = statSync(transcriptPath);
  const key = createHash("sha256").update(transcriptPath).digest("hex").slice(0, 16);
  const file = join(cacheDir(), `${key}.json`);

  if (existsSync(file)) {
    try {
      const cached = JSON.parse(readFileSync(file, "utf8")) as CacheEntry;
      if (cached.mtime_ms === stat.mtimeMs && cached.size === stat.size && cached.summary?.schema === 3) {
        return cached.summary;
      }
    } catch {
      // corrupt cache entry → recompute
    }
  }

  const { session } = await parseSessionWithChildren(transcriptPath);
  const metrics = computeMetrics(session);
  const findings = runRules(session, metrics);
  const summary = summarizeSession(session, metrics, findings);
  summary.path = transcriptPath;

  mkdirSync(cacheDir(), { recursive: true });
  writeFileSync(file, JSON.stringify({ mtime_ms: stat.mtimeMs, size: stat.size, summary } satisfies CacheEntry));
  return summary;
}
