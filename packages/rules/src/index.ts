import type { Finding, GradingVersion, Session } from "@damame/ir";
import type { MetricsBundle } from "@damame/metrics";
import type { Detector, RuleConfig } from "./types.js";
import { sortFindings } from "./helpers.js";
import { editFailLoop } from "./detectors/edit-fail-loop.js";
import { cacheThrash } from "./detectors/cache-thrash.js";
import { duplicateToolCall } from "./detectors/duplicate-tool-call.js";
import { compactionBurn } from "./detectors/compaction-burn.js";
import { permissionChurn } from "./detectors/permission-churn.js";
import { bashErrorLoop } from "./detectors/bash-error-loop.js";
import { abandonedWork } from "./detectors/abandoned-work.js";
import { missedDelegation } from "./detectors/missed-delegation.js";
import { oversizedContextReads } from "./detectors/oversized-context-reads.js";
import { retryStorm } from "./detectors/retry-storm.js";

export type { Detector, DetectorContext, RuleConfig } from "./types.js";
export * from "./helpers.js";

/**
 * The v1 registry. Order is presentation-stable but has no semantic meaning;
 * findings are ranked by severity. Rule ids are permanent — a retired rule
 * moves to TOMBSTONED_RULE_IDS instead of being deleted or reused.
 */
export const DETECTORS: Detector[] = [
  editFailLoop,
  cacheThrash,
  duplicateToolCall,
  compactionBurn,
  permissionChurn,
  bashErrorLoop,
  abandonedWork,
  missedDelegation,
  oversizedContextReads,
  retryStorm,
];

export const TOMBSTONED_RULE_IDS: string[] = [];

export function registerDetector(detector: Detector): void {
  if (TOMBSTONED_RULE_IDS.includes(detector.id)) {
    throw new Error(`rule id "${detector.id}" is tombstoned and cannot be reused`);
  }
  if (DETECTORS.some((d) => d.id === detector.id)) {
    throw new Error(`rule id "${detector.id}" already registered`);
  }
  DETECTORS.push(detector);
}

export interface RunOptions {
  /** Per-rule threshold overrides: { "edit-fail-loop": { min_consecutive_failures: 4 } } */
  config?: Record<string, RuleConfig>;
  /** Restrict to specific rule ids (default: all). */
  only?: string[];
}

export function runRules(session: Session, metrics: MetricsBundle, options: RunOptions = {}): Finding[] {
  const findings: Finding[] = [];
  for (const detector of DETECTORS) {
    if (options.only && !options.only.includes(detector.id)) continue;
    const config = { ...detector.defaults, ...(options.config?.[detector.id] ?? {}) };
    findings.push(
      ...detector.detect({ session, metrics, env: session.environment, config }),
    );
  }
  return sortFindings(findings);
}

export function gradingVersion(session: Session, damameVersion: string): GradingVersion {
  return {
    damame_version: damameVersion,
    ir_version: session.ir_version,
    adapter: session.source.adapter,
    adapter_version: session.source.adapter_version,
    rule_versions: Object.fromEntries(DETECTORS.map((d) => [d.id, d.version])),
  };
}
