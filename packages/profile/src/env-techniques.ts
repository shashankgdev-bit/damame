import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EnvProbeResult } from "./aggregate.js";

/**
 * Environment-derived technique probes — configuration that lives on disk,
 * not in transcripts (hooks, CLAUDE.md, permission allowlists). Read-only,
 * probed once at profile time; provenance is "environment" so the UI can say
 * "from your current config" rather than implying transcript evidence.
 */
export function probeEnvironment(sessionCwds: string[], home = homedir()): EnvProbeResult {
  const techniques: Record<string, boolean> = {};

  const settingsFiles = [
    join(home, ".claude", "settings.json"),
    join(home, ".claude", "settings.local.json"),
    ...sessionCwds.flatMap((cwd) => [join(cwd, ".claude", "settings.json"), join(cwd, ".claude", "settings.local.json")]),
  ];

  let hooks = false;
  let allowlists = false;
  for (const file of settingsFiles) {
    try {
      if (!existsSync(file)) continue;
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (parsed.hooks && Object.keys(parsed.hooks).length > 0) hooks = true;
      if (Array.isArray(parsed.permissions?.allow) && parsed.permissions.allow.length > 0) allowlists = true;
    } catch {
      // unreadable/malformed settings are not the user's profile problem
    }
  }
  techniques["hooks"] = hooks;
  techniques["permission-allowlists"] = allowlists;

  techniques["claude-md"] = [join(home, ".claude", "CLAUDE.md"), ...sessionCwds.map((cwd) => join(cwd, "CLAUDE.md"))].some(
    (p) => {
      try {
        return existsSync(p);
      } catch {
        return false;
      }
    },
  );

  return { techniques };
}
