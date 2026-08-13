# Tooling Fluency

Knowing the ecosystem: skills, MCP tools, research tools.

Much of the leverage in AI-assisted development lives in the harness around
the model — skills, MCP servers, slash commands, in-session research. Knowing
what exists means one packaged line where others re-explain or copy-paste.

## How damame measures it

This is the one coverage-mode skill: breadth-based, with no miss concept.
There are no miss rules, no missed opportunities, and no nagging — damame
never claims you should have used a tool you didn't.

- **Uses:** one use per technique per session for `custom-skills`,
  `mcp-tools`, `web-research`, and `slash-commands`.
- **State:** comes from distinct techniques observed across sessions, not a
  rate: two or more is the practiced floor; fewer reads as getting started.

## Techniques

### Using skills

Skills are packaged expertise — a review checklist, a deploy procedure, a
design method — loaded on demand. Invoking one replaces re-explaining the
same instructions every session. In Claude Code, skills live in
`.claude/skills/` or arrive via plugins, and load through the Skill tool or
a slash command.

### Slash commands

Slash commands (/loop, /code-review, custom ones) trigger packaged behavior
in one keystroke. Recurring instructions you type by hand are candidates to
become one. Type `/` in Claude Code to browse what's already installed.

### MCP tools

MCP servers connect the AI to external systems — drives, calendars,
databases, internal APIs. Work that round-trips through copy-paste is often
one connected tool away from direct. `claude mcp add` wires a server in;
its tools then appear to the agent as `mcp__server__tool`.

### Web research in-session

WebSearch and WebFetch let the AI check current docs and facts instead of
guessing from training data. For anything version-sensitive,
research-then-answer beats recall. Asking "check the current docs first" is
usually all it takes to trigger it.

## What this never means

- An unused technique is not a deficit — coverage mode has no misses, and
  damame never suggests a tool you should have reached for.
- Coverage counts what your recent work has touched, not what you know.
- No comparison across people.
