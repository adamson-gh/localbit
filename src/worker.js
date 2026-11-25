// LocalBit - a public "will this AI model run on this hardware?" service for AI agents and people.
// Cloudflare Worker. Doors: MCP (POST /mcp, Streamable HTTP, stateless JSON responses), a plain JSON API (/api/...),
// web pages per model and card (/run/<model>/on/<card>), /llms.txt and /sitemap.xml.
// Every call is logged to D1 (env.DB) with what was asked - never an IP address or anything personal. /stats is for the owner.
import modelsFile from "../data/models.json" with { type: "json" };
import gpusFile from "../data/gpus.json" with { type: "json" };
import measuredFile from "../data/measured.json" with { type: "json" };
import { findModel, findGpu, estimate, measuredFor, suggestions, suggestModels } from "./estimate.js";

const VERSION = "0.2.0";
const OWNER = { name: "adamson-gh", url: "https://github.com/adamson-gh" };
const DATA = { models: modelsFile.models, quants: modelsFile.quants, measured: [...(measuredFile.measured || []), ...modelsFile.measured], gpus: gpusFile.gpus };
// When the data was last checked: specs = the cards and models files; measured = the newest overnight result.
const AS_OF = { specs: [gpusFile.updated, modelsFile.updated].filter(Boolean).sort().pop() || null,
                measured: DATA.measured.map(m => m.date || "").sort().pop() || null };
const asOfText = () => `Data as of: specs ${AS_OF.specs}` + (AS_OF.measured ? `, newest measurement ${AS_OF.measured}` : "") + ".";
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const KNOWN_AGENTS = ["ChatGPT-User", "OAI-SearchBot", "GPTBot", "Claude-User", "Claude-SearchBot", "ClaudeBot", "Claude-Code", "Perplexity-User",
  "PerplexityBot", "Google-Extended", "Googlebot", "bingbot", "Applebot", "Meta-ExternalAgent", "Amazonbot", "Bytespider", "CCBot", "DuckAssistBot",
  "MistralAI-User", "cohere-ai", "Cursor", "python-httpx", "node", "curl"];

const INSTRUCTIONS = "LocalBit answers whether an AI model will run on a given graphics card or computer, how much memory it needs and roughly how fast " +
  "it will generate. Call check_fit with a model (e.g. 'llama 3.1 8b', 'qwen3:30b') and hardware (e.g. 'RTX 3090', 'M4 Max', '12 GB'). Answers say " +
  "whether they are estimated or measured on real machines. If an answer turns out wrong, call report_issue with what was seen.";

const TOOLS = [
  { name: "check_fit", title: "Will this model run on this hardware?",
    description: "Whether a local AI model fits on a graphics card or Apple computer, the memory it needs (weights + context cache), and estimated " +
      "generation speed in tokens per second. Says whether the speed is estimated or measured, and what to change if it doesn't fit.",
    inputSchema: { type: "object", required: ["model", "hardware"], properties: {
      model: { type: "string", description: "Model name, e.g. 'Llama 3.1 8B', 'qwen3:30b', 'gpt-oss 20b', or a size like '13B model'." },
      hardware: { type: "string", description: "Graphics card or computer, e.g. 'RTX 3090', 'RX 7900 XTX', 'M4 Max', or memory like '12 GB card'." },
      context: { type: "integer", description: "Context length in tokens (default 8192)." },
      quant: { type: "string", description: "Quantization, e.g. Q4_K_M (default), Q8_0, F16." },
      kv_cache: { type: "string", description: "Context cache type: f16 (default), q8_0 or q4_0." } } },
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true } },
  { name: "suggest_models", title: "Which models fit this hardware?",
    description: "The largest known local AI models that fit on the given hardware at the given context, with memory and estimated speed.",
    inputSchema: { type: "object", required: ["hardware"], properties: {
      hardware: { type: "string", description: "Graphics card or computer, e.g. 'RTX 4060', 'M4 Pro', '16 GB'." },
      context: { type: "integer", description: "Context length in tokens (default 8192)." },
      min_tokens_per_s: { type: "number", description: "Only models at least this fast (estimated)." } } },
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true } },
  { name: "list_known", title: "Models and hardware LocalBit knows",
    description: "The models or the graphics cards / computers LocalBit has specifications for.",
    inputSchema: { type: "object", required: ["kind"], properties: { kind: { type: "string", enum: ["models", "hardware"] } } },
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true } },
  { name: "report_issue", title: "Report a wrong or missing answer",
    description: "Tell LocalBit an answer was wrong (it didn't fit, the speed was different, a spec is off) or a model or card is missing. " +
      "Real results help most: the tokens/s and memory actually seen, and the runtime. Don't include names, emails or other personal details.",
    inputSchema: { type: "object", required: ["problem"], properties: {
      problem: { type: "string", enum: ["wrong_fit", "wrong_speed", "wrong_spec", "missing_model", "missing_hardware", "other"] },
      model: { type: "string", description: "The model asked about." },
      hardware: { type: "string", description: "The card or computer." },
      observed_tokens_per_s: { type: "number", description: "Generation speed actually seen." },
      observed_memory_gb: { type: "number", description: "Memory actually used." },
      context: { type: "integer", description: "Context length used." },
      runtime: { type: "string", description: "e.g. 'Ollama 0.40', 'llama.cpp b5000', 'LM Studio 0.3'." },
      note: { type: "string", description: "What happened, up to 500 characters. No personal details." } } },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false } },
];

