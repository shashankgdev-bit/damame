import type {
  Event,
  Finding,
  GradingVersion,
  Recommendation,
  Savings,
  Session,
} from "@damame/ir";
import type { MetricsBundle } from "@damame/metrics";
import { formatDuration, formatTokens } from "@damame/rules";

/**
 * Renders one self-contained HTML document for a graded session: facts first
 * (reproducible numbers), findings second, resource inventory, grading-version
 * footer. Pure function of its input — no IO, no clock, no randomness — so the
 * same input always produces byte-identical output.
 *
 * All session-derived strings are untrusted (they come from transcripts, which
 * contain arbitrary user and model text) and are escaped before interpolation.
 */
export interface RenderHtmlReportInput {
  session: Session;
  metrics: MetricsBundle;
  findings: Finding[];
  grading: GradingVersion;
}

export function renderHtmlReport(input: RenderHtmlReportInput): string {
  const { session, metrics, findings, grading } = input;
  const eventById = new Map<string, Event>();
  for (const event of session.events) eventById.set(event.event_id, event);

  const docTitle = `${session.title ?? session.slug ?? session.id} — damame report`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(docTitle)}</title>
<style>${CSS}</style>
</head>
<body>
<main class="wrap">
${renderHeader(session, grading)}
${renderFacts(session, metrics)}
${renderFindings(session, findings, eventById)}
${renderResources(session)}
${renderGradingFooter(grading)}
</main>
</body>
</html>
`;
}

/* ---------------------------------------------------------------- header */

function renderHeader(session: Session, grading: GradingVersion): string {
  const name = session.title ?? session.slug ?? session.id;
  const metaRows: string[] = [];
  if (session.slug && session.slug !== name) metaRows.push(row("Slug", `<code>${esc(session.slug)}</code>`));
  metaRows.push(row("Session id", `<code>${esc(session.id)}</code>`));
  if (session.project?.cwd) metaRows.push(row("Project", `<code>${esc(session.project.cwd)}</code>`));
  const range = [fmtIso(session.started_at), fmtIso(session.ended_at)].filter(Boolean);
  if (range.length > 0) metaRows.push(row("Date range", esc(range.join(" → "))));
  const cli = versionRange(session.source.tool_version_min, session.source.tool_version_max);
  if (cli) metaRows.push(row("CLI version", esc(`${session.source.tool} ${cli}`)));
  metaRows.push(
    row("Adapter / IR", esc(`${grading.adapter}@${grading.adapter_version} · IR ${grading.ir_version}`)),
  );
  return `<header class="head">
<h1>${esc(name)}</h1>
<dl class="meta">${metaRows.join("")}</dl>
</header>`;
}

function row(label: string, valueHtml: string): string {
  return `<div class="meta-row"><dt>${esc(label)}</dt><dd>${valueHtml}</dd></div>`;
}

function versionRange(min: string | undefined, max: string | undefined): string | undefined {
  if (min && max) return min === max ? min : `${min}–${max}`;
  return min ?? max;
}

/* ----------------------------------------------------------- facts strip */

function renderFacts(session: Session, metrics: MetricsBundle): string {
  const t = metrics.totals;
  const u = t.usage;
  const breakdown =
    `in ${formatTokens(u.input_tokens ?? 0)} · out ${formatTokens(u.output_tokens ?? 0)} · ` +
    `cache-read ${formatTokens(u.cache_read_input_tokens ?? 0)} · cache-write ${formatTokens(u.cache_creation_input_tokens ?? 0)}`;
  const notificationTurns = session.turns.filter((turn) => turn.origin === "task_notification").length;
  const otherTurns = t.turn_count - t.human_turn_count - notificationTurns;
  const turnParts = [`${t.human_turn_count} human`, `${notificationTurns} notification`];
  if (otherTurns > 0) turnParts.push(`${otherTurns} other`);
  const errorRate = t.tool_call_count > 0 ? `${((t.tool_error_count / t.tool_call_count) * 100).toFixed(1)}% errors` : "no calls";
  const apiRetries = metrics.api_error_runs.reduce((sum, run) => sum + run.event_ids.length, 0);

  const tiles = [
    tile(formatTokens(t.total_tokens), "total tokens (deduped)", breakdown),
    tile(String(t.turn_count), "turns", turnParts.join(" · ")),
    tile(String(t.tool_call_count), "tool calls", errorRate),
    tile(String(metrics.subagent_runs.length), "subagent runs"),
    tile(String(metrics.compactions.length), "compactions"),
    tile(String(metrics.interruption_count), "interruptions"),
    tile(String(apiRetries), "api-error retries"),
  ];
  return `<section class="facts-section">
