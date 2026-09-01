import type { Finding, Session } from "@damame/ir";
import { REGISTRY } from "@damame/registry";

/**
 * The three-surface reshaping of a session's findings — the functional half
 * of the frontend restructure ("the engine proves, the agent fixes, the
 * coach upgrades"):
 *
 *  - fixes[]     Tier 1: machine-applicable items (hooks, config, settings).
 *                Destined for the fix agent; presented as one batch.
 *  - coach[]     Tier 2: human-adoptable capability upgrades — root-cause
 *                grouped (one card carries votes from several detectors),
 *                headlined in impact currency, provenance-stamped, top-3.
 *  - receipts[]  Every non-infra finding as a receipt row: currency-tagged,
 *                tokens demoted to the proof line, prompt-at-the-scene
 *                where derivable.
 *  - not_yours[] Infra findings, structurally separate.
 *
 * All copy here is FROZEN TEMPLATE TEXT with measured numbers interpolated —
 * written and reviewed at development time like any other code. No model
 * runs at view time. (The one runtime-LLM text in the product remains the
 * brief, behind its citation gate.)
 */

export type Impact = "quality" | "time" | "limits";

/** Which currency each rule's harm is actually denominated in. */
const RULE_IMPACT: Record<string, Impact> = {
  "cache-thrash": "limits",
  "abandoned-work": "limits",
  "oversized-context-reads": "limits",
  "compaction-burn": "quality",
  "compaction-rework": "quality",
  "eternal-session": "quality",
  "duplicate-tool-call": "quality",
  "repeated-delegation": "quality",
  "edit-fail-loop": "quality",
  "bash-error-loop": "quality",
  "missed-delegation": "quality",
  "paste-relay": "time",
  "idle-gap-notifications": "time",
  "permission-churn": "time",
  "post-edit-ritual": "time",
};

/** Tier-1: rules whose fix is a file/config write a machine can apply. */
const FIXABLE: Record<string, { kind: string; destination: string }> = {
  "post-edit-ritual": { kind: "hook", destination: "PostToolUse hook → settings.json" },
  "idle-gap-notifications": { kind: "config", destination: "notification setting → /config" },
  "permission-churn": { kind: "config", destination: "permissions allowlist → settings.json" },
};

/** Root-cause groups: one card, many detector votes. */
const COACH_GROUPS: Array<{
  id: string;
  rules: string[];
  impact: Impact;
  recipe: string;
  headline: (n: { count: number; findings: Finding[] }) => string;
  body: string;
}> = [
  {
    id: "session-hygiene",
    rules: ["eternal-session", "cache-thrash", "compaction-burn", "compaction-rework", "duplicate-tool-call"],
    impact: "quality",
    recipe: "session-per-task-bootstrap",
    headline: ({ count }) =>
      `${count} signal${count === 1 ? "" : "s"} point the same way: this session carried too much — move memory to files, start tasks fresh`,
    body:
      "Compactions summarize away details, the cache re-bills the pile, and content gets re-purchased. " +
      "End each task with a notes.md handoff and start the next in a fresh session; CLAUDE.md keeps the permanent facts.",
  },
  {
    id: "source-access",
    rules: ["paste-relay"],
    impact: "time",
    recipe: "automate-data-ingestion",
    headline: ({ findings }) => {
      const blocks = findings.reduce((s, f) => s + Number(f.evidence.metrics?.occurrences ?? f.evidence.metrics?.paste_count ?? 0), 0);
      return blocks > 0
        ? `Claude couldn't fetch this data itself — so you hand-carried it, ${blocks} times`
        : "Claude couldn't fetch this data itself — so you hand-carried it, repeatedly";
    },
    body:
      "Every verification cycle stalled until the next block arrived by hand. Give Claude direct access to " +
      "the source (a file drop, a CLI, an MCP connector) and the stall-fix-stall loop becomes one continuous run.",
  },
  {
    id: "plan-first",
    rules: ["abandoned-work"],
    impact: "limits",
    recipe: "plan-mode-first",
    headline: () => "A direction change discarded a lot of built work — make the direction check earlier",
    body:
      "Rewinding was probably the right call; its size wasn't. Plan mode (or \"show me the sketch first\") makes " +
      "wrong directions cost minutes instead of a rebuilt feature.",
  },
  {
    id: "freeze-pattern",
    rules: ["repeated-delegation"],
    impact: "quality",
    recipe: "freeze-your-own-pattern",
    headline: ({ findings }) => {
      // repeated-delegation records the family size as `occurrences`
      const spawns = findings.reduce((s, f) => s + Number(f.evidence.metrics?.occurrences ?? 0), 0);
      return spawns > 0
        ? `The same delegation was re-improvised ${spawns} times — the skill you need already exists, written by you, in installments`
        : "The same delegation keeps getting re-improvised — freeze it into a skill or workflow";
    },
    body:
      "Each retelling drifts a little. Your own versions are the draft: merge them into a saved skill/workflow " +
      "and the best version becomes the only version.",
  },
  {
    id: "delegation",
    rules: ["missed-delegation"],
    impact: "quality",
    recipe: "delegate-bulk-exploration",
    headline: () => "Bulk reading ran in the main conversation while a subagent sat unused",
    body:
      "A subagent reads in its own disposable context and only conclusions enter yours. Say the word " +
      "(\"use a subagent to survey these files\") — or put the preference in CLAUDE.md once.",
  },
  {
    id: "targeted-reads",
    rules: ["oversized-context-reads"],
    impact: "limits",
    recipe: "targeted-reads",
    headline: () => "Whole files entered the context to answer narrow questions — read targeted",
    body: "Grep for the section, then read around it. Whole-file reads belong to whole-file tasks.",
  },
];

