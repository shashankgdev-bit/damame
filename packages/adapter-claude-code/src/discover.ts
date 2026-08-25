import { existsSync } from "node:fs";
import { readdir, stat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Session } from "@damame/ir";
import { addUsage, emptyAggregatedUsage } from "@damame/ir";
import { parseTranscriptFile } from "./parse.js";

export function defaultProjectsRoot(): string {
  return join(homedir(), ".claude", "projects");
}

export interface SessionCandidate {
  path: string;
  sessionId: string;
  projectDir: string;
  sizeBytes: number;
  modifiedAt: Date;
}

/** List transcript files, newest first. `scope` may be a project dir name or absolute path. */
export async function discoverSessions(root = defaultProjectsRoot(), scope?: string): Promise<SessionCandidate[]> {
  const out: SessionCandidate[] = [];
  if (!existsSync(root)) return out;
  const projectDirs = await readdir(root, { withFileTypes: true });
  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue;
    if (scope && dir.name !== scope && join(root, dir.name) !== scope) continue;
    const projectPath = join(root, dir.name);
    let entries;
    try {
      entries = await readdir(projectPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const filePath = join(projectPath, entry.name);
      const info = await stat(filePath);
      out.push({
        path: filePath,
        sessionId: basename(entry.name, ".jsonl"),
        projectDir: dir.name,
        sizeBytes: info.size,
        modifiedAt: info.mtime,
      });
    }
  }
  return out.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
}

export interface AnalyzedSession {
  session: Session;
  children: Session[];
}

/**
 * Parse a main transcript plus its subagent transcripts (both direct Agent
 * spawns and workflow step agents), rolling child usage into the parent's
 * subagent_run events.
 */
export async function parseSessionWithChildren(transcriptPath: string): Promise<AnalyzedSession> {
  const { session } = await parseTranscriptFile(transcriptPath);
  const sessionDir = transcriptPath.replace(/\.jsonl$/, "");
  const children: Session[] = [];

  const subagentsDir = join(sessionDir, "subagents");
  if (existsSync(subagentsDir)) {
    await ingestSubagentDir(subagentsDir, session, children);
    const workflowsDir = join(subagentsDir, "workflows");
    if (existsSync(workflowsDir)) {
      for (const entry of await readdir(workflowsDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          // The directory name IS the workflow runId — the only place the
          // link between a Workflow spawn (child_ref = runId) and its step
          // agents is recorded on disk.
          await ingestSubagentDir(join(workflowsDir, entry.name), session, children, entry.name);
        }
      }
    }
  }

  // Roll deduped child usage into the matching subagent_run events. Direct
  // Agent spawns match one child by agent_id; Workflow spawns carry the runId
  // as child_ref and own every step agent ingested under that run directory.
  const childByRef = new Map(children.map((c) => [c.metadata?.agent_id as string | undefined, c]));
  const childrenByRunId = new Map<string, Session[]>();
  for (const c of children) {
    const runId = c.metadata?.workflow_run_id as string | undefined;
    if (!runId) continue;
    const group = childrenByRunId.get(runId) ?? [];
    group.push(c);
    childrenByRunId.set(runId, group);
  }
  for (const event of session.events) {
    if (event.kind !== "subagent_run" || !event.child_ref) continue;
    const child = childByRef.get(event.child_ref);
    if (child?.usage_totals) {
      event.usage = child.usage_totals;
      continue;
    }
    const group = childrenByRunId.get(event.child_ref);
    if (group?.length) {
      event.usage = group.reduce((sum, c) => addUsage(sum, c.usage_totals), emptyAggregatedUsage());
    }
  }
  return { session, children };
}

async function ingestSubagentDir(
  dir: string,
  parent: Session,
  children: Session[],
  workflowRunId?: string,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith("agent-") || !entry.name.endsWith(".jsonl")) continue;
    const agentId = entry.name.slice("agent-".length, -".jsonl".length);
    const filePath = join(dir, entry.name);

    let agentType: string | undefined;
    let spawnToolUseId: string | undefined;
    let spawnDepth: number | undefined;
    const metaPath = join(dir, `agent-${agentId}.meta.json`);
    if (existsSync(metaPath)) {
      try {
        const meta = JSON.parse(await readFile(metaPath, "utf8"));
        agentType = typeof meta.agentType === "string" ? meta.agentType : undefined;
        spawnToolUseId = typeof meta.toolUseId === "string" ? meta.toolUseId : undefined;
        spawnDepth = typeof meta.spawnDepth === "number" ? meta.spawnDepth : undefined;
      } catch {
        // meta is best-effort
      }
    }

    try {
      const { session: child } = await parseTranscriptFile(filePath, {
        sessionIdOverride: `${parent.id}/agent-${agentId}`,
        parent: {
          session_id: parent.id,
          ...(spawnToolUseId ? { spawn_tool_use_id: spawnToolUseId } : {}),
          ...(agentType ? { agent_type: agentType } : {}),
          ...(spawnDepth !== undefined ? { spawn_depth: spawnDepth } : {}),
        },
      });
      child.metadata = {
        ...child.metadata,
        agent_id: agentId,
        ...(workflowRunId ? { workflow_run_id: workflowRunId } : {}),
      };
      children.push(child);
    } catch {
      // A corrupt child transcript must not fail the main analysis.
    }
  }
}

/** Deduped usage across a session and its children. */
export function combinedUsage(analyzed: AnalyzedSession) {
  const total = emptyAggregatedUsage();
  addUsage(total, analyzed.session.usage_totals);
  for (const child of analyzed.children) addUsage(total, child.usage_totals);
  return total;
}
