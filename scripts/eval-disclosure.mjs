/**
 * eval-disclosure — compare the disclosure judge's `omitted` list with the
 * real debt chip (stored `coverage.uncovered` from the last checkpoint, as
 * eval-session wrote it to stage13-checks.json). Passes when every uncovered
 * path is named — inclusion, not equality: naming the excluded groups' paths
 * too is fine.
 *
 *   node scripts/eval-disclosure.mjs <judge.json> <checks.json>
 *
 * Exit 0 = PASS, or `disclosure: not exercised (0 uncovered)` when the board
 * left nothing uncovered (the judge had nothing to name, so nothing was
 * tested); 1 = an uncovered path was not named; 2 = cannot judge: bad input,
 * eval-session's ledger did not reconcile, or its run was VACUOUS.
 */
import { readFileSync } from 'node:fs';
import { disclosureVerdict } from './eval-lib.mjs';

const [judgePath, checksPath] = process.argv.slice(2);
if (!judgePath || !checksPath) {
  console.error('usage: node scripts/eval-disclosure.mjs <judge.json> <checks.json>');
  process.exit(2);
}
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    console.error(`cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}
const judge = readJson(judgePath);
const checks = readJson(checksPath);
if (!Array.isArray(judge.omitted)) {
  console.error('judge JSON has no "omitted" array');
  process.exit(2);
}
const v = disclosureVerdict({ omitted: judge.omitted, checks });
console.log(v.line);
for (const p of v.missing) console.log(`  not named: ${p}`);
// Informational: the judge's own answer to "does the arithmetic reconcile?".
if (typeof judge.reconciles === 'boolean') console.log(`  judge reconciles: ${judge.reconciles}`);
process.exit(v.exit);
