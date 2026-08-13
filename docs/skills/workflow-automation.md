# Workflow Automation

Configuring repetition away: hooks, commands, project memory.

Every instruction you retype and every permission prompt you re-approve is
a recurring cost the harness can absorb once. Configuration — hooks,
CLAUDE.md, allowlists, custom commands — turns those repeats into defaults,
so each session starts closer to done.

## How damame measures it

Opportunity-aware: rate = uses / (uses + misses).

- **Misses:** each finding from the `permission-churn` rule — the same
  permission approved by hand again and again across sessions.
- **Uses:** one use per technique per session for `hooks`, `claude-md`,
  `permission-allowlists`, and `slash-commands`. The first three are probed
  from configuration on disk at profile time and labeled with that provenance.

## Techniques

### Hooks

Hooks run commands automatically on events — format after every edit,
notify when attention is needed. Anything you do manually after every AI
action is a hook waiting to be written. In Claude Code they are configured
under `hooks` in settings.json. Read from config, not transcripts.

### Project memory (CLAUDE.md)

A CLAUDE.md in your project is loaded every session: conventions, commands,
constraints. Instructions you've typed twice belong in it — the third
session gets them for free. Keep it short: every line rides along in every
session, so each carries a context cost. Read from config, not transcripts.

### Permission allowlists

Commands you approve every time (your test runner, your build) belong in
permissions.allow. Each entry converts a recurring interruption into
silence; in Claude Code these live in `.claude/settings.json`. Read from
config, not transcripts.

### Slash commands

Slash commands (/loop, /code-review, custom ones) trigger packaged behavior
in one keystroke. Recurring instructions you type by hand are candidates to
become one. Custom commands are markdown files in `.claude/commands/`; this
one is detected from transcripts when you invoke them.

## What this never means

- No `permission-churn` findings and no configured automation means recent
  work didn't call for it — neutral, not a deficit.
- The rate reflects practice observed in sessions and config, not ability.
- No comparison across people.
