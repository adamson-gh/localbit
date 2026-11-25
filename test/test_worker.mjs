import fs from "fs";
// LocalBit: the Worker answered as an agent would call it - MCP and the plain API - with a fake log database. node test/test_worker.mjs
import worker from "../src/worker.js";
let ok = 0, bad = 0;
const check = (name, cond, got) => { cond ? ok++ : bad++; console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : "  got: " + JSON.stringify(got).slice(0, 300))); };
const rows = [];
const env = { STATS_KEY: "made-up-key", DB: { prepare: sql => ({ bind: (...v) => ({ run: async () => { rows.push(v); }, all: async () => ({ results: [] }) }) }) } };
const waits = []; const ctx = { waitUntil: p => waits.push(p) };
const call = async (path, init = {}) => worker.fetch(new Request("https://localbit.example.workers.dev" + path, init), env, ctx);
const rpc = async (body, ua = "Claude-User") => { const r = await call("/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "user-agent": ua }, body: JSON.stringify(body) }); return [r.status, r.status === 202 ? null : await r.json()]; };

let [st, j] = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "made-up-agent", version: "1.0" }, capabilities: {} } });
check("initialize: the version asked for, tools offered, a name", st === 200 && j.result.protocolVersion === "2025-06-18" && j.result.capabilities.tools && j.result.serverInfo.name === "localbit", j);
[st] = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
check("a notification gets 202 and no body", st === 202, st);
[st, j] = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
check("six tools: five read-only answers and report_issue", j.result.tools.length === 6 && j.result.tools.filter(t => t.annotations.readOnlyHint).length === 5 && j.result.tools.some(t => t.name === "report_issue" && !t.annotations.readOnlyHint), j.result.tools.map(t => t.name));
[st, j] = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "check_fit", arguments: { model: "qwen3.8:27b", hardware: "RTX 3090", context: 16384 } } });
const sc = j.result.structuredContent;
check("check_fit on the test machine: fits, and the speed is the measured one", sc.verdict === "fits" && sc.basis === "measured" && /4[78]\.\d+ tokens\/s measured/.test(j.result.content[0].text), j.result.content[0].text);
check("answers say when the data is current as of (text and JSON), and when the speed was measured", /Data as of: specs 2026-11-25/.test(j.result.content[0].text) && sc.data_as_of && sc.data_as_of.specs === "2026-11-25" && /measured 2026-11-25/.test(j.result.content[0].text), j.result.content[0].text);
{ const pg = await (await call("/run/qwen3.8-27b/on/rtx-3090")).text(); const lt = await (await call("/llms.txt")).text();
  check("pages and llms.txt show the as-of date", /Data as of: specs 2026-11-25/.test(pg) && /Data as of: specs 2026-11-25/.test(lt), lt.slice(-200)); }
[st, j] = await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "check_fit", arguments: { model: "Llama 3.3 70B", hardware: "rtx 3090" } } });
check("70B on a 3090: doesn't fit, partly on the processor, with ways forward", j.result.structuredContent.verdict === "does_not_fit" && j.result.structuredContent.partly_on_cpu && j.result.structuredContent.suggestions.length > 0, j.result.structuredContent);
[st, j] = await rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "check_fit", arguments: { model: "made-up-model", hardware: "made-up card" } } });
check("unknown model and card: an error answer that says what to try", j.result.isError === true && /Add its size/.test(j.result.content[0].text) && /list_known/.test(j.result.content[0].text), j.result);
[st, j] = await rpc({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "suggest_models", arguments: { hardware: "16 GB" } } });
check("suggest_models for a 16 GB card lists models", j.result.structuredContent.models.length > 3, j.result.structuredContent);
[st, j] = await rpc({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "no_such_tool", arguments: {} } });
check("unknown tool -> a JSON-RPC error", j.error && j.error.code === -32602, j);
[st, j] = await rpc({ jsonrpc: "2.0", id: 8, method: "made/up" });
check("unknown method -> method not found", j.error && j.error.code === -32601, j);
let r = await call("/mcp");
check("GET /mcp -> 405 POST only", r.status === 405, r.status);
r = await call("/api/check?model=llama%203.1%208b&hardware=rtx%204060");
j = await r.json();
check("plain API answers too", r.status === 200 && j.verdict === "fits" && j.answer.includes("Llama 3.1 8B"), j);
r = await call("/run/llama-3.1-8b/on/rtx-4060");
check("a model-and-card page renders", r.status === 200 && (await r.text()).includes("Can Llama 3.1 8B run on NVIDIA GeForce RTX 4060?"), r.status);
r = await call("/sitemap.xml"); const sm = await r.text();
check("the sitemap lists every model-and-card page", (sm.match(/<loc>/g) || []).length > 500, (sm.match(/<loc>/g) || []).length);
r = await call("/llms.txt");
check("llms.txt describes the doors", (await r.text()).includes("/mcp"), "");
r = await call("/stats");
check("/stats without the key is refused", r.status === 403, r.status);
r = await call("/stats", { headers: { authorization: "Bearer made-up-key" } });
check("/stats with the key answers", r.status === 200, r.status);
await Promise.all(waits);
const flat = JSON.stringify(rows);
check("calls were logged (init, list, tool calls, api, page)", rows.length >= 8, rows.length);
check("the log holds what was asked and the agent's name - and no address", flat.includes("made-up-agent") && flat.includes("qwen3.8:27b") && flat.includes("Claude-User") && !/\d+\.\d+\.\d+\.\d+/.test(flat.replace(/qwen3\.8|"0\.\d+"|1\.0/g, "")), rows.slice(0, 3));