<h2>Facts</h2>
<div class="facts">${tiles.join("")}</div>
</section>`;
}

function tile(value: string, label: string, sub?: string): string {
  return `<div class="tile"><div class="tile-value">${esc(value)}</div><div class="tile-label">${esc(label)}</div>${
    sub ? `<div class="tile-sub">${esc(sub)}</div>` : ""
  }</div>`;
}

/* -------------------------------------------------------------- findings */

function renderFindings(session: Session, findings: Finding[], eventById: Map<string, Event>): string {
  if (findings.length === 0) {
    return `<section class="findings-section">
<h2>Findings</h2>
<div class="empty-state"><p>No rule fired on this session — the facts above still apply.</p></div>
</section>`;
  }
  // Preserve the given order; only partition infra into its own subsection.
  const own = findings.filter((f) => f.category !== "infra");
  const infra = findings.filter((f) => f.category === "infra");
  const parts: string[] = [`<section class="findings-section">\n<h2>Findings (${findings.length})</h2>`];
  parts.push(own.map((f) => renderFindingCard(session, f, eventById)).join("\n"));
  if (infra.length > 0) {
    parts.push(`<section class="infra">
<h3>Not your inefficiency</h3>
<p class="note">These findings are attributed to infrastructure behavior (API availability, retries, harness overhead), not to how the session was driven.</p>
${infra.map((f) => renderFindingCard(session, f, eventById)).join("\n")}
</section>`);
  }
  parts.push(`</section>`);
  return parts.join("\n");
}

function renderFindingCard(session: Session, f: Finding, eventById: Map<string, Event>): string {
  return `<article class="finding">
<div class="finding-head">
<span class="badge sev-${esc(f.severity)}">${esc(f.severity)}</span>
<code class="rule-id">${esc(f.rule.id)}@${esc(f.rule.version)}</code>
<span class="cat">${esc(f.category)}</span>
</div>
<h3 class="finding-title">${esc(f.title)}</h3>
<p class="desc">${esc(f.description)}</p>
${renderSavings(f.savings)}
${renderRecommendation(f.recommendation)}
${renderEvidence(session, f, eventById)}
</article>`;
}

function renderSavings(savings: Savings | undefined): string {
  if (!savings) return `<div class="savings none">No savings claim for this finding.</div>`;
  const bands: string[] = [];
  if (savings.tokens) bands.push(`${band(savings.tokens, formatTokens)} tokens`);
  if (savings.wall_clock_ms) bands.push(`${band(savings.wall_clock_ms, formatDuration)} wall-clock`);
  const basisBadge =
    savings.basis === "measured"
      ? `<span class="basis basis-measured">measured</span>`
      : `<span class="basis basis-modeled">modeled<span class="est-tag">estimate</span></span>`;
  return `<div class="savings">
<div class="savings-line">${basisBadge}<span class="bands">${esc(bands.join(" · ") || "no quantity")}</span></div>
<div class="method">Method: ${esc(savings.method)}</div>
</div>`;
}

function band(b: { value: number; low?: number; high?: number }, fmt: (n: number) => string): string {
  const range =
    b.low !== undefined || b.high !== undefined
      ? ` (${fmt(b.low ?? b.value)}–${fmt(b.high ?? b.value)})`
      : "";
  return `${fmt(b.value)}${range}`;
}

function renderRecommendation(rec: Recommendation): string {
  const availability =
    rec.resource.available_in_session === true
      ? `<span class="avail avail-yes">available in this session</span>`
      : rec.resource.available_in_session === false
        ? `<span class="avail avail-no">not available in this session</span>`
        : "";
  return `<div class="rec">
