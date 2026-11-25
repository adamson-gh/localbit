// LocalBit replay cases (Nov 25 - a lesson from running a home assistant: replay real questions before every change). Reads the real asks exported from
// the log (backups/asks.json - model, hardware, context, quant as asked; never who) and the reports (backups/reports.json), and adds
// any new ones to test/replay_cases.json and test/report_cases.json with today's answer as the expected one.
//   node bench/build_replay.mjs            add new cases
//   node bench/build_replay.mjs --accept   also take today's answers as expected for every case (after a deliberate change)
import fs from "fs";
import { findModel, findGpu, estimate } from "../src/estimate.js";
const root = new URL("../", import.meta.url);
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(new URL(f, root), "utf8")); } catch { return d; } };
const M = read("data/models.json", {}), G = read("data/gpus.json", {});
export function outcome(c) {
  const m = findModel(c.model, M.models), g = findGpu(c.hardware, G.gpus);
  if (!m || !g) return { model_id: m ? m.id : null, gpu_id: g ? g.id : null, verdict: "unknown" };
  const e = estimate(m, g, { context: c.context, quant: c.quant }, M.quants);
  return { model_id: m.id, gpu_id: g.id, verdict: e.verdict };
}
const key = c => [c.model, c.hardware, c.context || "", c.quant || ""].map(x => String(x).toLowerCase().trim()).join("|");
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || process.argv[1].endsWith("build_replay.mjs")) {
  const accept = process.argv.includes("--accept");
  const cases = read("test/replay_cases.json", { _about: "Real questions agents and people asked LocalBit, with the answer they got. test/test_replay.mjs fails when an answer changes; re-run bench/build_replay.mjs --accept after a deliberate change.", cases: [] });
  const have = new Set(cases.cases.map(key));
  let added = 0;
  for (const a of read("backups/asks.json", [])) {
    const c = { model: a.model_q, hardware: a.hw_q, ...(a.context ? { context: a.context } : {}), ...(a.quant ? { quant: a.quant } : {}) };
    if (!c.model || !c.hardware || c.model === "..." || c.hardware === "..." || have.has(key(c))) continue;
    cases.cases.push({ ...c, expect: outcome(c), added: new Date().toISOString().slice(0, 10) }); have.add(key(c)); added++;
  }
  if (accept) for (const c of cases.cases) c.expect = outcome(c);
  fs.writeFileSync(new URL("test/replay_cases.json", root), JSON.stringify(cases, null, 1));
  const reps = read("test/report_cases.json", { _about: "Every report that an answer was wrong (Nov 25 - a lesson from running a home assistant: each complaint becomes a test). status: open until reviewed; an 'expect' added when fixed is then checked by test/test_replay.mjs.", reports: [] });
  const rk = new Set(reps.reports.map(r => r.ts + r.problem));
  let rn = 0;
  for (const r of read("backups/reports.json", [])) {
    if (rk.has(r.ts + r.problem)) continue;
    reps.reports.push({ ts: r.ts, problem: r.problem, model: r.model_q, hardware: r.hw_q, context: r.context, observed_tokens_per_s: r.obs_tps, observed_memory_gb: r.obs_mem_gb, runtime: r.runtime, note: r.note, status: "open" }); rn++;
  }
  fs.writeFileSync(new URL("test/report_cases.json", root), JSON.stringify(reps, null, 1));
  console.log(`REPLAY cases ${cases.cases.length} (+${added})${accept ? " accepted" : ""} · reports ${reps.reports.length} (+${rn}, open ${reps.reports.filter(r => r.status === "open").length})`);
}