// reports, about page, open data, rate limits
{ const before = rows.length;
  const [s2, j2] = await rpc({ jsonrpc: "2.0", id: 40, method: "tools/call", params: { name: "report_issue", arguments: { problem: "wrong_speed", model: "llama 3.1 8b", hardware: "rtx 4060", observed_tokens_per_s: 38, runtime: "Ollama 0.40", note: "slower than said, mail me at someone@example.com or 555-123-4567 https://x.example/y" } } });
  await Promise.all(waits);
  const rep = rows.slice(before).find(v => v.includes("wrong_speed"));
  check("report_issue over MCP: recorded with matched ids and the speed seen", s2 === 200 && j2.result.structuredContent.recorded && rep && rep.includes("llama-3.1-8b") && rep.includes("rtx-4060") && rep.includes(38), [j2, rep]);
  check("report notes lose emails, phone numbers and links", rep && !/someone@|555-123|x\.example/.test(rep.join(" ")) && /\[email removed\]/.test(rep.join(" ")), rep); }
{ const r = await call("/api/report", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "problem=wrong_fit&model=gemma-3-27b&hardware=rtx-3090&note=ran+out+of+memory" });
  check("the page form gets a thank-you page", r.status === 200 && /Thanks/.test(await r.text())); }
{ const r = await call("/api/report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ problem: "missing_hardware", hardware: "Arc B580" }) });
  const jj = await r.json(); check("JSON reports work too", r.status === 200 && jj.recorded, jj); }
{ const pg = await (await call("/run/qwen3.8-27b/on/rtx-3090")).text();
  check("result pages carry the report form and the about link", /action="[^"]*\/api\/report"/.test(pg) && /\/about"/.test(pg)); }
{ const ab = await (await call("/about")).text();
  check("about page: who runs it, privacy, CC BY data license, limits, accuracy", /adamson-gh/.test(ab) && /Not recorded: IP addresses/.test(ab) && /CC BY 4\.0/.test(ab) && /120 requests a minute/.test(ab) && /Check before you buy/.test(ab)); }
{ const m = await (await call("/api/measured")).json(); check("open data endpoint names its license", /CC BY 4\.0/.test(m.license) && Array.isArray(m.measured) && m.measured.length >= 1, m); }
{ const lt = await (await call("/llms.txt")).text(); check("llms.txt lists report_issue, the license and the limits", /report_issue/.test(lt) && /CC BY 4\.0/.test(lt) && /120 requests/.test(lt)); }
{ const env2 = { ...env, LIMITER: { limit: async () => ({ success: false }) } };
  const r = await worker.fetch(new Request("https://localbit.example.workers.dev/api/check?model=x&hardware=y"), env2, ctx);
  check("over the limit: 429 with Retry-After", r.status === 429 && r.headers.get("retry-after") === "60", r.status);
  const st2 = await worker.fetch(new Request("https://localbit.example.workers.dev/stats", { headers: { authorization: "Bearer made-up-key" } }), env2, ctx);
  check("the owner's stats aren't rate-limited", st2.status === 200, st2.status); }
{ const pg = await (await call("/measured")).text();
  const mj = JSON.parse(fs.readFileSync(new URL("../data/measured.json", import.meta.url)));
  const n = new Set(mj.measured.map(r => r.model)).size;
  check("the /measured page lists every measured model, with a link to the data and the repo", (n === 0 ? /No results yet/.test(pg) : (pg.match(/<tr><td>/g) || []).length === n) && /api\/measured/.test(pg) && /github\.com\/adamson-gh\/localbit/.test(pg), n);
  const hm = await (await call("/")).text(); check("the home page links to it", /\/measured"/.test(hm)); }
{ const ck = await (await call("/check?model=llama%203.1%208b&hardware=rtx%204060")).text();
  check("people can ask on the site: /check shows the verdict, memory and speed", /verdict v-fits/.test(ck) && /Memory needed/.test(ck) && /tokens\/s/.test(ck), ck.slice(0, 200));
  const nf = await (await call("/check?model=llama%203.3%2070b&hardware=rtx%203090")).text();
  check("...a model that doesn't fit says so and how far over", /v-does_not_fit/.test(nf) && /GB over/.test(nf));
  const un = await call("/check?model=zzz-made-up&hardware=rtx%204060");
  check("...an unknown model gets a friendly page, not an error", un.status === 200 && /not sure about that one/.test(await un.text())); }
{ const st = await (await call("/stats", { headers: { authorization: "Bearer made-up-key" } })).json();
  const mj = JSON.parse(fs.readFileSync(new URL("../data/measured.json", import.meta.url)));
  check("stats compare the estimate with every measurement (drift %)", Array.isArray(st.estimate_drift) && st.estimate_drift.length === mj.measured.length && st.estimate_drift.every(d => typeof d.off_pct === "number"), st.estimate_drift); }
{ const [s1, j1] = await rpc({ jsonrpc: "2.0", id: 60, method: "tools/call", params: { name: "check_fit", arguments: { model: "qwen3.8-27b" } } });
  check("check_fit with no hardware says what's missing (not 'undefined')", j1.result.isError && /hardware missing/.test(j1.result.content[0].text) && !/undefined/.test(j1.result.content[0].text), j1.result.content[0].text);
  const [s2, j2] = await rpc({ jsonrpc: "2.0", id: 61, method: "tools/call", params: { name: "suggest_models", arguments: { hardware: "rtx 3090" } } });
  const q = j2.result.structuredContent.models.find(x => /Qwen3\.8/.test(x.model));
  check("suggest_models uses a measured speed where the node has one", q && q.basis === "measured" && /tokens\/s measured/.test(j2.result.content[0].text), q); }
{ const [s, j] = await rpc({ jsonrpc: "2.0", id: 70, method: "tools/call", params: { name: "compare", arguments: { a_model: "gemma 4 e4b", a_hardware: "rtx 3090", b_model: "qwen3.8 27b" } } });
  const tx = j.result.content[0].text;
  check("compare: two models on one card - fit, speed, room, quality/energy note, as-of", !j.result.isError && /Gemma 4 E4B vs Qwen3\.8 27B on/.test(tx) && /Speed: Gemma 4 E4B is faster/.test(tx) && /Room left:/.test(tx) && /Data as of/.test(tx), tx);
  const [s2, j2] = await rpc({ jsonrpc: "2.0", id: 71, method: "tools/call", params: { name: "compare", arguments: { a_model: "llama 3.1 8b", a_hardware: "rtx 4060", b_hardware: "rtx 4090" } } });
  check("compare: one model on two cards", !j2.result.isError && /RTX 4060 vs NVIDIA GeForce RTX 4090|4060 vs .*4090/.test(j2.result.content[0].text), j2.result.content[0].text);
  const [s3, j3] = await rpc({ jsonrpc: "2.0", id: 72, method: "tools/call", params: { name: "compare", arguments: { a_model: "llama 3.1 8b", a_hardware: "rtx 4060" } } });
  check("compare with nothing to compare against says so", j3.result.isError && /second model/.test(j3.result.content[0].text));
  const [s4, j4] = await rpc({ jsonrpc: "2.0", id: 73, method: "tools/call", params: { name: "node_log", arguments: {} } });
  const mj = JSON.parse(fs.readFileSync(new URL("../data/measured.json", import.meta.url)));
  check("node_log lists each measured model once", j4.result.structuredContent.readings.length === new Set(mj.measured.map(r => r.model)).size, j4.result.structuredContent.readings.length);
  const lp = await call("/log"), rs = await call("/log.rss"), cp = await call("/compare?a_model=gemma%204%20e4b&a_hardware=rtx%203090&b_model=qwen3.8%2027b");
  check("pages: /log, /log.rss (valid feed) and /compare", lp.status === 200 && /Node log/.test(await lp.text()) && /<rss version="2.0">/.test(await rs.text()) && /is faster/.test(await cp.text())); }
{ const r1 = await rpc({ jsonrpc: "2.0", id: 80, method: "tools/call", params: { name: "check_fit", arguments: { model: "deepseek r1 14b", hardware: "rtx 3090" } } });
  check("a model known by another name says what it was sized as", /built on the same design as Qwen2\.5 14B/.test(r1[1].result.content[0].text), r1[1].result.content[0].text);
  const r2 = await rpc({ jsonrpc: "2.0", id: 81, method: "tools/call", params: { name: "check_fit", arguments: { model: "llama 4 scout", hardware: "rtx 4090" } } });
  check("an unknown model gets the closest known names", /Closest known: Llama/.test(r2[1].result.content[0].text) && r2[1].result.structuredContent.closest_models.length > 0, r2[1].result.content[0].text);
  const r3 = await rpc({ jsonrpc: "2.0", id: 82, method: "tools/call", params: { name: "check_fit", arguments: { model: "mistral 7b", hardware: "macbook air m2 16gb" } } });
  check("a Mac not listed by name is treated as a Mac (75% of unified memory), not a 16 GB graphics card", /Apple M2 \(16 GB\)/.test(r3[1].result.content[0].text) && /of 12 GB available/.test(r3[1].result.content[0].text), r3[1].result.content[0].text);
  const r4 = await rpc({ jsonrpc: "2.0", id: 83, method: "tools/call", params: { name: "list_known", arguments: { kind: "hardware" } } });
  check("list_known gives ids, sizes and what's measured", r4[1].result.structuredContent.hardware.some(h => h.id === "rtx-3090" && h.memory_gb === 24 && h.measured) && /rtx-2080/.test(r4[1].result.content[0].text)); }
console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