<div class="rec-line"><span class="rec-label">Recommendation</span><span class="rec-kind">${esc(rec.resource.kind)}</span><code>${esc(rec.resource.ref)}</code>${availability}</div>
<p class="rec-rationale">${esc(rec.rationale)}</p>
${rec.example_invocation ? `<pre class="rec-example">${esc(rec.example_invocation)}</pre>` : ""}
</div>`;
}

function renderEvidence(session: Session, f: Finding, eventById: Map<string, Event>): string {
  const items = f.evidence.events.map((ref) => {
    const event = ref.session_id === session.id ? eventById.get(ref.event_id) : undefined;
    if (!event) {
      const where = ref.session_id === session.id ? "not found in this session's events" : `recorded in session ${ref.session_id}, not in this report`;
      return `<li class="ev ev-missing"><code>${esc(ref.event_id)}</code> <span class="ev-note">${esc(where)}</span></li>`;
    }
    const text = excerpt(event);
    return `<li class="ev">
<div class="ev-head"><code>${esc(event.event_id)}</code><span class="ev-kind">${esc(event.kind)}</span>${
      event.timestamp ? `<span class="ev-ts">${esc(fmtIso(event.timestamp))}</span>` : ""
    }<span class="ev-raw">${esc(event.raw_ref.file)}:${event.raw_ref.line}</span></div>
${text ? `<pre class="ev-excerpt">${esc(text)}</pre>` : ""}
</li>`;
  });
  return `<details class="evidence">
<summary>Evidence · ${f.evidence.events.length} event${f.evidence.events.length === 1 ? "" : "s"}</summary>
<ul class="ev-list">
${items.join("\n")}
</ul>
</details>`;
}

const EXCERPT_CHARS = 300;

function excerpt(event: Event): string {
  switch (event.kind) {
    case "user_message":
      return clip(event.text);
    case "assistant_message":
      return event.text ? clip(event.text) : "";
    case "thinking":
      return clip(event.text);
    case "tool_call":
      return `${event.name} ${clip(compactJson(event.input))}`;
    case "tool_result":
      return event.output_text ? clip(event.output_text) : event.is_error ? "(error result, no output text)" : "";
    case "interruption":
      return `interruption (scope: ${event.scope})`;
    case "permission_denial":
      return `permission denied${event.tool_name ? `: ${event.tool_name}` : ""}`;
    case "compaction":
      return `compaction${
        event.pre_tokens !== undefined && event.post_tokens !== undefined
          ? ` (${formatTokens(event.pre_tokens)} → ${formatTokens(event.post_tokens)} tokens)`
          : ""
      }`;
    case "subagent_run":
      return `${event.spawn_tool}${event.agent_type ? ` (${event.agent_type})` : ""}`;
    case "system_event":
      return `${event.subtype} ${clip(compactJson(event.detail))}`;
    default:
      return "";
  }
}

/* ----------------------------------------------------- resource inventory */

function renderResources(session: Session): string {
  const env = session.environment;
  if (!env) {
    return `<section class="resources">
<h2>Resources in this session</h2>
<p class="note">No environment snapshot was recorded for this session.</p>
</section>`;
  }
  const usedSkills = new Set<string>();
  for (const skill of env.invoked_skills) usedSkills.add(skill.name);
  for (const event of session.events) {
    if (event.kind === "assistant_message" && event.attribution?.skill) usedSkills.add(event.attribution.skill);
  }
  const skillItems = env.skills.map(
    (s) =>
      `<li><code>${esc(s.name)}</code>${usedSkills.has(s.name) ? `<span class="used">used</span>` : ""}${
        s.description ? `<span class="res-desc">${esc(s.description)}</span>` : ""
      }</li>`,
  );
  const agentItems = env.agents
    .filter((a) => a.removed !== true)
    .map(
      (a) =>
        `<li><code>${esc(a.type)}</code>${a.description ? `<span class="res-desc">${esc(a.description)}</span>` : ""}</li>`,
    );
  const deferredAvailable = env.deferred_tools.filter((t) => t.available).length;
  return `<section class="resources">
<h2>Resources in this session</h2>
<div class="res-cols">
<div class="res-col"><h3>Skills (${env.skills.length})</h3>${
    skillItems.length > 0 ? `<ul class="res-list">${skillItems.join("")}</ul>` : `<p class="res-none">none listed</p>`
  }</div>