// ---------- answers ----------
function checkFit(args) {
  const m = findModel(args.model, DATA.models), g = findGpu(args.hardware, DATA.gpus);
  if (!m || !g) {
    return { error: true, text: (!m ? `LocalBit doesn't know the model "${args.model}" yet - try a size like "13B". ` : "") +
      (!g ? `LocalBit doesn't know the hardware "${args.hardware}" yet - try a card name or its memory, like "12 GB".` : ""),
      data: { model_found: !!m, hardware_found: !!g }, log: { model_id: m && m.id, gpu_id: g && g.id, verdict: "unknown" } };
  }
  const e = estimate(m, g, args, DATA.quants);
  const meas = measuredFor(e, DATA.measured);
  const tips = suggestions(e, m, g, DATA);
  const speed = meas ? `${meas.gen_tokens_per_s} tokens/s measured (${meas.results} result${meas.results > 1 ? "s" : ""}, ${meas.quant}, ${meas.runtime}${meas.date ? ", measured " + meas.date : ""})`
                     : `about ${e.gen_tokens_per_s} tokens/s (estimated${e.partly_on_cpu ? ", with part of the model running from system memory" : ""})`;
  const verdictText = { fits: "Yes, it fits.", tight: "Just barely - it may not fit once other apps use the card.", does_not_fit: "No, not entirely on this hardware." }[e.verdict];
  const lines = [
    `${e.model} on ${e.hardware} (${e.quant}, ${e.context.toLocaleString("en-US")}-token context): ${verdictText}`,
    `Memory: about ${e.memory_gb.total} GB needed of ${e.memory_gb.available} GB available (model ${e.memory_gb.weights} GB, context cache ${e.memory_gb.context_cache} GB, overhead ${e.memory_gb.overhead} GB).`,
    `Speed: ${speed}.`,
    ...tips.map(t => "- " + t),
  ];
  if (m.matched === "generic" || g.matched === "generic") lines.push("Note: estimated from size alone - give the exact model or card name for a closer answer.");
  if (!m.verified && m.matched === "known") lines.push("Note: this model's specifications are from its published config and not yet re-checked.");
  lines.push(asOfText());
  return { text: lines.join("\n"), data: { ...e, measured: meas, suggestions: tips, basis: meas ? "measured" : "estimated", data_as_of: AS_OF },
           log: { model_id: m.id, gpu_id: g.id, verdict: e.verdict, context: e.context, quant: e.quant } };
}

