import fs from "fs";
// LocalBit: the Worker answered as an agent would call it - MCP and the plain API - with a fake log database. node test/test_worker.mjs
import worker from "../src/worker.js";
let ok = 0, bad = 0;
const check = (name, cond, got) => { cond ? ok++ : bad++; console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : "  got: " + String(JSON.stringify(got)).slice(0, 300))); };
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
check("nine tools: seven read-only answers, report_issue and submit_result", j.result.tools.length === 9 && j.result.tools.filter(t => t.annotations.readOnlyHint).length === 7 && j.result.tools.some(t => t.name === "report_issue" && !t.annotations.readOnlyHint), j.result.tools.map(t => t.name));
[st, j] = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "check_fit", arguments: { model: "qwen3.8:27b", hardware: "RTX 3090", context: 16384 } } });
const sc = j.result.structuredContent;
check("check_fit on the test machine: fits, and the speed is the measured one", sc.verdict === "fits" && sc.basis === "measured" && /4[78]\.\d+ tokens\/s measured/.test(j.result.content[0].text), j.result.content[0].text);
check("answers say when the data is current as of (text and JSON), and when the speed was measured", /Data as of: specs 20\d\d-\d\d-\d\d/.test(j.result.content[0].text) && sc.data_as_of && sc.data_as_of.specs === JSON.parse(fs.readFileSync(new URL("../data/gpus.json", import.meta.url))).updated && /measured 2026-11-25/.test(j.result.content[0].text), j.result.content[0].text);
{ const pg = await (await call("/run/qwen3.8-27b/on/rtx-3090")).text(); const lt = await (await call("/llms.txt")).text();
  check("pages and llms.txt show the as-of date", /Data as of: specs 20\d\d-\d\d-\d\d/.test(pg) && /Data as of: specs 20\d\d-\d\d-\d\d/.test(lt), lt.slice(-200)); }
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
  check("...an unknown model gets a friendly page, not an error", un.status === 200 && /Not recognized/.test(await un.text())); }
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
{ const c = async (a) => (await rpc({ jsonrpc: "2.0", id: 90, method: "tools/call", params: { name: "check_fit", arguments: a } }))[1].result;
  const two = await c({ model: "llama 3.3 70b", hardware: "2x rtx 3090" }), one = await c({ model: "llama 3.3 70b", hardware: "rtx 3090" });
  check("2x RTX 3090: memory adds up (70B fits on two, not one), with a note on splitting", two.structuredContent.verdict === "fits" && one.structuredContent.verdict === "does_not_fit" && /split across them/.test(two.content[0].text), two.content[0].text);
  const dual = await c({ model: "llama 3.3 70b", hardware: "dual 3090" });
  check("...'dual 3090' too", dual.structuredContent.hardware.startsWith("2×"));
  const far = await c({ model: "llama 3.2 1b", hardware: "rtx 4060", context: 1000000 });
  check("a context past the model's maximum is warned about first", /^.*\nWarning: Llama 3\.2 1B handles at most 131,072/.test(far.content[0].text) && far.structuredContent.context_beyond_model_max, far.content[0].text.slice(0, 300));
  const yarn = await c({ model: "qwen3 8b", hardware: "rtx 4060", context: 65536 });
  check("past the native length: says long-context settings are needed", /YaRN/.test(yarn.content[0].text));
  const est = await c({ model: "llama 3.1 8b", hardware: "rtx 4060" });
  check("estimates come with a likely range and a page to cite", /likely \d+(\.\d)?-\d+/.test(est.content[0].text) && est.structuredContent.gen_tokens_per_s_range.length === 2 && /\/run\/llama-3\.1-8b\/on\/rtx-4060$/.test(est.structuredContent.source_url), est.content[0].text);
  const [sl, jl] = await rpc({ jsonrpc: "2.0", id: 91, method: "tools/list" });
  check("tools declare what they return (outputSchema) and the intro names every tool", jl.result.tools.filter(x => x.outputSchema).length === 5);
  const [si, ji] = await rpc({ jsonrpc: "2.0", id: 92, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "made-up", version: "1" }, capabilities: {} } });
  check("...", ["check_fit", "compare", "suggest_models", "node_log", "list_known", "report_issue"].every(n => ji.result.instructions.includes(n)), ji.result.instructions); }
{ const badDB = { prepare: () => { throw new Error("made-up database outage"); } };
  const r = await worker.fetch(new Request("https://localbit.example.workers.dev/api/check?model=llama%203.1%208b&hardware=rtx%204060"), { DB: badDB }, ctx);
  check("a logging failure never costs the answer", r.status === 200 && (await r.json()).verdict === "fits");
  const seen = []; const env3 = { DB: { prepare: sql => ({ bind: (...v) => ({ run: async () => { seen.push([sql, v]); }, all: async () => ({ results: [] }) }) }) }, LIMITER: { limit: async () => ({ success: false }) } };
  const w3 = []; const r3 = await worker.fetch(new Request("https://localbit.example.workers.dev/api/check?model=x&hardware=y"), env3, { waitUntil: p => w3.push(p) }); await Promise.all(w3);
  check("a turned-away request is counted (kind 'limited', no address)", r3.status === 429 && seen.some(([s, v]) => /INSERT INTO calls/.test(s) && v.includes("limited")) && !seen.some(([s, v]) => v.some(x => /\d+\.\d+\.\d+\.\d+/.test(String(x)))), seen.map(x => x[1])); }
{ const seen = []; const env4 = { DB: { prepare: sql => ({ bind: (...v) => ({ run: async () => { seen.push([sql, v]); }, all: async () => ({ results: [] }) }) }) } };
  const w4 = []; const r4 = await worker.fetch(new Request("https://localbit.example.workers.dev/openapi.json", { headers: { "user-agent": "made-up-agent/1.0" } }), env4, { waitUntil: p => w4.push(p) }); await Promise.all(w4);
  check("a missing address is logged - path and caller name only", r4.status === 404 && seen.some(([s, v]) => /INSERT INTO misses/.test(s) && v[1] === "/openapi.json" && v.length === 3), seen); }
{ const c = async (a) => (await rpc({ jsonrpc: "2.0", id: 95, method: "tools/call", params: { name: "check_fit", arguments: a } }))[1].result;
  const one = await c({ model: "llama 3.3", hardware: "rtx 3090" });
  check("a family with one known size: answered for that size, and says so", !one.isError && /Llama 3\.3 70B/.test(one.content[0].text) && /knows one size/.test(one.content[0].text), one.content[0].text.slice(0, 200));
  const many = await c({ model: "Qwen 2.5", hardware: "Rtx 4070" });
  check("a family with several sizes: lists them and asks for one", many.isError && /comes in 4 sizes/.test(many.content[0].text) && many.structuredContent.sizes.length === 4, many.content[0].text); }
{ for (const pth of ["/mcp/.well-known/glama.json", "/.well-known/glama.json"]) { const g = await (await call(pth)).json();
    check("Glama claim file at " + pth + ": the claim token, no email", g["$schema"].includes("glama.ai/mcp/schemas/connector.json") && /^glama_claim_/.test(g.claim) && !JSON.stringify(g).includes("@")); }
  const mj2 = await (await call("/.well-known/mcp.json")).json();
  check("MCP discovery file: where to connect and the tools", /\/mcp$/.test(mj2.endpoint) && mj2.transport === "streamable-http" && mj2.tools.includes("check_fit")); }
{ const pv = await call("/privacy"), dc = await call("/docs"), lg = await call("/logo.svg");
  check("privacy policy, docs and logo pages are served", pv.status === 200 && /Privacy policy/.test(await pv.text()) && dc.status === 200 && /JSON API/.test(await dc.text()) && lg.headers.get("content-type") === "image/svg+xml");
  const [s9, j9] = await rpc({ jsonrpc: "2.0", id: 99, method: "tools/list" });
  check("every tool description says when to use it instead of its siblings", j9.result.tools.every(x => /Use this (when|after)|Call this first/.test(x.description)), j9.result.tools.map(x => x.name)); }
{ const fi = await call("/favicon.ico"), ap = await call("/apple-touch-icon.png");
  const bytes = new Uint8Array(await ap.arrayBuffer());
  check("browser icons are served (favicon, phone home-screen icon as a real PNG)", fi.status === 200 && ap.status === 200 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47); }
