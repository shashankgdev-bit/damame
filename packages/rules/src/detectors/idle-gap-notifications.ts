import type { Finding } from "@damame/ir";
import type { Detector } from "../types.js";
import { eventRefs, finding, formatDuration } from "../helpers.js";

/**
 * Fires when finished work repeatedly sat waiting: the session contains at
 * least `min_gaps` idle gaps of `min_gap_ms` or longer between a turn ending
 * and the next human prompt, and those gaps sum to `min_total_ms` or more.
 * The signal is the *absence of a notification channel*, not the human's
 * absence — stepping away is fine and normal; the inefficiency is that
 * nothing told them the work was done, so it aged silently.
 *
 * No savings block is emitted, deliberately: away-time is not recoverable
 * token or compute waste, and claiming the summed idle time as "savings"
 * would be dishonest — the human may have been doing other work. This is a
 * gentle nudge (severity always "minor") toward enabling notifications.
 *
 * `idle_gaps_ms` carries no event ids (it is a bare array of millisecond
 * gaps), so the session's first event is cited as the single evidence event
 * the schema requires; the numbers the rule keyed on live in
 * `evidence.metrics`.
 */
/** Tools whose presence marks a deliberately self-pacing/overnight session:
 * gaps there are the design, not unnoticed waiting. */
const SCHEDULING_TOOLS = new Set(["ScheduleWakeup", "CronCreate"]);

export const idleGapNotifications: Detector = {
  id: "idle-gap-notifications",
  version: "0.3.0", // 0.3.0: gaps containing a resume boundary excluded at the metric level — closed-app nights are not unnoticed waiting (second real-data applicability fix: 260 "idle" hours on a 16-day session were the user's nights). 0.2.0: silent on scheduling-driven sessions (ScheduleWakeup/cron) — deliberate overnight running is not "waiting unnoticed"
  category: "missed-resource",
  summary: "Finished work repeatedly waited unnoticed between turns — no notification signal was in place",
  defaults: {
    min_gap_ms: 300_000,
    /** Gaps at or above this are walk-aways (nights, weekends, deliberate
     * leaves) — a notification would not have brought the user back sooner.
     * Calibrated on the one real attended multi-day session available:
     * gap distribution showed 103 gaps under 2h, a valley of 11 in 2–8h,
     * then 15 overnight gaps at 8h+. The ceiling sits at the valley's
     * left edge. */
    max_gap_ms: 7_200_000,
    min_gaps: 5,
    min_total_ms: 1_800_000,
  },
  detect(ctx): Finding[] {
    const minGapMs = ctx.config.min_gap_ms as number;
    const maxGapMs = ctx.config.max_gap_ms as number;
    const minGaps = ctx.config.min_gaps as number;
    const minTotalMs = ctx.config.min_total_ms as number;

    // A session that schedules its own wake-ups (autonomous loops, overnight
    // runs) *chose* its gaps; flagging them as unnoticed waiting was this
    // rule's first measured applicability failure. Real user feedback, real
    // suppression condition.
    const isSchedulingDriven = ctx.session.events.some(
      (e) => e.kind === "tool_call" && SCHEDULING_TOOLS.has(e.name) && !e.on_abandoned_branch,
    );
    if (isSchedulingDriven) return [];

    const qualifying = ctx.metrics.idle_gaps_ms.filter((gap) => gap >= minGapMs && gap < maxGapMs);
    if (qualifying.length < minGaps) return [];
    const totalIdleMs = qualifying.reduce((sum, gap) => sum + gap, 0);
    if (totalIdleMs < minTotalMs) return [];

    // The metric carries no event ids, so cite the session's first event as
    // the schema-required anchor (evidence.events must be non-empty).
    const firstEvent = ctx.session.events[0];
    if (!firstEvent) return [];
    const largestGapMs = Math.max(...qualifying);

    return [
      finding({
        rule: { id: this.id, version: this.version },
        category: this.category,
        severity: "minor",
        confidence: { source: "deterministic" },
        title: `Finished work waited unnoticed ${qualifying.length} times (${formatDuration(totalIdleMs)} total)`,
        description:
          `${qualifying.length} times in this session, Claude finished a turn and the next human prompt ` +
          `arrived ${formatDuration(minGapMs)} or more later — ${formatDuration(totalIdleMs)} of completed ` +
          `work sitting ready in total (largest single wait ${formatDuration(largestGapMs)}). Gaps longer ` +
          `than ${formatDuration(maxGapMs)} are treated as deliberate walk-aways (nights, weekends) and not ` +
          `counted. Being away is fine and normal; the inefficiency is that no notification signal announced ` +
          `the work was done, so it aged silently instead of interrupting you when ready.`,
        evidence: {
          events: eventRefs(ctx.session, [firstEvent.event_id]),
          metrics: {
            gap_count: qualifying.length,
            total_idle_ms: totalIdleMs,
            largest_gap_ms: largestGapMs,
          },
        },
        recommendation: {
          resource: { kind: "config", ref: "enable-notifications" },
          rationale:
            "Claude Code can notify you when a turn finishes or needs input — terminal bell or system " +
            "notification via /config, and mobile push when available — so waiting work interrupts you " +
            "instead of silently aging until you happen to check back.",
        },
      }),
    ];
  },
};
