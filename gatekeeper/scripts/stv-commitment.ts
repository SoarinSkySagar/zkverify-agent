// Prints the Steal the VFY strategy commitment to register on the dashboard
// (My Agents → Edit agent → Steal the VFY). Never prints STRATEGY_PARAMS or STRATEGY_SALT.
//
//   npm run stv:commitment

import { computeCommitment, parseSalt, toHex32 } from "../src/stv/commitment.js";
import { parseStrategyParams } from "../src/stv/strategy.js";

try {
  const commitment = computeCommitment(parseStrategyParams(process.env.STRATEGY_PARAMS), parseSalt(process.env.STRATEGY_SALT));
  console.log("Strategy commitment = Poseidon(strategyParams[0..7], salt)\n");
  console.log(`  hex:     ${toHex32(commitment)}`);
  console.log(`  decimal: ${commitment}\n`);
  console.log("Register the hex value before Swiss Round 1; it is frozen once a match is paired.");
  console.log("Any change to STRATEGY_PARAMS or STRATEGY_SALT gives a different commitment (allowed only between rounds).");
} catch (e) {
  console.error(`Cannot compute commitment: ${(e as Error).message}`);
  process.exit(1);
}
