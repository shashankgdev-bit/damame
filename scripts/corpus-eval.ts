/**
 * Prints the ground-truth precision/recall table over the synthetic corpus.
 * Usage: npx tsx scripts/corpus-eval.ts [perArchetype=10] [seed=42]
 */
import { evaluateCorpus, generateCorpus } from "@damame/corpus";

const per = Number(process.argv[2] ?? 10);
const seed = Number(process.argv[3] ?? 42);
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
  console.log("\nFAILURES:");
  for (const f of result.failures) console.log(`  ${f.kind}: ${f.rule} in ${f.archetype}#${f.seed}`);
  process.exit(1);
}
console.log("\nall planted patterns caught; zero false positives");
