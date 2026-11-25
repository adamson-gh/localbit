// LocalBit: replay the real questions (test/replay_cases.json) - an answer that changed fails, so a deploy can't quietly break what
// agents already asked. Reports with an 'expect' (fixed ones) are checked too. node test/test_replay.mjs
import fs from "fs";
import { outcome } from "../bench/build_replay.mjs";
const read = f => JSON.parse(fs.readFileSync(new URL("../" + f, import.meta.url), "utf8"));
let ok = 0, bad = 0;
const changed = [];
for (const c of read("test/replay_cases.json").cases) {
  const got = outcome(c), e = c.expect;
  if (got.model_id === e.model_id && got.gpu_id === e.gpu_id && got.verdict === e.verdict) ok++;
  else { bad++; changed.push(`${c.model} on ${c.hardware}${c.context ? " @" + c.context : ""}: was ${e.model_id}/${e.gpu_id}/${e.verdict}, now ${got.model_id}/${got.gpu_id}/${got.verdict}`); }
}
const reps = read("test/report_cases.json").reports;
for (const r of reps.filter(r => r.expect)) {
  const got = outcome(r);
  if (got.verdict === r.expect.verdict && (!r.expect.model_id || got.model_id === r.expect.model_id)) ok++;
  else { bad++; changed.push(`report ${r.ts} (${r.problem}) came back: ${r.model} on ${r.hardware} -> ${got.verdict}`); }
}
for (const c of changed.slice(0, 15)) console.log("FAIL " + c);
console.log(`${ok} passed, ${bad} failed (replay: ${read("test/replay_cases.json").cases.length} real questions, ${reps.filter(r => r.status === "open").length} reports open)`);
process.exit(bad ? 1 : 0);
