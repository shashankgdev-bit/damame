import { describe, expect, it } from "vitest";
import { DETECTORS } from "@damame/rules";
import { entryFor, NO_ACTION_REFS, REGISTRY } from "../src/index.js";

describe("resource registry", () => {
  it("ships schema-valid entries with unique ids", () => {
    expect(REGISTRY.length).toBeGreaterThanOrEqual(20);
    const ids = REGISTRY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every verified entry names how it was verified", () => {
    for (const e of REGISTRY) {
      if (e.status === "verified") expect(e.verified_by, e.id).toBeTruthy();
    }
  });

  /**
   * COVERAGE GATE: every static recommendation ref any shipped detector can
   * emit must resolve to a shelf entry (or be an explicit no-action ref).
   * A detector pointing at a missing recipe is a broken promise to the user.
   */
  it("every detector recommendation ref resolves to an entry", () => {
    const staticRefs: Array<[string, string]> = [
      ["config", "enable-notifications"],
      ["config", "permissions-allowlist"],
      ["config", "stable-tool-availability"],
      ["prompting_pattern", "delegate-bulk-exploration"],
      ["prompting_pattern", "automate-data-ingestion"],
      ["prompting_pattern", "diagnose-before-retry"],
      ["prompting_pattern", "plan-mode-first"],
      ["prompting_pattern", "read-before-edit"],
      ["prompting_pattern", "reference-earlier-output"],
      ["prompting_pattern", "save-as-named-workflow"],
      ["prompting_pattern", "session-per-task-bootstrap"],
      ["prompting_pattern", "stable-prompt-prefix"],
      ["prompting_pattern", "targeted-reads"],
      ["subagent", "Explore"],
      ["subagent", "general-purpose"],
      ["config", "hooks-post-edit"],
    ];
    for (const [kind, ref] of staticRefs) {
      expect(entryFor(kind, ref), `${kind}:${ref}`).toBeDefined();
    }
    // dynamic fallbacks
    expect(entryFor("subagent", "some-custom-agent")!.id).toBe("custom-subagents");
    expect(entryFor("skill", "frontend-design")!.id).toBe("using-skills");
    // sanity: the registry knows about all shipped detectors it claims to serve
    const ruleIds = new Set(DETECTORS.map((d) => d.id));
    for (const e of REGISTRY) {
      for (const rule of e.applies_to) expect(ruleIds.has(rule), `${e.id} → ${rule}`).toBe(true);
    }
    expect(NO_ACTION_REFS.has("no-user-action")).toBe(true);
  });
});