export interface SurfaceFix {
  what: string;
  destination: string;
  kind: string;
  dedupe_key: string;
  rule_id: string;
}
export interface SurfaceCoachCard {
  id: string;
  impact: Impact;
  headline: string;
  body: string;
  proof: string;
  votes: string[];
  finding_keys: string[];
  recipe: { ref: string; title: string; status: string; source: string } | null;
  flagship?: boolean;
}
export interface SurfaceReceipt {
  severity: string;
  currency: Impact;
  headline: string;
  proof: string;
  evidence_n: number;
  dedupe_key: string;
  rule_id: string;
  scene_prompt?: string;
}
export interface Surfaces {
  fixes: SurfaceFix[];
  coach: SurfaceCoachCard[];
  coach_more: SurfaceCoachCard[];
  receipts: SurfaceReceipt[];
  not_yours: Array<{ headline: string; proof: string; dedupe_key: string }>;
}

const SEVERITY_POINTS: Record<string, number> = { major: 25, moderate: 12, minor: 5, info: 0 };

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tokens`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k tokens`;
  return `${n} tokens`;
}

/**
 * The user's own prompt at the scene of the finding. Two cases:
 *  - abandoned-work: the first evidence event IS the scene — the retracted
 *    prompt at the abandoned branch's root ("the prompt you rewound from"),
 *    which lives on the abandoned branch by definition.
 *  - everything else: the nearest live human prompt strictly BEFORE the
 *    first evidence event (exclusive — for paste-relay the evidence events
 *    are themselves human messages, and echoing the paste back would not be
 *    a scene).
 */
function scenePrompt(session: Session, finding: Finding): string | undefined {
  const clip = (t: string) => {
    const text = t.replace(/\s+/g, " ").trim();
    return text.length > 180 ? `${text.slice(0, 180)}…` : text;
  };
  const firstRef = finding.evidence.events[0];
  if (!firstRef) return undefined;
  const idx = session.events.findIndex((e) => e.event_id === firstRef.event_id);
  if (idx < 0) return undefined;
  const first = session.events[idx]!;
  if (first.kind === "user_message" && first.origin === "human" && !first.is_meta && first.on_abandoned_branch) {
    return clip(first.text);
  }
  for (let i = idx - 1; i >= 0; i--) {
    const e = session.events[i]!;
    if (e.kind === "user_message" && e.origin === "human" && !e.is_meta && !e.on_abandoned_branch) {
      return clip(e.text);
    }
  }
  return undefined;
}