function suggest(args) {
  const g = findGpu(args.hardware, DATA.gpus);
  if (!g) return { error: true, text: `LocalBit doesn't know the hardware "${args.hardware}" yet - try a card name or its memory, like "12 GB".`, data: {}, log: { verdict: "unknown" } };
  const list = suggestModels(g, args, DATA);
  const text = list.length ? `Largest known models that fit on ${g.name} (${(+args.context || 8192).toLocaleString("en-US")}-token context, estimated):\n` +
    list.map(x => `- ${x.model} (${x.quant}): ${x.memory_gb} GB, ~${x.gen_tokens_per_s} tokens/s`).join("\n") : `None of the known models fit on ${g.name} at that context.`;
  return { text: text + "\n" + asOfText(), data: { hardware: g.name, models: list, basis: "estimated", data_as_of: AS_OF }, log: { gpu_id: g.id, verdict: list.length ? "listed" : "none" } };
}

function listKnown(args) {
  const rows = args.kind === "hardware" ? DATA.gpus.map(g => g.name) : DATA.models.map(m => m.name);
  return { text: rows.join("\n"), data: { [args.kind === "hardware" ? "hardware" : "models"]: rows }, log: {} };
}

const RUN = { check_fit: checkFit, suggest_models: suggest, list_known: listKnown };

// ---------- logging (no IPs, nothing personal) ----------
function agentOf(ua) {
  const s = String(ua || "");
  const k = KNOWN_AGENTS.find(a => s.toLowerCase().includes(a.toLowerCase()));
  return k || s.slice(0, 60);
}
function logCall(env, ctx, row) {
  if (!env || !env.DB) return;
  const cut = (v, n = 80) => (v == null ? null : String(v).slice(0, n));
  const stmt = env.DB.prepare("INSERT INTO calls (ts, kind, client, ua, tool, model_q, hw_q, model_id, gpu_id, verdict, context, quant) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(new Date().toISOString(), cut(row.kind, 20), cut(row.client), cut(row.ua, 60), cut(row.tool, 40), cut(row.model_q), cut(row.hw_q),
          cut(row.model_id, 40), cut(row.gpu_id, 40), cut(row.verdict, 20), row.context || null, cut(row.quant, 12));
  ctx.waitUntil(stmt.run().catch(() => {}));
}

// ---------- reports (what was seen, never who) ----------
const PROBLEMS = ["wrong_fit", "wrong_speed", "wrong_spec", "missing_model", "missing_hardware", "other"];
const scrub = s => String(s || "").replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email removed]").replace(/\+?\d[\d\s().-]{8,}\d/g, "[number removed]")
  .replace(/https?:\/\/\S+/g, "[link removed]").replace(/[\u0000-\u001f]/g, " ").slice(0, 500);
