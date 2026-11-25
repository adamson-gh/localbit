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
const CSS = `:root{--bg:#f7f7f5;--card:#fff;--ink:#1b1c1e;--mute:#62656b;--line:#e3e3df;--accent:#2457d6;--ok:#13795b;--okbg:#e6f4ee;--warn:#9a6200;--warnbg:#fdf1dc;--bad:#b3261e;--badbg:#fbe7e5;--code:#f0f0ec}
@media (prefers-color-scheme:dark){:root{--bg:#121315;--card:#1b1c1f;--ink:#ececec;--mute:#9b9ea4;--line:#2c2e33;--accent:#7aa2ff;--ok:#5fd3a5;--okbg:#14302a;--warn:#f3be5d;--warnbg:#33290f;--bad:#ff8a80;--badbg:#3a1a18;--code:#24262a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
header{border-bottom:1px solid var(--line);background:var(--card)}header .in,main,footer .in{max-width:880px;margin:0 auto;padding:0 20px}
header .in{display:flex;align-items:center;justify-content:space-between;height:58px;gap:16px}
.logo{font-weight:750;font-size:1.15rem;letter-spacing:-.01em;color:var(--ink)}.logo b{color:var(--accent)}
nav a{color:var(--mute);margin-left:18px;font-size:.95rem}nav a:hover{color:var(--ink)}
main{padding:34px 20px 20px}h1{font-size:1.9rem;line-height:1.2;letter-spacing:-.02em;margin:0 0 10px}h2{font-size:1.15rem;margin:34px 0 10px}
.lede{color:var(--mute);font-size:1.08rem;max-width:640px;margin:0 0 24px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px 22px;margin:16px 0}
.ask{display:flex;gap:10px;flex-wrap:wrap}.ask input{flex:1 1 200px;font:inherit;padding:11px 13px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--ink)}
button,.btn{font:inherit;font-weight:600;padding:11px 18px;border:0;border-radius:10px;background:var(--accent);color:#fff;cursor:pointer}
.hint{color:var(--mute);font-size:.88rem;margin-top:10px}
.verdict{display:inline-block;font-weight:700;padding:6px 12px;border-radius:999px;font-size:.95rem}
.v-fits{background:var(--okbg);color:var(--ok)}.v-tight{background:var(--warnbg);color:var(--warn)}.v-does_not_fit{background:var(--badbg);color:var(--bad)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:18px 0 6px}
.stat{background:var(--bg);border-radius:10px;padding:12px 14px}.stat .k{color:var(--mute);font-size:.82rem}.stat .v{font-size:1.35rem;font-weight:700}.stat .s{color:var(--mute);font-size:.82rem}
.bar{height:10px;border-radius:6px;background:var(--line);overflow:hidden;display:flex;margin:6px 0 4px}.bar i{display:block;height:100%}
.tag{display:inline-block;font-size:.75rem;font-weight:700;letter-spacing:.03em;text-transform:uppercase;padding:2px 8px;border-radius:6px;background:var(--code);color:var(--mute);margin-left:6px;vertical-align:middle}
.tag.m{background:var(--okbg);color:var(--ok)}
ul.tips{margin:8px 0 0;padding-left:20px}ul.tips li{margin:4px 0}
.grid3{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px}.grid3 .card{margin:0}
.grid3 h3{margin:0 0 6px;font-size:1rem}.grid3 p{margin:0;color:var(--mute);font-size:.94rem}
code,pre{font:.88em ui-monospace,SFMono-Regular,Consolas,monospace;background:var(--code);border-radius:6px;padding:.12rem .4rem}pre{padding:12px 14px;overflow:auto;white-space:pre-wrap}
table{border-collapse:collapse;width:100%;font-size:.92rem}th,td{padding:10px 10px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}
th{color:var(--mute);font-weight:600;font-size:.8rem;vertical-align:bottom}td:first-child,th:first-child{text-align:left;white-space:normal}
.scroll{overflow-x:auto}.qgrid{display:grid;gap:14px}.qref{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px}.qn{font-weight:650;margin-bottom:6px}
.qrow{display:grid;grid-template-columns:26px 92px 1fr 104px;grid-template-areas:"i l b v" ". . x x";align-items:center;gap:2px 10px;margin:6px 0}
.qrow .ct{grid-area:b;height:14px;background:var(--card);border-radius:7px}.qrow .cb{border-radius:7px}.ql{grid-area:l;font-size:.88rem;font-weight:600}.qrow .cb.qsb{background:#d08a00}.qrow .cb.qmb{background:var(--accent)}.qrow .cb.ql2b{background:#8a63d2}.qrow .cb.qrb{background:#13897a}.qrow .cb.qpb{background:#5c8a2e}.ql2{background:#efe8fb;color:#6b47b8}.qr{background:#e3f4f1;color:#0f7468}.qp{background:#ebf3e2;color:#4a7424}@media (prefers-color-scheme:dark){.ql2{background:#2a2140;color:#b49cf0}.qr{background:#13302c;color:#6fd3c4}.qp{background:#1f2b14;color:#a3d277}}@media (max-width:560px){.qrow{grid-template-columns:26px 1fr 96px;grid-template-areas:"i l v" "b b b" "x x x"}}
.qv{grid-area:v;font-weight:700;font-size:.9rem;text-align:right;white-space:nowrap}.qx{grid-area:x;color:var(--mute);font-size:.8rem}
.qi{grid-area:i;display:inline-flex;width:24px;height:24px;border-radius:7px;align-items:center;justify-content:center;vertical-align:middle}
.qs{background:var(--warnbg);color:var(--warn)}.qm{background:var(--code);color:var(--accent)}.ic{width:15px;height:15px}
.stat .k .qi{width:20px;height:20px;margin-right:4px}.stat .k .ic{width:13px;height:13px}.chart{position:relative;margin-top:10px}.crow{display:grid;grid-template-columns:150px 1fr;gap:2px 14px;align-items:center;margin:12px 0}
.cl{font-weight:600;font-size:.95rem}.ct{position:relative;height:26px;background:var(--bg);border-radius:6px}.cb{height:100%;background:var(--accent);border-radius:0 4px 4px 0}
.cv{position:absolute;left:8px;top:3px;font-size:.85rem;font-weight:700;color:#fff;mix-blend-mode:normal;text-shadow:0 0 3px rgba(0,0,0,.35)}.cs{grid-column:2;color:var(--mute);font-size:.82rem}
.readline{position:absolute;top:0;bottom:0;left:calc(164px + (100% - 164px) * var(--read, 0));border-left:2px dashed var(--mute);pointer-events:none}
.readline span{position:absolute;top:-18px;left:4px;font-size:.72rem;color:var(--mute);white-space:nowrap}
@media (max-width:560px){.crow{grid-template-columns:1fr}.cs{grid-column:1}.readline{display:none}}table.meas td:first-child{min-width:170px}table.meas td:nth-child(3){font-weight:700}.meas-note{color:var(--mute);font-size:.82rem;margin-top:10px}.small{color:var(--mute);font-size:.88rem}.chips a{display:inline-block;margin:4px 6px 4px 0;padding:5px 11px;border:1px solid var(--line);border-radius:999px;font-size:.9rem;color:var(--ink)}
details summary{cursor:pointer;color:var(--accent);font-weight:600}details form p{margin:10px 0}details input,details select,details textarea{font:inherit;padding:7px 9px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)}
footer{border-top:1px solid var(--line);margin-top:40px}footer .in{padding:18px 20px;color:var(--mute);font-size:.85rem;display:flex;flex-wrap:wrap;gap:6px 16px}`;
function page(title, body, origin, desc) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(desc || title + " - memory needed and speed, from LocalBit.")}">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc || "Will this AI model run on my hardware? Memory needed and speed, estimated or measured.")}">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%232457d6'/%3E%3Cpath d='M9 8v16h14' stroke='white' stroke-width='4' fill='none' stroke-linecap='round'/%3E%3C/svg%3E">
<style>${CSS}</style></head><body>
<header><div class="in"><a class="logo" href="${origin}/">Local<b>Bit</b></a><nav><a href="${origin}/measured">Measured</a><a href="${origin}/#agents">For agents</a><a href="${origin}/about">About</a></nav></div></header>
<main>${body}</main>
<footer><div class="in"><span>LocalBit ${VERSION}</span><span>${esc(asOfText())}</span><a href="${origin}/llms.txt">llms.txt</a><a href="${origin}/about">Privacy &amp; data license</a><a href="https://github.com/adamson-gh/localbit">GitHub</a><span>MCP: <code>${origin}/mcp</code></span></div></footer>
</body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
}
function askBox(origin, model = "", hw = "") {
  return `<form class="ask" method="get" action="${origin}/check"><input name="model" placeholder="Model - e.g. Llama 3.1 8B, qwen3:30b" value="${esc(model)}" aria-label="Model">
<input name="hardware" placeholder="Card or Mac - e.g. RTX 4060, M4 Max, 12 GB" value="${esc(hw)}" aria-label="Hardware"><button>Check</button></form>`;
}
function home(origin) {
  const nMeas = new Set((measuredFile.measured || []).map(r => r.model)).size;
  return page("LocalBit - will this AI model run on my hardware?", `<h1>Will this AI model run on my hardware?</h1>
<p class="lede">How much memory a local model needs and how fast it will answer on your graphics card or Mac - estimated from the model's design and the card's specs, and <b>measured</b> on real hardware where results exist.</p>
<div class="card">${askBox(origin)}<div class="hint">Try: <a href="${origin}/check?model=llama%203.1%208b&hardware=rtx%204060">Llama 3.1 8B on an RTX 4060</a> · <a href="${origin}/check?model=qwen3%2030b&hardware=rtx%204090">Qwen3 30B on an RTX 4090</a> · <a href="${origin}/check?model=llama%203.3%2070b&hardware=rtx%203090">Llama 3.3 70B on an RTX 3090</a></div></div>
<div class="grid3" style="margin-top:22px">
<div class="card"><h3>Measured, not guessed</h3><p>${nMeas} model${nMeas === 1 ? "" : "s"} timed on LocalBit's own RTX 3090, more every night. <a href="${origin}/measured">See the table</a>.</p></div>
<div class="card"><h3>Every answer says how it knows</h3><p>Estimated or measured, and the date the data is current as of.</p></div>
<div class="card"><h3>Open data</h3><p>Measurements and tables under CC BY 4.0, scripts on <a href="https://github.com/adamson-gh/localbit">GitHub</a>.</p></div></div>
<h2 id="agents">For AI agents</h2>
<div class="card"><p style="margin-top:0"><b>MCP server</b> (Streamable HTTP, no key): <code>${origin}/mcp</code><br><span class="small">Listed in the MCP Registry as <code>io.github.adamson-gh/localbit</code></span></p>
<p>Tools: <code>check_fit</code> · <code>suggest_models</code> · <code>list_known</code> · <code>report_issue</code></p>
<p style="margin-bottom:0"><b>JSON API:</b> <code>GET ${origin}/api/check?model=llama%203.1%208b&amp;hardware=rtx%203090&amp;context=8192</code> · <a href="${origin}/llms.txt">llms.txt</a></p></div>
<h2>What LocalBit records</h2><p class="small">Which tool was called, the model and hardware named, and the calling app's self-reported name - to learn what people and agents ask about. No IP addresses, accounts or personal data. <a href="${origin}/about">Who runs it, privacy, data license.</a></p>`, origin,
  "Will an AI model run on your GPU or Mac? Memory needed and tokens per second - estimated, and measured on a real RTX 3090.");
}
function resultCard(out) {
  const d = out.data, mg = d.memory_gb || {}, meas = d.measured;
  const vt = { fits: "Fits", tight: "Just barely fits", does_not_fit: "Doesn't fit" }[d.verdict] || d.verdict;
  const tot = Math.max(mg.total || 0, mg.available || 0) || 1, pct = v => Math.max(0, Math.min(100, 100 * (v || 0) / tot)).toFixed(1);
  const speed = meas ? meas.gen_tokens_per_s : d.gen_tokens_per_s;
  return `<div class="card"><span class="verdict v-${esc(d.verdict)}">${esc(vt)}</span> <span class="small">${esc(d.quant)} · ${(+d.context).toLocaleString("en-US")}-token context</span>
<div class="stats"><div class="stat"><div class="k"><span class="qi qm">${ICON.size}</span>Memory needed</div><div class="v">${mg.total} GB</div><div class="s">of ${mg.available} GB available</div></div>
<div class="stat"><div class="k"><span class="qi qs">${ICON.speed}</span>Speed${meas ? '<span class="tag m">measured</span>' : '<span class="tag">estimated</span>'}</div><div class="v">${speed} <span style="font-size:.8rem;font-weight:500">tokens/s</span></div><div class="s">${meas ? esc((meas.runtime || "") + (meas.date ? ", " + meas.date : "")) : (d.partly_on_cpu ? "part runs from system memory" : "from memory bandwidth")}</div></div></div>
<div style="position:relative"><div class="bar" title="model, context cache, overhead"><i style="width:${pct(mg.weights)}%;background:var(--accent)"></i><i style="width:${pct(mg.context_cache)}%;background:#8fa9ee"></i><i style="width:${pct(mg.overhead)}%;background:#c4cff3"></i></div>${mg.total > mg.available ? `<span title="available" style="position:absolute;top:-4px;bottom:-4px;left:${pct(mg.available)}%;width:2px;background:var(--bad)"></span>` : ""}</div>
<div class="small">Model ${mg.weights} GB · context cache ${mg.context_cache} GB · overhead ${mg.overhead} GB${mg.total > mg.available ? ` · <b style="color:var(--bad)">${(mg.total - mg.available).toFixed(1)} GB over</b>` : ""}</div>
${(d.suggestions || []).length ? `<ul class="tips">${d.suggestions.map(t => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}</div>`;
}
function checkPage(sp, origin) {
  const out = checkFit(sp);
  if (out.error) return page("LocalBit - not found", `<h1>Hmm, not sure about that one</h1><div class="card">${askBox(origin, sp.model || "", sp.hardware || "")}<p class="small">${esc(out.text)}</p></div>`, origin);
  const d = out.data;
  return page(`Can ${d.model} run on ${d.hardware}? - LocalBit`, `<h1>Can ${esc(d.model)} run on ${esc(d.hardware)}?</h1>${resultCard(out)}
<div class="card">${askBox(origin, sp.model || "", sp.hardware || "")}</div>`, origin);
}
function about(origin) {
  return page("About LocalBit - who runs it, privacy, data license", `<h1>About LocalBit</h1>
<p class="lede">A small, independent service that answers one question well: will this AI model run on this hardware?</p>
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
// (Nov 25, David: "I can't tell if one is better than the other") the measured page leads with two plain charts and a how-to-read
const ICON = {
  speed: `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" fill="currentColor"/></svg>`,
  size: `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
};
// (Nov 25, David: "put each model's results together ... other metrics we found important") one card per measured model with
// everything about it: speed, staying fast in long chats, reading a document, size on the card, energy - each with its icon
ICON.read = `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2h9l5 5v15H6z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M9 12h8M9 16h8M9 8h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
ICON.long = `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v10H9l-5 4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M8 10h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
ICON.power = `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
function charts(ids, byModel, name, origin) {
  const pick = id => byModel[id].find(x => x.context === 16384) || byModel[id][0];
  const at = (id, ctx) => (byModel[id].find(x => x.context === ctx) || {}).gen_tps;
  const max = k => Math.max(...ids.map(id => +pick(id)[k] || 0), 1e-9);
  const READ = 8;
  const secs = tps => Math.max(1, Math.round(400 / tps));
  const feel = tps => tps >= 60 ? "instant" : tps >= 25 ? "fast" : tps >= READ ? "comfortable" : "slow";
  const row = (cls, icon, label, pct, value, note, title) => `<div class="qrow" title="${esc(title)}"><span class="qi ${cls}">${icon}</span>
<div class="ql">${label}</div><div class="ct"><div class="cb ${cls}b" style="width:${Math.max(2, Math.min(100, pct)).toFixed(1)}%"></div></div><span class="qv">${value}</span><span class="qx">${note}</span></div>`;
  const cards = ids.map(id => { const r = pick(id), used = r.gpu_mem_peak_gib || 0, m = DATA.models.find(x => x.id === id) || {};
    const s4 = at(id, 4096), s32 = at(id, 32768), keep = s4 && s32 ? s32 / s4 : null;
    const doc = r.prompt_tps_4k ? Math.max(0.1, 4000 / r.prompt_tps_4k) : null;
    const size = m.params_b ? `${m.params_b}B` + (m.active_b && m.active_b < m.params_b ? ` (${m.active_b}B active)` : "") : "";
    return `<div class="qref"><div class="qn"><a href="${origin}/run/${esc(id)}/on/rtx-3090">${esc(name(id))}</a><span class="small"> ${esc(size)} · ${esc(r.quant || "")} · measured ${esc(r.date || "")}</span></div>
${row("qs", ICON.speed, "Speed", 100 * r.gen_tps / max("gen_tps"), `${(+r.gen_tps).toFixed(0)} tokens/s`, `${feel(r.gen_tps)} · a 300-word answer in ~${secs(r.gen_tps)} s`, `${r.gen_tps} tokens/s at 16K context`)}
${keep ? row("ql2", ICON.long, "Long chats", 100 * keep, keep >= 0.9 ? "stays fast" : `${Math.round(100 * keep)}% speed`, `${(+s4).toFixed(0)} → ${(+s32).toFixed(0)} tokens/s from a short chat (4K) to a long one (32K)`, "speed at 4K, 16K and 32K context") : ""}
${doc ? row("qr", ICON.read, "Reading", 100 * r.prompt_tps_4k / max("prompt_tps_4k"), `${doc < 10 ? doc.toFixed(1) : Math.round(doc)} s`, `to read a 4,000-token document (about 3,000 words) before answering`, `${r.prompt_tps_4k} tokens/s reading a 4,000-token prompt`) : ""}
${row("qm", ICON.size, "Size", 100 * used / 24, `${used.toFixed(1)} / 24 GB`, `${(24 - used).toFixed(1)} GB free${24 - used >= 8 ? " · room for a second model" : 24 - used >= 3 ? " · room for longer chats" : " · nearly full"}`, `${used} GB of the card's 24 GB at 16K context`)}
${r.tokens_per_joule ? row("qp", ICON.power, "Energy", 100 * r.tokens_per_joule / max("tokens_per_joule"), `${(r.power_w * 400 / r.gen_tps / 3600).toFixed(2)} Wh`, `energy per 300-word answer · ${Math.round(r.power_w)} W while generating, ${r.tokens_per_joule} tokens per joule`, `${r.power_w} W average while generating`) : ""}
</div>`; }).join("");
  return `<p class="small"><span class="qi qs">${ICON.speed}</span> Speed &nbsp;<span class="qi ql2">${ICON.long}</span> Long chats &nbsp;<span class="qi qr">${ICON.read}</span> Reading a document &nbsp;<span class="qi qm">${ICON.size}</span> Size on the card &nbsp;<span class="qi qp">${ICON.power}</span> Energy - longer bars are better, except Size (shorter leaves more room).</p>
<div class="qgrid">${cards}</div>
<div class="card"><h2 style="margin-top:0">Which is better?</h2>
<p style="margin:0">Faster isn't better at everything. Bigger models (more billions of parameters) usually give smarter, more careful answers but run slower and fill more of the card; small ones are quick but simpler. A good rule: <b>pick the biggest model that's still fast enough for you</b> - anything above reading speed (about ${READ} tokens a second) feels fine for chat; if you work with long documents, look at Reading too.</p></div>`;
}
function measuredPage(origin) {
  const rows = measuredFile.measured || [];
  const byModel = {};
  for (const r of rows) (byModel[r.model] = byModel[r.model] || []).push(r);
  const name = id => (DATA.models.find(m => m.id === id) || {}).name || id;
  const at = (rs, ctx, k) => { const r = rs.find(x => x.context === ctx); return r && r[k] != null ? r[k] : null; };
  const f = (v, d = 0) => v == null ? "-" : (+v).toLocaleString("en-US", { maximumFractionDigits: d });
  const ids = Object.keys(byModel).sort((a, b) => (at(byModel[b], 16384, "gen_tps") || 0) - (at(byModel[a], 16384, "gen_tps") || 0));
  const body = ids.map(id => { const rs = byModel[id]; const mid = rs.find(x => x.context === 16384) || rs[0];
    return `<tr><td><a href="${origin}/run/${esc(id)}/on/rtx-3090">${esc(name(id))}</a><br><small>${esc(mid.ollama_tag || "")} · ${esc(mid.quant || "")}</small></td>` +
      `<td>${f(at(rs, 4096, "gen_tps"), 1)}</td><td>${f(at(rs, 16384, "gen_tps"), 1)}</td><td>${f(at(rs, 32768, "gen_tps"), 1)}</td>` +
      `<td>${f(at(rs, 16384, "prompt_tps_4k"))}</td><td>${f(mid.gpu_mem_peak_gib, 1)}</td><td>${f(mid.power_w)}</td><td>${f(mid.tokens_per_joule, 2)}</td><td>${esc(mid.date || "")}</td></tr>`; }).join("");
  const any = rows[0] || {};
  return page("Measured: local AI models on an RTX 3090 - LocalBit", `<h1>Measured on an RTX 3090</h1>
<p class="lede">Real runs on LocalBit's own test machine - not estimates. Each model alone on the card, the middle of 3 runs at each context length, temperature 0, the same made-up prompts for every model. ${ids.length} model${ids.length === 1 ? "" : "s"} so far; more are added overnight.</p>
${ids.length ? charts(ids, byModel, name, origin) : ""}
${ids.length ? `<details class="card"><summary>All the numbers as a table</summary><div class="scroll"><table class="meas">
<thead><tr><th rowspan="2">Model</th><th colspan="3" style="text-align:center">Tokens/s by context</th><th rowspan="2">Prompt<br>tokens/s</th><th rowspan="2">Memory<br>GB</th><th rowspan="2">Power<br>W</th><th rowspan="2">Tokens<br>per joule</th><th rowspan="2">Date</th></tr><tr><th>4K</th><th>16K</th><th>32K</th></tr></thead>
<tbody>${body}</tbody></table><div class="meas-note">Prompt = reading a 4,000-token prompt at 16K context. Memory = the whole card's peak at 16K. Power = the card's average while generating.</div></div></details>` : "<p>No results yet.</p>"}
<h2>The machine</h2><p>NVIDIA GeForce RTX 3090 24 GB, Windows, ${esc(any.runtime || "Ollama")}${any.driver ? ", driver " + esc(String(any.driver).split(",")[0]) : ""}. "Card memory used" is the whole card's peak, including about 0.5-1 GB for the desktop. Power is the card's average draw while generating.</p>
<h2>Use the data</h2><p>JSON: <a href="${origin}/api/measured">${origin}/api/measured</a> · every raw run and the scripts: <a href="https://github.com/adamson-gh/localbit">github.com/adamson-gh/localbit</a> · license <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a> - credit LocalBit. See something different on your 3090? Use the form on a result page.</p>`, origin);
}
function pairPage(mid, gid, origin) {
  const m = DATA.models.find(x => x.id === mid), g = DATA.gpus.find(x => x.id === gid);
  if (!m || !g) return null;
  const out = checkFit({ model: m.id, hardware: g.id });
  const others = DATA.gpus.filter(x => x.id !== g.id && Math.abs(x.vram_gb - g.vram_gb) <= 8).slice(0, 8)
    .map(x => `<a href="${origin}/run/${m.id}/on/${x.id}">${esc(x.name.replace(/^NVIDIA GeForce |^AMD Radeon /, ""))}</a>`).join("");
  return page(`Can ${m.name} run on ${g.name}? - LocalBit`, `<h1>Can ${esc(m.name)} run on ${esc(g.name)}?</h1>${resultCard(out)}
<h2>Other cards</h2><div class="chips">${others}</div>
<h2>Different settings?</h2><p class="small">Ask with your own context length: <code>${origin}/api/check?model=${encodeURIComponent(m.id)}&amp;hardware=${encodeURIComponent(g.id)}&amp;context=32768</code></p>
<h2>What an agent receives</h2><pre class="small">${esc(out.text)}</pre>
${reportForm(origin, m, g)}`, origin, out.text.split("\n")[0]);
}
function llmsTxt(origin) {
  return `# LocalBit\n\n> Will an AI model run on this hardware? Memory needed (weights + context cache) and estimated or measured generation speed for local models on graphics cards and Apple computers.\n\n` +
    `## For agents\n- MCP (Streamable HTTP): ${origin}/mcp - tools: check_fit(model, hardware, context?, quant?, kv_cache?), suggest_models(hardware, context?, min_tokens_per_s?), list_known(kind), report_issue(problem, model?, hardware?, observed_tokens_per_s?, observed_memory_gb?, runtime?, note?)\n` +
    `- JSON API: ${origin}/api/check?model=...&hardware=...&context=...&quant=... ; ${origin}/api/suggest?hardware=... ; ${origin}/api/models ; ${origin}/api/hardware ; ${origin}/api/measured ; POST ${origin}/api/report (JSON)\n\n` +
    `## Notes\n- Speeds are labeled "estimated" or "measured"; every answer ends with the date the data is current as of (data_as_of in JSON).\n- ${asOfText()}\n- Measured results (RTX 3090): ${origin}/measured (table) and ${origin}/api/measured (JSON)\n- LocalBit records the tool, model and hardware asked about and the client's self-reported name - no IP addresses or personal data.\n- Open data: measurements and tables are CC BY 4.0 (credit LocalBit). Limits: 120 requests/minute per address. Run by ${OWNER.name} (${OWNER.url}). Details: ${origin}/about\n`;
}
function sitemap(origin) {
  const urls = [origin + "/", origin + "/measured", origin + "/about"];
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
  // (Nov 25, David: "yes add that") estimate vs measured for every measured model: drift over 10% means the formula needs a look
  const drift = (measuredFile.measured || []).map(r => { const m = DATA.models.find(x => x.id === r.model), g = DATA.gpus.find(x => x.id === r.gpu);
    if (!m || !g || !r.gen_tps) return null; const e = estimate(m, g, { context: r.context, quant: r.quant }, DATA.quants);
    return { model: r.model, gpu: r.gpu, context: r.context, measured: r.gen_tps, estimated: e.gen_tokens_per_s, off_pct: Math.round(100 * (e.gen_tokens_per_s - r.gen_tps) / r.gen_tps) }; }).filter(Boolean);
  return json({ days, estimate_drift: drift,
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
    if (path === "/check") { const o = checkFit(sp); logCall(env, ctx, { kind: "check_page", ua, tool: "check_fit", model_q: sp.model, hw_q: sp.hardware, ...o.log }); return checkPage(sp, origin); }
    if (path === "/measured") { logCall(env, ctx, { kind: "measured", ua }); return measuredPage(origin); }
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