// contributions (0.4)
{ const seen = []; const envS = { DB: { prepare: sql => ({ bind: (...v) => ({ run: async () => { seen.push([sql, v]); }, all: async () => ({ results: [] }) }) }) } };
  const post = async (b) => { const w = []; const r = await worker.fetch(new Request("https://localbit.example.workers.dev/api/submit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }), envS, { waitUntil: p => w.push(p) }); await Promise.all(w); return [r.status, await r.json()]; };
  const good = { model: "llama3.1:8b", quant: "Q4_K_M", hardware: "NVIDIA GeForce RTX 4060", memory_gb: 8, cards: 1, runtime: "Ollama 0.40", os: "Windows", recipe_version: 1, results: [{ context: 4096, gen_tps: 40, all_on_gpu: true }, { context: 16384, gen_tps: 37, prompt_tps: 2100, all_on_gpu: true }] };
  const [s1, a1] = await post(good);
  check("a plausible submission is recorded as a community result, one row per context, no address", s1 === 200 && a1.status === "community" && seen.filter(([q]) => /INSERT INTO submissions/.test(q)).length === 2 && !seen.some(([q, v]) => v.some(x => /\d+\.\d+\.\d+\.\d+/.test(String(x)))), a1);
  const [s2, a2] = await post({ ...good, results: [{ context: 4096, gen_tps: 400, all_on_gpu: true }] });
  check("an implausible speed is flagged, not published", s2 === 200 && a2.status === "flagged" && /far from the expected/.test(a2.answer), a2);
  const [s3, a3] = await post({ ...good, results: [{ context: 4096, gen_tps: 40, all_on_gpu: false }] });
  check("a run partly off the card is flagged", a3.status === "flagged" && /partly off/.test(a3.answer), a3);
  const [s4, a4] = await post({ model: "x" });
  check("an incomplete submission is rejected with what's needed", s4 === 400 && /needs model, hardware/.test(a4.answer), a4); }
{ const [sk, jk] = await rpc({ jsonrpc: "2.0", id: 120, method: "tools/call", params: { name: "get_test_kit", arguments: {} } });
  check("get_test_kit: the script, the recipe, the consent promise, and agents use --dry-run then submit_result", /--dry-run \(sends nothing\), show the user/.test(jk.result.content[0].text) && /\/t\.py/.test(jk.result.content[0].text) && /asks yes\/no/.test(jk.result.content[0].text) && jk.result.structuredContent.recipe_url.endsWith("/recipe.json"));
  const tp = await call("/test.py"), rc = await (await call("/recipe.json")).json();
  check("/test.py serves the script; /recipe.json the recipe", tp.status === 200 && /Share these numbers with LocalBit\?/.test(await tp.text()) && rc.recipe_version === 1 && rc.tests.some(x => x.name === "gen"));
  const [sd, jd] = await rpc({ jsonrpc: "2.0", id: 121, method: "tools/call", params: { name: "get_details", arguments: { name: "qwen3.8 27b" } } });
  check("get_details (model): specs and the node's measurements", /27\.32B parameters|27B parameters|parameters/.test(jd.result.content[0].text) && /Measured on LocalBit's RTX 3090/.test(jd.result.content[0].text), jd.result.content[0].text);
  const [sg, jg] = await rpc({ jsonrpc: "2.0", id: 122, method: "tools/call", params: { name: "get_details", arguments: { name: "rtx 4090" } } });
  check("get_details (hardware): memory and bandwidth", /24 GB/.test(jg.result.content[0].text) && /bandwidth/.test(jg.result.content[0].text), jg.result.content[0].text);
  const [si, ji] = await rpc({ jsonrpc: "2.0", id: 123, method: "tools/call", params: { name: "check_fit", arguments: { model: "llama 3.1 8b", hardware: "rtx 4060" } } });
  check("an unmeasured setup invites the 3-minute test", /Not measured on this hardware yet/.test(ji.result.content[0].text) && /\/test/.test(ji.result.content[0].text)); }
{ const r = await (await call("/api/check?model=zephyrion%2040b&hardware=rtx%204090")).json();
  check("an unknown model says so first, in plain words", /^LocalBit doesn't know the model "zephyrion 40b" - this is a rough estimate for a typical 40B model/.test(r.answer), r.answer.slice(0, 200));
  const h = await (await call("/")).text();
  check("the home page shows how to ask by URL (for agents that can only read pages)", /By URL: <code>[^<]*\/check\?model=&lt;model&gt;&amp;hardware=&lt;card&gt;/.test(h)); }
// contributor experience (Nov 26)
{ const rows = [{ ts: "2026-11-26T14:05:00Z", context: 4096, gen_tps: 40.1, status: "community" }, { ts: "2026-11-26T14:06:00Z", context: 16384, gen_tps: 90, status: "flagged" }];
  const envR = { DB: { prepare: sql => ({ bind: () => ({ all: async () => ({ results: /FROM submissions WHERE model_id/.test(sql) ? rows : [] }), run: async () => {} }) }) } };
  const pg = await (await worker.fetch(new Request("https://localbit.example.workers.dev/run/llama-3.1-8b/on/rtx-4060"), envR, { waitUntil() {} })).text();
  check("the model/card page lists this week's submissions at once, accepted vs held", /Submitted this week/.test(pg) && /40\.1 tokens\/s<\/td><td>accepted - publishes tonight/.test(pg) && /held for review/.test(pg));
  const w = []; const r = await worker.fetch(new Request("https://localbit.example.workers.dev/api/submit", { method: "POST", body: JSON.stringify({ model: "llama3.1:8b", hardware: "NVIDIA GeForce RTX 4060", memory_gb: 8, results: [{ context: 4096, gen_tps: 40, all_on_gpu: true }] }) }), envR, { waitUntil: p => w.push(p) });
  const a = await r.json();
  check("a submission answers with the link to its result", a.url && a.url.endsWith("/run/llama-3.1-8b/on/rtx-4060") && a.answer.includes("listed now at " + a.url), a);
  const tp = await (await call("/test")).text();
  check("the test page: one copyable line per system (python3 on Mac), the other folded by script, the community count", /data-cmd="curl -sO [^"]*\/t\.py &amp;&amp; python3 t\.py"/.test(tp) && /data-cmd="irm [^"]*\/t\.py -OutFile t\.py; py t\.py"/.test(tp) && /Or ask your AI assistant/.test(tp) && /No community results yet/.test(tp) && (tp.match(/<h1>Local AI models|<h1>Measure your hardware<\/h1>/) || []).length === 1);
  const hp = await (await call("/")).text();
  check("the home page: new title, and an invitation to measure untested hardware", /<h1>Local AI models, checked against your hardware<\/h1>/.test(hp) && /<a href="[^"]*\/test">Measure it<\/a> in 3 minutes/.test(hp) && !/Will this AI model run/.test(hp.replace(/<meta[^>]*>/g, ""))); }
// suggestion box (Nov 26)
{ const seen = []; const envS = { DB: { prepare: sql => ({ bind: (...v) => ({ run: async () => { seen.push([sql, v]); }, all: async () => ({ results: [] }) }) }) } };
  const send = async (body) => { const w = []; const r = await worker.fetch(new Request("https://localbit.example.workers.dev/api/report", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }), envS, { waitUntil: p => w.push(p) }); await Promise.all(w); return [r.status, await r.text()]; };
  const sp = await (await call("/suggest")).text();
  check("/suggest: one box, no email field, a hidden trap for bots; linked from every footer", /name="problem" value="suggestion"/.test(sp) && !/type="email"/.test(sp) && /name="website"/.test(sp) && /href="[^"]*\/suggest">Suggest<\/a>/.test(await (await call("/about")).text()));
  const [s1, b1] = await send("problem=suggestion&note=" + encodeURIComponent("add the RTX 5060 Ti - mail me at someone@example.com"));
  const row = seen.find(([q]) => /INSERT INTO reports/.test(q));
  check("a suggestion is stored as 'suggestion', with the email removed", s1 === 200 && /suggestion recorded/.test(b1) && row && row[1].includes("suggestion") && !row[1].some(v => /@example\.com/.test(String(v))), row && row[1]);
  seen.length = 0; await send("problem=suggestion&note=buy+now&website=http%3A%2F%2Fspam.example");
  check("a bot that fills the hidden field is thanked but nothing is stored", !seen.some(([q]) => /INSERT INTO reports/.test(q)));
  const [, jb] = await rpc({ jsonrpc: "2.0", id: 130, method: "tools/call", params: { name: "report_issue", arguments: { problem: "suggestion", note: "x" } } });
  check("agents can't file 'suggestion' through report_issue (it becomes 'other')", jb.result.structuredContent.problem === "other", jb.result.structuredContent); }
// stats: real questions apart from probes, crawlers and the owner's own test (Nov 26)
{ const sqls = []; const envQ = { STATS_KEY: "k", DB: { prepare: sql => { sqls.push(sql); return { bind: () => ({ all: async () => ({ results: [] }), run: async () => {} }) }; } } };
  const r = await worker.fetch(new Request("https://localbit.example.workers.dev/stats", { headers: { authorization: "Bearer k" } }), envQ, { waitUntil() {} });
  const j = await r.json(); const real = sqls.find(s => /count\(\*\) n FROM calls WHERE ts >= \? AND tool IS NOT NULL AND/.test(s)) || "";
  check("/stats counts real questions without crawlers, monitoring probes or the owner's test", "real_questions" in j && "probe_calls" in j && "real_unknown" in j && /localbit-self-test/.test(real) && /probe/.test(real) && /ClaudeBot/.test(real), real.slice(0, 200));
  const unk = sqls.find(s => /verdict = 'unknown' OR model_id LIKE 'generic%'/.test(s)) || "";
  check("the old 'couldn't answer' list leaves out the owner's test too", /localbit-self-test/.test(unk)); }
console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