const num = (v, lo, hi) => { const n = +v; return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };
function saveReport(env, ctx, a, source, client) {
  const problem = PROBLEMS.includes(a.problem) ? a.problem : "other";
  const m = a.model ? findModel(a.model, DATA.models) : null, g = a.hardware ? findGpu(a.hardware, DATA.gpus) : null;
  const row = [new Date().toISOString(), source, String(client || "").slice(0, 80), String(a.model || "").slice(0, 80) || null, String(a.hardware || "").slice(0, 80) || null,
    m ? m.id : null, g ? g.id : null, problem, num(a.observed_tokens_per_s, 0, 100000), num(a.observed_memory_gb, 0, 4096), num(a.context, 0, 10000000),
    String(a.runtime || "").slice(0, 60) || null, scrub(a.note) || null];
  if (env && env.DB) ctx.waitUntil(env.DB.prepare("INSERT INTO reports (ts, source, client, model_q, hw_q, model_id, gpu_id, problem, obs_tps, obs_mem_gb, context, runtime, note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(...row).run().catch(() => {}));
  return { text: "Thanks - LocalBit recorded the report" + (m || g ? ` (${[m && m.name, g && g.name].filter(Boolean).join(" on ")})` : "") +
    ". Reports are read by the owner and used to correct the data; nothing personal is kept.", data: { recorded: true, problem }, log: { model_id: m && m.id, gpu_id: g && g.id, verdict: "report" } };
}

// ---------- rate limits (Cloudflare's limiter sees the address for a moment; LocalBit never stores it) ----------
async function limited(env, request, which = "LIMITER") {
  const lim = env && env[which];
  if (!lim || typeof lim.limit !== "function") return false;
  try { const { success } = await lim.limit({ key: request.headers.get("cf-connecting-ip") || "unknown" }); return !success; } catch { return false; }
}
const tooMany = () => new Response(JSON.stringify({ error: "Too many requests - LocalBit allows 120 a minute per address. Try again in a minute." }),
  { status: 429, headers: { "content-type": "application/json", "retry-after": "60", "access-control-allow-origin": "*" } });

// ---------- MCP ----------
async function mcp(request, env, ctx) {
  if (request.method !== "POST") return new Response("LocalBit's MCP endpoint takes POST requests (Streamable HTTP).", { status: 405, headers: { Allow: "POST" } });
  const raw = await request.text();
  if (raw.length > 16384) return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request too large" } }, 413);
  let msg;
  try { msg = JSON.parse(raw); } catch { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400); }
  if (Array.isArray(msg)) return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Batches aren't supported" } }, 400);
  const ua = agentOf(request.headers.get("user-agent"));
  if (msg.id === undefined) return new Response(null, { status: 202 });          // a notification
  const reply = result => json({ jsonrpc: "2.0", id: msg.id, result });
  const fail = (code, message) => json({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
  const p = msg.params || {};
  switch (msg.method) {
    case "initialize": {
      const ci = p.clientInfo || {};
      logCall(env, ctx, { kind: "mcp_init", client: `${ci.name || "?"} ${ci.version || ""}`.trim(), ua });
      const v = PROTOCOLS.includes(p.protocolVersion) ? p.protocolVersion : PROTOCOLS[0];
      return reply({ protocolVersion: v, capabilities: { tools: { listChanged: false } },
                     serverInfo: { name: "localbit", title: "LocalBit", version: VERSION }, instructions: INSTRUCTIONS });
    }
    case "ping": return reply({});
    case "tools/list": logCall(env, ctx, { kind: "mcp_list", ua }); return reply({ tools: TOOLS });
    case "tools/call": {
      const args = p.arguments || {};
      if (p.name === "report_issue" && await limited(env, request, "REPORTS")) return fail(-32000, "Too many reports from here - try again in a minute.");
      const fn = p.name === "report_issue" ? (a => saveReport(env, ctx, a, "mcp", ua)) : RUN[p.name];
      if (!fn) return fail(-32602, "Unknown tool: " + p.name);
      const out = fn(args);
      logCall(env, ctx, { kind: "mcp_call", ua, tool: p.name, model_q: args.model, hw_q: args.hardware || args.kind, ...out.log });
      return reply({ content: [{ type: "text", text: out.text }], structuredContent: out.data, isError: !!out.error });
    }
    default: return fail(-32601, "Method not found: " + msg.method);
  }
}

// ---------- plain API, pages ----------
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" } });
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function page(title, body, origin) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(title)} - memory needed and estimated speed, from LocalBit.">
<style>body{font:16px/1.55 system-ui,sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem;color:#1d1d1f}h1{font-size:1.5rem}code,pre{background:#f3f3f5;border-radius:6px;padding:.1rem .35rem}pre{padding:.8rem;overflow:auto}a{color:#0b57d0}small{color:#666}</style>
</head><body>${body}<hr><small>LocalBit ${VERSION} · ${esc(asOfText())} · <a href="${origin}/">home</a> · <a href="${origin}/llms.txt">llms.txt</a> · <a href="${origin}/about">about, privacy &amp; data license</a> · MCP: <code>${origin}/mcp</code></small></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } });
}
function home(origin) {
  return page("LocalBit - will this AI model run on my hardware?", `<h1>LocalBit</h1>
<p>Will an AI model run on your graphics card or Mac? LocalBit answers with the memory it needs and how fast it should generate - estimated from the model's design and the card's specs, and measured on real machines where results exist.</p>
<h2>For AI agents</h2><p>MCP server (Streamable HTTP): <code>${origin}/mcp</code> - tools <code>check_fit</code>, <code>suggest_models</code>, <code>list_known</code>.</p>
<p>Plain API: <code>GET ${origin}/api/check?model=llama%203.1%208b&amp;hardware=rtx%203090&amp;context=8192</code></p>
<h2>Examples</h2><ul>
<li><a href="${origin}/run/llama-3.1-8b/on/rtx-4060">Llama 3.1 8B on an RTX 4060</a></li>
<li><a href="${origin}/run/qwen3-30b-a3b/on/rtx-4090">Qwen3 30B-A3B on an RTX 4090</a></li>
<li><a href="${origin}/run/llama-3.3-70b/on/rtx-3090">Llama 3.3 70B on an RTX 3090</a></li></ul>
<h2>What LocalBit records</h2><p>Which tool was called, the model and hardware named, and the calling app's self-reported name - to learn what people and agents ask about. No IP addresses, accounts or personal data. <a href="${origin}/about">More: who runs it, privacy, data license.</a></p>`, origin);
}
function about(origin) {
  return page("About LocalBit - who runs it, privacy, data license", `<h1>About LocalBit</h1>
<h2>Who runs it</h2><p>LocalBit is an independent project by <a href="${OWNER.url}">${OWNER.name}</a> on GitHub. It isn't connected with NVIDIA, AMD, Intel, Apple, Ollama or any model maker.</p>
<h2>How good the answers are</h2><p>Most answers are <b>estimates</b> from each model's design and each card's published specs. Speeds marked <b>measured</b> come from LocalBit's own RTX 3090 test machine (Windows, Ollama), re-run regularly. Laptop versions of cards are slower than desktop ones, and two-card or CPU-only setups aren't modeled yet. Check before you buy hardware on the strength of an estimate. Every answer says how current its data is.</p>
<h2>Something wrong?</h2><p>Agents can call the <code>report_issue</code> tool; people can use the form on any result page, or <code>POST ${origin}/api/report</code> with JSON. Real results (tokens/s, memory used, runtime) help most.</p>
<h2>Privacy</h2><ul><li>Recorded: the time, which tool or page, the model and hardware asked about, the answer's verdict, and the calling app's self-reported name.</li>
<li>Not recorded: IP addresses, accounts, cookies or anything that identifies a person. Cloudflare's rate limiter looks at the address for a moment to stop abuse; LocalBit never stores it.</li>
<li>Reports are kept as written, with emails, phone numbers and links removed - please leave personal details out.</li></ul>
<h2>Data license</h2><p>The measurements (<a href="${origin}/api/measured">${origin}/api/measured</a>) and the model and hardware tables (<a href="${origin}/api/models">models</a>, <a href="${origin}/api/hardware">hardware</a>) are open under <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a> - use them freely, credit LocalBit.</p>
<h2>Limits</h2><p>120 requests a minute per address; 5 reports a minute. Free, no key.</p>`, origin);
}
function reportForm(origin, m, g) {
  const opt = PROBLEMS.map(p => `<option value="${p}">${p.replace(/_/g, " ")}</option>`).join("");
  return `<details><summary>Was this wrong? Tell LocalBit what you saw</summary><form method="post" action="${origin}/api/report">
<input type="hidden" name="model" value="${esc(m.id)}"><input type="hidden" name="hardware" value="${esc(g.id)}">
<p><label>Problem <select name="problem">${opt}</select></label></p>
<p><label>Tokens/s you saw <input name="observed_tokens_per_s" inputmode="decimal" size="6"></label> <label>Memory used (GB) <input name="observed_memory_gb" inputmode="decimal" size="6"></label></p>
<p><label>Runtime <input name="runtime" placeholder="Ollama 0.40" size="14"></label> <label>Context <input name="context" inputmode="numeric" size="7"></label></p>
<p><label>Note (no personal details)<br><textarea name="note" maxlength="500" rows="3" cols="50"></textarea></label></p><p><button>Send report</button></p></form></details>`;
}
function pairPage(mid, gid, origin) {
  const m = DATA.models.find(x => x.id === mid), g = DATA.gpus.find(x => x.id === gid);
  if (!m || !g) return null;
  const out = checkFit({ model: m.id, hardware: g.id });
  const others = DATA.gpus.filter(x => x.id !== g.id && Math.abs(x.vram_gb - g.vram_gb) <= 8).slice(0, 6)
    .map(x => `<a href="${origin}/run/${m.id}/on/${x.id}">${esc(x.name)}</a>`).join(" · ");
  return page(`Can ${m.name} run on ${g.name}?`, `<h1>Can ${esc(m.name)} run on ${esc(g.name)}?</h1><pre>${esc(out.text)}</pre>
<p>Other cards: ${others}</p>${reportForm(origin, m, g)}<p><small>Ask with your own context length: <code>${origin}/api/check?model=${encodeURIComponent(m.id)}&amp;hardware=${encodeURIComponent(g.id)}&amp;context=32768</code></small></p>`, origin);
}
function llmsTxt(origin) {
  return `# LocalBit\n\n> Will an AI model run on this hardware? Memory needed (weights + context cache) and estimated or measured generation speed for local models on graphics cards and Apple computers.\n\n` +
    `## For agents\n- MCP (Streamable HTTP): ${origin}/mcp - tools: check_fit(model, hardware, context?, quant?, kv_cache?), suggest_models(hardware, context?, min_tokens_per_s?), list_known(kind), report_issue(problem, model?, hardware?, observed_tokens_per_s?, observed_memory_gb?, runtime?, note?)\n` +
    `- JSON API: ${origin}/api/check?model=...&hardware=...&context=...&quant=... ; ${origin}/api/suggest?hardware=... ; ${origin}/api/models ; ${origin}/api/hardware ; ${origin}/api/measured ; POST ${origin}/api/report (JSON)\n\n` +
    `## Notes\n- Speeds are labeled "estimated" or "measured"; every answer ends with the date the data is current as of (data_as_of in JSON).\n- ${asOfText()}\n- LocalBit records the tool, model and hardware asked about and the client's self-reported name - no IP addresses or personal data.\n- Open data: measurements and tables are CC BY 4.0 (credit LocalBit). Limits: 120 requests/minute per address. Run by ${OWNER.name} (${OWNER.url}). Details: ${origin}/about\n`;
}
function sitemap(origin) {
  const urls = [origin + "/", origin + "/about"];
  for (const m of DATA.models) for (const g of DATA.gpus) urls.push(`${origin}/run/${m.id}/on/${g.id}`);
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(u => `<url><loc>${esc(u)}</loc>${AS_OF.specs ? `<lastmod>${[AS_OF.specs, AS_OF.measured].filter(Boolean).sort().pop()}</lastmod>` : ""}</url>`).join("\n")}\n</urlset>`,
    { headers: { "content-type": "application/xml" } });
}

async function stats(request, env) {
  const key = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!env.STATS_KEY || key !== env.STATS_KEY) return json({ error: "not allowed" }, 403);
  if (!env.DB) return json({ error: "no database bound" }, 500);
  const days = Math.min(90, Math.max(1, +new URL(request.url).searchParams.get("days") || 7));
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const q = (sql) => env.DB.prepare(sql).bind(since).all().then(r => r.results);
  return json({ days,
    by_day: await q("SELECT substr(ts,1,10) day, count(*) n FROM calls WHERE ts >= ? GROUP BY day ORDER BY day"),
    by_kind: await q("SELECT kind, count(*) n FROM calls WHERE ts >= ? GROUP BY kind ORDER BY n DESC"),
    by_agent: await q("SELECT coalesce(nullif(client,''), ua) agent, count(*) n FROM calls WHERE ts >= ? GROUP BY agent ORDER BY n DESC LIMIT 25"),
    by_tool: await q("SELECT tool, count(*) n FROM calls WHERE ts >= ? AND tool IS NOT NULL GROUP BY tool ORDER BY n DESC"),
    top_models: await q("SELECT coalesce(model_id, model_q) model, count(*) n FROM calls WHERE ts >= ? AND (model_id IS NOT NULL OR model_q IS NOT NULL) GROUP BY model ORDER BY n DESC LIMIT 25"),
    top_hardware: await q("SELECT coalesce(gpu_id, hw_q) hardware, count(*) n FROM calls WHERE ts >= ? AND (gpu_id IS NOT NULL OR hw_q IS NOT NULL) GROUP BY hardware ORDER BY n DESC LIMIT 25"),
    reports_by_problem: await q("SELECT problem, count(*) n FROM reports WHERE ts >= ? GROUP BY problem ORDER BY n DESC").catch(() => []),
    recent_reports: await q("SELECT ts, source, client, model_q, hw_q, model_id, gpu_id, problem, obs_tps, obs_mem_gb, context, runtime, note FROM reports WHERE ts >= ? ORDER BY ts DESC LIMIT 25").catch(() => []),
    unknown_asks: await q("SELECT model_q, hw_q, count(*) n FROM calls WHERE ts >= ? AND (verdict = 'unknown' OR model_id LIKE 'generic%' OR gpu_id LIKE 'generic%') GROUP BY model_q, hw_q ORDER BY n DESC LIMIT 25"),
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url), origin = url.origin, path = url.pathname.replace(/\/+$/, "") || "/";
    const ua = agentOf(request.headers.get("user-agent"));
    if (path !== "/stats" && request.method !== "OPTIONS" && await limited(env, request)) return tooMany();
    if (path === "/mcp") return mcp(request, env, ctx);
    if (path === "/stats") return stats(request, env);
    if (request.method === "OPTIONS") return new Response(null, { headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type, mcp-protocol-version" } });
    if (path === "/api/report" && request.method === "POST") {
      if (await limited(env, request, "REPORTS")) return tooMany();
      const raw = await request.text();
      if (raw.length > 8192) return json({ error: "too large" }, 413);
      const isForm = (request.headers.get("content-type") || "").includes("form");
      let a = {};
      try { a = isForm ? Object.fromEntries(new URLSearchParams(raw)) : JSON.parse(raw); } catch { return json({ error: "send JSON" }, 400); }
      const o = saveReport(env, ctx, a || {}, isForm ? "form" : "api", ua);
      logCall(env, ctx, { kind: "report", ua, tool: "report_issue", model_q: a.model, hw_q: a.hardware, ...o.log });
      return isForm ? page("Thanks - LocalBit", `<h1>Thanks</h1><p>${esc(o.text)}</p><p><a href="${origin}/">Back to LocalBit</a></p>`, origin) : json({ answer: o.text, ...o.data });
    }
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Not allowed", { status: 405 });
    const sp = Object.fromEntries(url.searchParams);
    if (path === "/api/check") { const o = checkFit(sp); logCall(env, ctx, { kind: "api", ua, tool: "check_fit", model_q: sp.model, hw_q: sp.hardware, ...o.log }); return json({ answer: o.text, ...o.data }, o.error ? 404 : 200); }
    if (path === "/api/suggest") { const o = suggest(sp); logCall(env, ctx, { kind: "api", ua, tool: "suggest_models", hw_q: sp.hardware, ...o.log }); return json({ answer: o.text, ...o.data }, o.error ? 404 : 200); }
    if (path === "/api/models") return json({ models: DATA.models.map(({ id, name, params_b, active_b, verified }) => ({ id, name, params_b, active_b, verified })) });
    if (path === "/api/hardware") return json({ hardware: DATA.gpus.map(({ id, name, vram_gb, bandwidth_gbs }) => ({ id, name, vram_gb, bandwidth_gbs })) });
    if (path === "/api/measured") return json({ license: "CC BY 4.0 - credit LocalBit", data_as_of: AS_OF, measured: DATA.measured });
    if (path === "/about") { logCall(env, ctx, { kind: "about", ua }); return about(origin); }
    if (path === "/llms.txt") { logCall(env, ctx, { kind: "llms_txt", ua }); return new Response(llmsTxt(origin), { headers: { "content-type": "text/plain; charset=utf-8" } }); }
    if (path === "/sitemap.xml") return sitemap(origin);
    if (path === "/robots.txt") return new Response(`User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`, { headers: { "content-type": "text/plain" } });
    const pm = path.match(/^\/run\/([a-z0-9.\-]+)\/on\/([a-z0-9.\-]+)$/);
    if (pm) { const r = pairPage(pm[1], pm[2], origin); if (r) { logCall(env, ctx, { kind: "page", ua, model_id: pm[1], gpu_id: pm[2] }); return r; } }
    if (path === "/") { logCall(env, ctx, { kind: "home", ua }); return home(origin); }
    return new Response("Not found", { status: 404 });
  },
};
