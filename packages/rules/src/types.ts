import type { EnvironmentSnapshot, Finding, FindingCategory, Session } from "@damame/ir";
import type { MetricsBundle } from "@damame/metrics";

export type RuleConfig = Record<string, number | string | boolean>;

export interface DetectorContext {
  session: Session;
  metrics: MetricsBundle;
  env: EnvironmentSnapshot | undefined;
  /** Merged thresholds: detector defaults overridden by user config. */
  config: RuleConfig;
}

/**
 * A detector is a pure function of its context: no IO, no LLM, no clock.
 * Same session in → same findings out, always. Threshold defaults are part of
 * the rule's versioned surface (minor bump when they change; major bump when
 * firing conditions change; ids are never reused).
 */
export interface Detector {
  id: string;
  version: string;
  category: FindingCategory;
  /** Human summary shown in `damame rules`; the full doc lives in docs/rules/<id>.md. */
  summary: string;
  defaults: RuleConfig;
  detect(ctx: DetectorContext): Finding[];
}
