/** Alias for `damame eval` — kept for muscle memory and older docs. */
import { runEval } from "../apps/cli/src/eval-cmd.js";
await runEval({ per: process.argv[2] ?? "10", seed: process.argv[3] ?? "42" });
