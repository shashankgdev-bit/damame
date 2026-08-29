import type { RegistryEntry } from "./schema.js";

/**
 * Seed shelf. Sources are honest: "Claude Code docs" (documented behavior),
 * "curated from a real transcript" (learned from actual sessions damame
 * analyzed), "community" (seen in the wild — candidate until tested).
 */
export const ENTRIES: RegistryEntry[] = [
  // ————— config —————
  {
    id: "enable-notifications",
    kind: "config",
    title: "Get pinged when Claude finishes or needs you",
    what_it_is:
      "Claude Code can fire a terminal bell or system notification when a turn finishes or input is " +
      "needed — so finished work interrupts you instead of silently waiting.",
    how_to: [
      "Run /config inside any Claude Code session",
      'Find the notification setting and pick "terminal bell" or "system notifications"',
      "Test it: ask Claude something slow, switch to another app — you should get pinged",
    ],
    notes: "Mobile push exists when using the companion app; terminal bell works everywhere.",
    applies_to: ["idle-gap-notifications"],
    source: "Claude Code docs",
    status: "verified",
    verified_by: "documented setting; tested locally",
  },
  {
    id: "stable-tool-availability",
    kind: "config",
    title: "Decide your tool setup before the session, not during",
    what_it_is:
      "The list of connected tools (MCP servers, plugins) sits at the very top of every request. " +
      "Changing it mid-session invalidates the prompt cache for the ENTIRE conversation — one toggle " +
      "can re-bill hundreds of thousands of tokens.",
    how_to: [
      "Before starting work, think: will this session need browser control? a database? design tools?",
      "Connect what you need first (claude mcp add …, or enable connectors), THEN start the session",
      "If you must add a server mid-session, know it costs one full re-read of the conversation — sometimes worth it, never free",
      "Batch config changes at session boundaries: change config → start a fresh chat",
    ],
    applies_to: ["cache-thrash"],
    source: "Claude Code docs + curated from a real transcript (a 298k-token mid-session toggle)",
    status: "verified",
    verified_by: "cache_miss_reason: tools_changed observed with exact token cost",
  },
  {
    id: "permissions-allowlist",
    kind: "config",
    title: "Allowlist commands you approve every time",
    what_it_is:
      "If you keep approving the same safe command (npm test, git status…), a permissions allowlist " +
      "entry approves it permanently — no more interruptions for it.",
    how_to: [
      "Open .claude/settings.json in your project (or ~/.claude/settings.json for everywhere)",
      'Add: { "permissions": { "allow": ["Bash(npm test)", "Bash(git status)"] } }',
      'Prefix wildcards work: "Bash(git *)" allows all git commands',
      "Keep destructive commands (rm, deploy) OUT of the allowlist — the prompt is the safety",
    ],
    applies_to: ["permission-churn"],
    source: "Claude Code docs",
    status: "verified",
    verified_by: "documented settings schema",
  },
  {
    id: "hooks-post-edit",
    kind: "config",
    title: "Run your checks automatically after every edit (hooks)",
    what_it_is:
      "A hook runs a command of yours automatically at lifecycle moments — e.g. run the formatter or " +
      "tests after every file edit, without asking Claude to do it each time.",
    how_to: [
      "Open .claude/settings.json in your project",
      'Add a PostToolUse hook: { "hooks": { "PostToolUse": [{ "matcher": "Write|Edit", "hooks": [{ "type": "command", "command": "npm test 2>/dev/null || true" }] }] } }',
      "The matcher picks which tools trigger it; the command is anything from your shell",
      "Check it fires: /hooks shows configured hooks; edit a file and watch",
    ],
    notes: "Hooks are powerful — start with harmless commands (formatters, linters) before gating ones.",
    applies_to: ["post-edit-ritual"],
    source: "Claude Code docs",
    status: "verified",
    verified_by: "documented hooks schema",
  },
  {
    id: "plan-mode-first",
    kind: "config",
    title: "Plan mode: design before building",
    what_it_is:
      "A mode where Claude can read and plan but not change anything — you approve the plan before any " +
      "file is touched. Big builds started cold tend to need heavy rework; planned ones don't.",
    how_to: [
      "Press Shift+Tab in the Claude Code input to cycle modes until you see plan mode",
      "Describe the big task; Claude explores and writes a plan",
      "Approve it (or push back) — only then does building start",
    ],
    applies_to: ["abandoned-work"],
    source: "Claude Code docs",
    status: "verified",
    verified_by: "documented mode",
  },

  // ————— patterns —————
  {
    id: "automate-data-ingestion",
    kind: "pattern",
    title: "Stop hand-carrying data into the chat",
    what_it_is:
      "If you repeatedly copy blocks from somewhere (a browser, a report, a tool) and paste them into " +
      "the conversation, you are working as a courier between two machines. Give the data a machine path.",
    how_to: [
      "Easiest: paste into a FILE instead (results.txt in the project), and tell Claude once: \"read results.txt whenever I say 'new results'\" — the chat stays clean and nothing is re-billed every turn",
      "Better: a drop-folder — save each block as a new file in one folder; Claude lists and reads new files itself",
      "Best, when the source is a website: connect a browser MCP so Claude reads the source directly (see the browser-mcp entry)",
    ],
    applies_to: ["paste-relay"],
    source: "curated from a real transcript (146 hand-pasted verdict blocks over 71 days)",
    status: "verified",
    verified_by: "pattern and cost measured in a real session",
  },
  {
    id: "save-as-named-workflow",
    kind: "workflow",
    title: "Freeze a repeated procedure into a named workflow",
    what_it_is:
      "If you keep asking Claude to run the same multi-agent procedure (a probe, a batch build, a review), " +
      "saving it as a named workflow makes it one command — and a script guarantees every step runs " +
      "identically every time, surviving compactions and forgetfulness.",
    how_to: [
      "Ask Claude: \"save what you just did as a named workflow I can rerun\" — it writes the script to .claude/workflows/<name>.js",
      "The script starts with a meta block (name, description) and uses agent()/parallel() to drive helpers",
      "Rerun anytime: \"run the <name> workflow on X\" — the name resolves from .claude/workflows/",
      "Parameterize the variable part with args so one workflow serves every case",
    ],
    applies_to: ["repeated-delegation"],
    source: "curated from a real transcript (48 re-improvised probe spawns → became one saved workflow)",
    status: "verified",
    verified_by: "pattern observed; workflow registry documented",
  },
  {
    id: "session-per-task-bootstrap",
    kind: "pattern",
    title: "Fresh chats from state files, not one eternal chat",
    what_it_is:
      "One chat resumed for weeks pays compounding costs: repeated compactions (pauses + lost detail) and " +
      "every turn dragging the whole past. The durable memory belongs in files; chats should be cheap and fresh.",
    how_to: [
      "Keep project truth in files: CLAUDE.md for stable facts, a LEDGER/PLAN file for work state",
      "At a task boundary (feature done, new topic), start a NEW chat instead of resuming",
      "Open it with: \"read CLAUDE.md and LEDGER.md, then continue with <today's goal>\" — full orientation in one cheap step",
      "Resume an old chat only mid-wrestling-match, when its working context is still hot and relevant",
    ],
    applies_to: ["eternal-session", "compaction-rework"],
    source: "curated from a real transcript (208MB single chat, 23 compactions, ~3.4k resumes)",
    status: "verified",
    verified_by: "costs measured in a real session; state-file bootstrap proven there too",
  },
  {
    id: "claude-md-project-memory",
    kind: "pattern",
    title: "CLAUDE.md — teach your project once, forever",
    what_it_is:
      "A CLAUDE.md file at your project root is loaded automatically into EVERY session there. Anything " +
      "you find yourself re-explaining — the stack, the structure, the rules — belongs in it.",
    how_to: [
      "Create CLAUDE.md in the project root",
      "Write the stable facts: what the project is, key files, build/test commands, hard rules (\"never touch X\")",
      "Add to it whenever you catch yourself explaining the same thing twice",
      "Keep it under ~1 page — it rides along in every request, so it should earn its tokens",
    ],
    applies_to: [],
    source: "Claude Code docs",
    status: "verified",
    verified_by: "documented behavior; observed loaded in real transcripts",
  },
  {
    id: "delegate-bulk-exploration",
    kind: "pattern",
    title: "Send bulk reading to a helper, keep your chat lean",
    what_it_is:
      "Reading many files in the main chat leaves every byte in its memory forever — hastening the " +
      "context limit. A subagent reads in its OWN memory and returns only conclusions.",
    how_to: [
      "For broad questions, ask explicitly: \"use an Explore agent to survey the codebase and report back\"",
      "Give the helper a self-contained brief — it starts with a blank memory and can't ask follow-ups",
      "Expect a summary back, not raw file dumps — that's the point",
    ],
    applies_to: ["compaction-burn", "missed-delegation", "oversized-context-reads"],
    source: "Claude Code docs + curated from real transcripts",
    status: "verified",
    verified_by: "context savings measured across sessions",
  },
  {
    id: "targeted-reads",
    kind: "pattern",
    title: "Read the lines you need, not the whole file",
    what_it_is:
      "A full-file read of a big file injects tens of thousands of tokens into the chat's memory, paid on " +
      "every later turn. Targeted reads (line ranges, search-first) keep the memory lean.",
    how_to: [
      "Ask for specifics: \"read the parse function in parser.ts\", not \"read parser.ts\"",
      "Prefer search-then-read: \"grep for where X is defined, then read that part\"",
      "For huge generated files (bundles, logs), ask for head/tail or a grep — never the whole thing",
    ],
    applies_to: ["oversized-context-reads"],
    source: "curated from real transcripts",
    status: "verified",
    verified_by: "read sizes measured",
  },
  {
    id: "reference-earlier-output",
    kind: "pattern",
    title: "Point back at results instead of re-running them",
    what_it_is:
      "When the same command or read is repeated with nothing changed in between, the output was already " +
      "in the chat — the repeat just re-bills it.",
    how_to: [
      "Say \"using the test output from before…\" instead of \"run the tests again\" when nothing changed",
      "Re-run only after something actually changed (an edit, an install)",
    ],
    applies_to: ["duplicate-tool-call"],
    source: "curated from real transcripts",
    status: "verified",
    verified_by: "byte-identical repeats measured",
  },
  {
    id: "stable-prompt-prefix",
    kind: "pattern",
    title: "Edit history rarely — every rewind re-bills the rest",
    what_it_is:
      "The prompt cache needs the conversation's earlier bytes to be identical. Rewinding and rewriting " +
      "an old message invalidates everything after it — the whole tail re-processes at full price.",
    how_to: [
      "Rewind early and decisively when a direction is wrong — one clean cut beats five small ones",
      "For small corrections, prefer a follow-up message over rewinding",
      "Deep in a long chat, remember each rewind re-bills everything after the edit point",
    ],
    applies_to: ["cache-thrash"],
    source: "Claude Code docs + curated from real transcripts",
    status: "verified",
    verified_by: "cache_miss_reason: messages_changed with token costs observed",
  },
  {
    id: "diagnose-before-retry",
    kind: "pattern",
    title: "After two identical failures, change the plan — not the attempt count",
    what_it_is:
      "Repeating a failing action unchanged (same edit, same command) burns turns without new information. " +
      "The loop breaker is a diagnosis step.",
    how_to: [
      "If the same action failed twice, ask: \"stop retrying — read the current state and explain why this fails\"",
      "For failing edits specifically: \"re-read the file first, then edit\" (the file often isn't what Claude remembers)",
    ],
    applies_to: ["edit-fail-loop", "bash-error-loop"],
    source: "curated from real transcripts",
    status: "verified",
    verified_by: "failure runs measured",
  },
  {
    id: "read-before-edit",
    kind: "pattern",
    title: "Re-read before re-editing",
    what_it_is:
      "Failed edits usually mean the file's real content differs from what Claude remembers. A fresh read " +
      "beats a third guess.",
    how_to: [
      "When an edit fails with \"text not found\", the next step is a read of that region — ask for it if it isn't happening",
    ],
    applies_to: ["edit-fail-loop"],
    source: "curated from real transcripts",
    status: "verified",
    verified_by: "edit-failure loops measured",
  },
  {
    id: "precheck-script",
    kind: "script",
    title: "Turn every external rejection into a permanent check",
    what_it_is:
      "When a platform/reviewer rejects your deliverables for mechanical reasons, prose notes degrade — a " +
      "script never forgets. One precheck script accumulates every known rejection cause.",
    how_to: [
      "Create precheck.sh in the project; each known gotcha becomes one grep/test line that fails loudly",
      "Run it before every submission (or wire it as a hook)",
      "Every NEW rejection adds one line — the script only ever gets stronger",
    ],
    applies_to: [],
    source: "curated from a real transcript (submission gotchas kept in prose, re-learned after compactions)",
    status: "verified",
    verified_by: "pattern observed in a real 71-day production session",
  },
  {
    id: "submission-queue-file",
    kind: "pattern",
    title: "Keep a ranked next-up queue in a file",
    what_it_is:
      "\"What should I do next?\" re-asked in chat re-derives a decision that was already determinable. " +
      "Decisions derivable from state belong in state.",
    how_to: [
      "Keep a QUEUE.md: each ready item, its readiness, its risk — updated by Claude whenever validation finishes",
      "\"What's next\" becomes a glance instead of a conversation turn",
    ],
    applies_to: [],
    source: "curated from a real transcript",
    status: "verified",
    verified_by: "recurring next-question pattern observed",
  },
  {
    id: "background-tasks",
    kind: "pattern",
    title: "Long commands belong in the background",
    what_it_is:
      "A 10-minute build run in the foreground blocks everything. Run in the background, work continues, " +
      "and the result arrives when ready.",
    how_to: [
      "Ask: \"run the build in the background and keep going on X meanwhile\"",
      "Claude gets notified when the background task finishes and picks the result up",
    ],
    applies_to: [],
    source: "Claude Code docs",
    status: "verified",
    verified_by: "documented run_in_background behavior",
  },

  // ————— mcp —————
  {
    id: "browser-mcp",
    kind: "mcp",
    title: "Let Claude drive/read the browser (MCP)",
    what_it_is:
      "An MCP server that gives Claude browser abilities — open pages, read content, click — so data from " +
      "websites stops needing a human courier.",
    how_to: [
      "Playwright MCP: run  claude mcp add playwright -- npx @playwright/mcp@latest",
      "Restart/start your session — browser tools appear in Claude's toolset",
      "Then: \"open the results page and read the new verdicts\" replaces copy-paste",
    ],
    notes: "Set it up BEFORE the session (see stable-tool-availability). Check your platform's terms if reading a logged-in site.",
    applies_to: ["paste-relay"],
    source: "community + MCP registry",
    status: "candidate",
    verified_by: undefined,
  },
  {
    id: "mcp-basics",
    kind: "mcp",
    title: "MCP — plugging external tools into Claude",
    what_it_is:
      "MCP (Model Context Protocol) is the standard for adding third-party tools: databases, browsers, " +
      "design tools, your company's APIs. Each connected server adds tools Claude can call.",
    how_to: [
      "Add a server: claude mcp add <name> -- <command that runs it>",
      "Project-wide: commit a .mcp.json so teammates get the same tools",
      "List what's connected: claude mcp list",
      "Connect before the session starts, not mid-way (cache cost — see stable-tool-availability)",
    ],
    applies_to: [],
    source: "Claude Code docs",
    status: "verified",
    verified_by: "documented commands",
  },

  // ————— subagents & skills —————
  {
    id: "subagent-explore",
    kind: "subagent",
    title: "The Explore agent — a read-only scout",
    what_it_is:
      "A helper Claude that searches and reads across many files and reports back — it can look but never " +
      "change anything, and its reading never bloats your chat's memory.",
    how_to: [
      "Ask: \"use the Explore agent to find every place that handles X\"",
      "Works best with a clear question and a stated output (\"list the files and one line each\")",
    ],
    applies_to: ["compaction-burn", "missed-delegation"],
    source: "Claude Code docs",
    status: "verified",
    verified_by: "built-in agent type",
  },
  {
    id: "subagent-general-purpose",
    kind: "subagent",
    title: "The general-purpose agent — a do-anything helper",
    what_it_is:
      "A helper Claude for bounded multi-step jobs — research, a migration slice, a batch of ports — that " +
      "works in its own memory and returns a summary.",
    how_to: [
      "Delegate self-contained chunks: \"send an agent to port task X to the new format and report back\"",
      "The brief must be complete — the helper starts blank and can't ask follow-ups mid-job",
    ],
    applies_to: ["missed-delegation"],
    source: "Claude Code docs",
    status: "verified",
    verified_by: "built-in agent type",
  },
  {
    id: "custom-subagents",
    kind: "subagent",
    title: "Define your own agent types",
    what_it_is:
      "An agent type is just a role description + tool permissions in a small file. Teams define their own " +
      "(a reviewer, a domain expert) and Claude can then spawn them by name.",
    how_to: [
      "Create .claude/agents/<name>.md with frontmatter (name, description, tools) and the role prompt as the body",
      "Claude sees it in its agent list and can delegate to it: \"use the <name> agent for this\"",
    ],
    applies_to: [],
    source: "Claude Code docs",
    status: "verified",
    verified_by: "documented agent definition format",
  },
  {
    id: "superpowers-skill-pack",
    kind: "skill",
    title: "Superpowers — a community pack of engineering-process skills",
    what_it_is:
      "A well-known open-source collection of Claude Code skills for engineering process: planning, " +
      "test-driven development, systematic debugging, and more. Each skill loads expert guidance into a " +
      "session when its kind of task comes up.",
    how_to: [
      "Browse the collection first: github.com/obra/superpowers — read what each skill actually does",
      "Install selectively: copy the two or three skills that match YOUR work into ~/.claude/skills (or use its marketplace/plugin path)",
      "Invoke by name (/skill-name) or let matching tasks trigger them",
    ],
    notes:
      "Deliberately honest caution the hype posts skip: every installed skill adds its listing line to every " +
      "session's context — installing a whole large pack taxes all sessions and dilutes triggering. Pick the " +
      "few that match your work, not the pack.",
    applies_to: [],
    source: "community — obra/superpowers (indexed, not copied; lives in its author's repo)",
    status: "candidate",
  },
  {
    id: "using-skills",
    kind: "skill",
    title: "Skills — packaged expertise Claude loads on demand",
    what_it_is:
      "A skill is a packaged instruction set for one kind of task (frontend design, data viz, a deploy " +
      "checklist). Invoking one loads expert guidance into the session exactly when needed.",
    how_to: [
      "See what's available: type / in the input — skills appear as slash commands",
      "Invoke by name (/frontend-design) or just ask (\"use the frontend design skill for this page\")",
      "Project skills live in .claude/skills/ — teams ship their own",
    ],
    applies_to: [],
    source: "Claude Code docs",
    status: "verified",
    verified_by: "documented skills system",
  },
  {
    id: "frontend-design-skill",
    kind: "skill",
    title: "frontend-design — stop shipping generic-looking UIs",
    what_it_is:
      "An official plugin skill that loads a design-lead procedure when building web interfaces: " +
      "deliberate palette/typography choices, a self-critique pass, and explicit guards against the " +
      "templated look AI-generated pages tend to share.",
    how_to: [
      "Install from the official plugin catalog: /plugin, pick frontend-design (source: claude-plugins-official)",
      "It auto-invokes on UI work; you can also ask: \"use the frontend design skill for this page\"",
      "Strongest when your brief states the subject and audience — the skill turns that into specific visual choices",
    ],
    applies_to: [],
    source: "official plugin — claude-plugins-official/frontend-design",
    status: "verified",
    verified_by: "dogfooded: auto-invoked during damame's own dashboard redesign; visible before/after difference",
  },
  {
    id: "web-design-guidelines-skill",
    kind: "skill",
    title: "web-design-guidelines — an interface-quality checklist as a skill",
    what_it_is:
      "A community skill (Vercel Labs) that loads concrete web-interface guidelines — accessibility, " +
      "focus states, touch targets, typography details — so reviews and builds check against a real " +
      "standard instead of vibes.",
    how_to: [
      "Browse first: github.com/vercel-labs/agent-skills — read the skill before installing",
      "Install per its README (marketplace path or copy into ~/.claude/skills)",
      "Use it as an audit: \"review this page against the web design guidelines\" after building",
    ],
    applies_to: [],
    source: "community — vercel-labs/agent-skills (indexed, not copied; lives in its author's repo)",
    status: "verified",
    verified_by: "dogfooded: audit pass run against damame's own dashboard; produced real accessibility fixes",
  },
  {
    id: "dataviz-skill",
    kind: "skill",
    title: "dataviz — charts that are right by procedure, not taste",
    what_it_is:
      "A bundled skill for data visualization: pick the chart form from the data's job, validate the " +
      "palette with a script (colorblind-safety is computed, not eyeballed), and follow mark/label rules. " +
      "Useful whenever a session builds charts, dashboards, or reports.",
    how_to: [
      "It ships with Claude Code — no install; ask \"use the dataviz skill\" when building any chart",
      "Let it choose the chart form before any styling — that ordering is most of its value",
    ],
    applies_to: [],
    source: "bundled with Claude Code",
    status: "verified",
    verified_by: "bundled skill; documented behavior",
  },
  {
    id: "claude-api-skill",
    kind: "skill",
    title: "claude-api — for sessions that BUILD LLM apps",
    what_it_is:
      "A bundled skill loading current Anthropic API knowledge — correct SDK usage, model IDs, streaming, " +
      "tool use — so a session building an LLM-powered app writes against today's API instead of the " +
      "model's possibly-stale memory of it.",
    how_to: [
      "Ships with Claude Code — auto-invokes when you work on code that calls Claude",
      "Worth invoking explicitly when reviewing older LLM code: \"check this against the claude-api skill — anything deprecated?\"",
    ],
    applies_to: [],
    source: "bundled with Claude Code",
    status: "verified",
    verified_by: "bundled skill; documented behavior",
  },
  {
    id: "anthropic-document-skills",
    kind: "skill",
    title: "Anthropic document skills — real .docx/.pptx/.xlsx/.pdf output",
    what_it_is:
      "Anthropic's open-source skill collection includes document-creation skills that produce actual " +
      "Office files (Word, PowerPoint, Excel, PDF) with proper structure — for sessions whose deliverable " +
      "is a document rather than code.",
    how_to: [
      "Browse: github.com/anthropics/skills — each skill has its own folder and README",
      "Install only the format(s) you actually produce (see the caution)",
      "Then ask for the deliverable directly: \"produce this as a .docx\"",
    ],
    notes:
      "Same caution as every pack: each installed skill adds its listing line to every session's context. " +
      "Install the one format you use, not the collection.",
    applies_to: [],
    source: "community/official — anthropics/skills (indexed, not copied)",
    status: "candidate",
  },
  {
    id: "author-your-own-skill",
    kind: "skill",
    title: "Write your own skill — it's a folder with instructions",
    what_it_is:
      "A skill is just a folder containing SKILL.md: instructions for one kind of task, plus an " +
      "advertisement line (name + description) that tells Claude when to load it. Anyone can write one — " +
      "including Claude itself, on request.",
    how_to: [
      "Create ~/.claude/skills/<name>/SKILL.md (or .claude/skills/ in a project for team sharing)",
      "Top of the file: a one-line description of WHEN to use it — this line is the advertisement that drives auto-invocation, so make it precise",
      "Body: the procedure — steps, rules, pitfalls, examples",
      "Shortcut: ask Claude to write it — \"turn the procedure we just followed into a skill called <name>\"",
      "Test: next session, do a matching task and check the skill fires (or invoke via /<name>)",
    ],
    applies_to: [],
    source: "Claude Code docs",
    status: "verified",
    verified_by: "documented skills format",
  },

  // ————— the freeze card —————
  {
    id: "freeze-your-own-pattern",
    kind: "pattern",
    title: "You keep re-writing the same instructions — freeze them",
    what_it_is:
      "When the same procedure gets re-explained to Claude again and again (the same delegation prompt, " +
      "the same checklist), each retelling drifts a little and costs attention. The versions you already " +
      "wrote ARE the draft of a reusable skill or workflow — freezing them makes the best version the " +
      "only version.",
    how_to: [
      "Pick the rung that matches the repetition: same command after edits → hook · same request re-typed → slash command · same PROCEDURE re-explained → skill · same multi-step structure over changing inputs → workflow",
      "Collect your own instances (damame's evidence list shows every occurrence with its transcript line)",
      "Ask Claude: \"here are N versions of instructions I keep giving — merge them into a skill: write ~/.claude/skills/<name>/SKILL.md, include every rule from any version, and write a precise one-line description of when to use it\"",
      "For a workflow: same prompt, but \"save it as a reusable workflow script / slash command\" instead",
      "Next session, verify it fires — then stop re-typing forever",
    ],
    notes:
      "This is the answer for niche work no marketplace covers: nobody will ever publish a skill for your " +
      "exact use case — but you already wrote it, in installments, in your own transcript.",
    applies_to: ["repeated-delegation", "post-edit-ritual"],
    source: "curated from a real transcript (one task family re-improvised across 5 subagent spawns; 89 slash-command uses in the same session showing the frozen version wins)",
    status: "verified",
    verified_by: "pattern and cost observed in a real 80-day session damame analyzed",
  },
];
