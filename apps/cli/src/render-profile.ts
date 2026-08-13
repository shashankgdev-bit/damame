import pc from "picocolors";
import type { Profile, SkillProfile } from "@damame/profile";
import { formatDuration, formatTokens } from "@damame/rules";

const STATE_BADGE: Record<SkillProfile["state"], string> = {
  practiced_well: pc.green("● practiced well"),
  opportunities_missed: pc.yellow("◐ opportunities missed"),
  not_needed: pc.dim("○ not needed recently"),
  getting_started: pc.cyan("◔ getting started"),
};

export function renderProfile(profile: Profile): string {
  const lines: string[] = [];
  const g = profile.generated_from;
  lines.push("");
  lines.push(pc.bold("damame · your AI development skills"));
  lines.push(pc.dim(`${g.sessions} sessions · ${g.from ?? "?"} → ${g.to ?? "?"} · assessed over the last ${g.window_days} days`));
  if (profile.sparse) {
    lines.push(pc.dim("sparse data: trends and rates firm up as more sessions accumulate"));
  }
  lines.push("");

  if (profile.recommendations.length > 0) {
    lines.push(pc.bold("Worth acting on"));
    for (const rec of profile.recommendations) {
      lines.push(`  ${pc.yellow("→")} ${rec.headline}`);
      lines.push(pc.dim(`    try: ${rec.technique_title} — ${rec.lesson.split(". ")[0]}.`));
    }
    lines.push("");
  }

  lines.push(pc.bold("Skills"));
  for (const skill of profile.skills) {
    const rate =
      skill.rate !== null
        ? ` · used when needed: ${skill.uses} of ${skill.uses + skill.misses}`
        : "";
    const trend = skill.trend === "up" ? pc.green(" ↑") : skill.trend === "down" ? pc.yellow(" ↓") : "";
    lines.push(`  ${pc.bold(skill.title.padEnd(26))} ${STATE_BADGE[skill.state]}${rate}${trend}`);
    if (skill.state === "opportunities_missed") {
      const cost = [
        skill.missed_tokens > 0 ? `~${formatTokens(skill.missed_tokens)} tokens` : "",
        skill.missed_wall_ms > 60_000 ? formatDuration(skill.missed_wall_ms) : "",
      ]
        .filter(Boolean)
        .join(" · ");
      if (cost) lines.push(pc.dim(`    measured waste: ${cost}`));
    }
    if (skill.suggestion) {
      lines.push(pc.dim(`    next: ${skill.suggestion.title} — ${skill.suggestion.reason}`));
    }
  }

  lines.push("");
  const c = profile.technique_coverage;
  lines.push(`${pc.bold("Techniques tried:")} ${c.tried} of ${c.total}  ${pc.dim("(damame ui → skills for the full list with lessons)")}`);
  lines.push("");
  lines.push(pc.dim(profile.methodology_note));
  lines.push("");
  return lines.join("\n");
}