function proofLine(f: Finding): string {
  const parts: string[] = [];
  // Exact-value dedupe: a metric that repeats the savings number adds no
  // information (abandoned-work's branch total, cache-thrash's missed
  // total). Substring matching failed both ways — formatted "1.3M" never
  // contained "1288713", and tiny values false-matched inside bigger ones.
  const shown = new Set<number>();
  if (f.savings?.tokens) {
    parts.push(`${fmtTokens(f.savings.tokens.value)} ${f.savings.basis}`);
    shown.add(f.savings.tokens.value);
  }
  const m = f.evidence.metrics ?? {};
  for (const [k, v] of Object.entries(m).slice(0, 3)) {
    if (typeof v !== "number" || shown.has(v)) continue;
    parts.push(`${k.replace(/_/g, " ")}: ${v.toLocaleString()}`);
    shown.add(v);
    if (parts.length >= 3) break;
  }
  parts.push(`${f.rule.id}@${f.rule.version}`);
  return parts.join(" · ");
}

export function buildSurfaces(session: Session, findings: Finding[]): Surfaces {
  const live = findings.filter((f) => f.category !== "infra");
  const infra = findings.filter((f) => f.category === "infra");
  const entryById = new Map(REGISTRY.map((e) => [e.id, e]));

  const fixes: SurfaceFix[] = live
    .filter((f) => FIXABLE[f.rule.id])
    .map((f) => ({
      what: f.title,
      destination: FIXABLE[f.rule.id]!.destination,
      kind: FIXABLE[f.rule.id]!.kind,
      dedupe_key: f.dedupe_key,
      rule_id: f.rule.id,
    }));

  const cards: SurfaceCoachCard[] = [];
  for (const group of COACH_GROUPS) {
    const members = live.filter((f) => group.rules.includes(f.rule.id) && !FIXABLE[f.rule.id]);
    if (members.length === 0) continue;
    const entry = entryById.get(group.recipe);
    const weight = members.reduce((s, f) => s + (SEVERITY_POINTS[f.severity] ?? 0), 0);
    const proof = members
      .slice(0, 3)
      .map((f) => f.title)
      .join(" · ");
    cards.push({
      id: group.id,
      impact: group.impact,
      headline: group.headline({ count: members.length, findings: members }),
      body: group.body,
      proof,
      votes: [...new Set(members.map((f) => f.rule.id))],
      finding_keys: members.map((f) => f.dedupe_key),
      recipe: entry
        ? { ref: entry.id, title: entry.title, status: entry.status, source: entry.source }
        : null,
      ...(group.id === "freeze-pattern" ? { flagship: true } : {}),
      // weight carried via sort below
      ...( { } as Record<string, never>),
    });
    (cards[cards.length - 1] as SurfaceCoachCard & { _w?: number })._w = weight;
  }
  cards.sort((a, b) => ((b as { _w?: number })._w ?? 0) - ((a as { _w?: number })._w ?? 0));
  for (const c of cards) delete (c as { _w?: number })._w;

  const receipts: SurfaceReceipt[] = live.map((f) => ({
    severity: f.severity,
    currency: RULE_IMPACT[f.rule.id] ?? "limits",
    headline: f.title,
    proof: proofLine(f),
    evidence_n: f.evidence.events.length,
    dedupe_key: f.dedupe_key,
    rule_id: f.rule.id,
    ...(["abandoned-work", "missed-delegation", "paste-relay"].includes(f.rule.id)
      ? { scene_prompt: scenePrompt(session, f) }
      : {}),
  }));

  return {
    fixes,
    coach: cards.slice(0, 3),
    coach_more: cards.slice(3),
    receipts,
    not_yours: infra.map((f) => ({ headline: f.title, proof: proofLine(f), dedupe_key: f.dedupe_key })),
  };
}
