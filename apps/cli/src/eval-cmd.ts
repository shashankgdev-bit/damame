import pc from "picocolors";

/**
 * `damame eval` — run the ground-truth evaluation and print the per-rule
 * precision/recall table. The corpus manufactures sessions with waste
 * planted by construction plus innocent near-misses built one unit under
 * each threshold, then runs the REAL production pipeline over them and
 * compares against each session's answer sheet. Any miss or false positive
 * exits 1 and names archetype#seed — the same seed regenerates the failing
 * session byte-identically.
 */
export async function runEval(opts: { per: string; seed: string }): Promise<void> {
  const { evaluateCorpus, generateCorpus } = await import("@damame/corpus");
  const per = Number(opts.per);
  const seed = Number(opts.seed);
  const corpus = generateCorpus(per, seed);
  const result = await evaluateCorpus(corpus);

  console.log(`corpus: ${result.sessions} sessions (${per}/archetype, seed ${seed})`);
  console.log("rule".padEnd(26) + "planted  caught  forbidden-in  false-pos  recall  precision");
  for (const s of result.scores) {
    console.log(
      s.rule_id.padEnd(26) +
        String(s.expected_sessions).padEnd(9) +
        String(s.fired_when_expected).padEnd(8) +
        String(s.forbidden_sessions).padEnd(14) +
        String(s.false_positives).padEnd(11) +
        (s.recall === null ? "—" : s.recall.toFixed(2)).padEnd(8) +
        (s.precision === null ? "—" : s.precision.toFixed(2)),
    );
  }
  if (result.failures.length) {
    console.log(pc.red("\nFAILURES:"));
    for (const f of result.failures) console.log(pc.red(`  ${f.kind}: ${f.rule} in ${f.archetype}#${f.seed}`));
    process.exitCode = 1;
    return;
  }
  console.log(pc.green("\nall planted patterns caught; zero false positives"));
}