<div class="res-col"><h3>Agent types (${agentItems.length})</h3>${
    agentItems.length > 0 ? `<ul class="res-list">${agentItems.join("")}</ul>` : `<p class="res-none">none listed</p>`
  }</div>
<div class="res-col"><h3>Deferred tools</h3><p class="res-count">${env.deferred_tools.length} listed · ${deferredAvailable} available</p></div>
</div>
<p class="note">Availability is read from the session's own recorded listings, not from current configuration.</p>
</section>`;
}

/* --------------------------------------------------------- grading footer */

function renderGradingFooter(grading: GradingVersion): string {
  const rules = Object.entries(grading.rule_versions)
    .map(([id, version]) => `${id}@${version}`)
    .join(" · ");
  return `<footer class="grading">
<div class="grading-line">Grading version: damame ${esc(grading.damame_version)} · IR ${esc(grading.ir_version)} · adapter ${esc(grading.adapter)}@${esc(grading.adapter_version)}</div>
${rules ? `<div class="grading-rules">Rules: ${esc(rules)}</div>` : ""}
<p class="fine">Two reports are comparable only when these versions match.</p>
</footer>`;
}

/* ---------------------------------------------------------------- shared */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const esc = escapeHtml;

function clip(s: string, max = EXCERPT_CHARS): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "[unserializable]";
  }
}

/** Deterministic UTC formatting; never locale- or timezone-dependent. */
function fmtIso(iso: string | undefined): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

/* ------------------------------------------------------------------- css */

const CSS = `
:root {
  --bg: #f4f5f7;
  --surface: #ffffff;
  --surface-2: #edeff2;
  --text: #1b1f24;
  --muted: #5b6572;
  --border: #d8dde3;
  --accent: #2b5fa5;
  --sev-major-bg: #fbe9e7; --sev-major-fg: #9a2b22;
  --sev-moderate-bg: #fdf3e0; --sev-moderate-fg: #8a5a00;
  --sev-minor-bg: #edeff2; --sev-minor-fg: #4b5563;
  --sev-info-bg: #e8f0fb; --sev-info-fg: #2b5fa5;
  --measured-bg: #e6f4ea; --measured-fg: #1e6b3a;
  --modeled-bg: #fdf3e0; --modeled-fg: #8a5a00;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14161a;
    --surface: #1d2025;
    --surface-2: #262a30;
    --text: #e6e8eb;
    --muted: #9aa3ad;
    --border: #353b43;
    --accent: #7aa5dd;
    --sev-major-bg: #3a1f1c; --sev-major-fg: #f2a099;
    --sev-moderate-bg: #37290f; --sev-moderate-fg: #e5b567;
    --sev-minor-bg: #262b31; --sev-minor-fg: #aab3bd;
    --sev-info-bg: #1c2a3d; --sev-info-fg: #8fb4e3;
    --measured-bg: #17301f; --measured-fg: #8fce9f;
    --modeled-bg: #37290f; --modeled-fg: #e5b567;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}
.wrap { max-width: 60rem; margin: 0 auto; padding: 2rem 1.25rem 3rem; }
h1 { font-size: 1.5rem; margin: 0 0 0.75rem; }
h2 { font-size: 1.1rem; margin: 2rem 0 0.75rem; border-bottom: 1px solid var(--border); padding-bottom: 0.35rem; }
h3 { font-size: 1rem; margin: 0.75rem 0 0.4rem; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.86em; }
pre {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.8rem;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0.5rem 0.65rem;
  margin: 0.35rem 0 0;
  overflow-x: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.note, .fine { color: var(--muted); font-size: 0.82rem; }
.meta { display: grid; gap: 0.15rem; margin: 0; }
.meta-row { display: flex; gap: 0.6rem; }
.meta-row dt { color: var(--muted); min-width: 7.5rem; font-size: 0.85rem; }
.meta-row dd { margin: 0; font-size: 0.85rem; overflow-wrap: anywhere; }
.facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr)); gap: 0.6rem; }
.tile { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 0.7rem 0.8rem; }
.tile-value { font-size: 1.3rem; font-weight: 600; }
.tile-label { color: var(--muted); font-size: 0.78rem; }
.tile-sub { color: var(--muted); font-size: 0.72rem; margin-top: 0.25rem; overflow-wrap: anywhere; }
.finding { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 0.9rem 1rem; margin: 0.75rem 0; }
.finding-head { display: flex; align-items: center; gap: 0.55rem; flex-wrap: wrap; }
.finding-title { margin: 0.5rem 0 0.25rem; }
.desc { margin: 0.25rem 0 0.6rem; font-size: 0.9rem; }
.badge {
  display: inline-block; padding: 0.05rem 0.5rem; border-radius: 999px;
  font-size: 0.72rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em;
}
.sev-major { background: var(--sev-major-bg); color: var(--sev-major-fg); }
.sev-moderate { background: var(--sev-moderate-bg); color: var(--sev-moderate-fg); }
.sev-minor { background: var(--sev-minor-bg); color: var(--sev-minor-fg); }
.sev-info { background: var(--sev-info-bg); color: var(--sev-info-fg); }
.rule-id { color: var(--muted); }
.cat { color: var(--muted); font-size: 0.78rem; }
.savings { margin: 0.5rem 0; font-size: 0.88rem; }
.savings.none { color: var(--muted); font-size: 0.82rem; }
.savings-line { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
.basis { display: inline-flex; align-items: center; gap: 0.35rem; padding: 0.05rem 0.5rem; border-radius: 4px; font-size: 0.74rem; font-weight: 600; }
.basis-measured { background: var(--measured-bg); color: var(--measured-fg); }
.basis-modeled { background: var(--modeled-bg); color: var(--modeled-fg); }
.est-tag { border: 1px solid currentColor; border-radius: 3px; padding: 0 0.25rem; font-size: 0.66rem; font-weight: 500; }
.method { color: var(--muted); font-size: 0.8rem; margin-top: 0.2rem; }
.rec { border-left: 3px solid var(--accent); padding-left: 0.7rem; margin: 0.6rem 0; font-size: 0.88rem; }
.rec-line { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
.rec-label { font-weight: 600; font-size: 0.8rem; }
.rec-kind { color: var(--muted); font-size: 0.78rem; }
.avail { font-size: 0.74rem; padding: 0.05rem 0.45rem; border-radius: 4px; }
.avail-yes { background: var(--measured-bg); color: var(--measured-fg); }
.avail-no { background: var(--surface-2); color: var(--muted); }
.rec-rationale { margin: 0.3rem 0 0; }
.evidence { margin-top: 0.6rem; }
.evidence summary { cursor: pointer; font-size: 0.85rem; color: var(--accent); }
.ev-list { list-style: none; margin: 0.4rem 0 0; padding: 0; display: grid; gap: 0.5rem; }
.ev { border: 1px solid var(--border); border-radius: 6px; padding: 0.5rem 0.6rem; }
.ev-head { display: flex; gap: 0.6rem; flex-wrap: wrap; align-items: baseline; font-size: 0.78rem; }
.ev-kind { color: var(--accent); }
.ev-ts, .ev-raw { color: var(--muted); }
.ev-raw { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
.ev-missing { color: var(--muted); font-size: 0.82rem; }
.empty-state { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 1rem; color: var(--muted); }
.infra { margin-top: 1.25rem; border-top: 1px dashed var(--border); padding-top: 0.75rem; }
.infra > h3 { margin-top: 0; }
.res-cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: 0.75rem; }
.res-col { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 0.7rem 0.85rem; }
.res-col h3 { margin: 0 0 0.4rem; font-size: 0.88rem; }
.res-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.25rem; font-size: 0.84rem; }
.res-list li { display: flex; gap: 0.45rem; align-items: baseline; flex-wrap: wrap; }
.res-desc { color: var(--muted); font-size: 0.76rem; }
.res-none, .res-count { color: var(--muted); font-size: 0.84rem; margin: 0; }
.used { background: var(--measured-bg); color: var(--measured-fg); font-size: 0.7rem; font-weight: 600; padding: 0 0.35rem; border-radius: 4px; }
.grading { margin-top: 2.5rem; border-top: 1px solid var(--border); padding-top: 0.75rem; color: var(--muted); font-size: 0.8rem; }
.grading-rules { overflow-wrap: anywhere; }
.fine { margin: 0.3rem 0 0; font-style: italic; }
`;
