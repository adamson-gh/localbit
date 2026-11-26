// LocalBit - a public "will this AI model run on this hardware?" service for AI agents and people.
// Cloudflare Worker. Doors: MCP (POST /mcp, Streamable HTTP, stateless JSON responses), a plain JSON API (/api/...),
// web pages per model and card (/run/<model>/on/<card>), /llms.txt and /sitemap.xml.
// Every call is logged to D1 (env.DB) with what was asked - never an IP address or anything personal. /stats is for the owner.
import modelsFile from "../data/models.json" with { type: "json" };
import gpusFile from "../data/gpus.json" with { type: "json" };
import measuredFile from "../data/measured.json" with { type: "json" };
import siteFile from "../config/site.json" with { type: "json" };
import communityFile from "../data/community.json" with { type: "json" };
import recipeFile from "../data/recipe.json" with { type: "json" };
import TEST_SCRIPT from "./generated/test_script.js";
import { findModel, findGpu, estimate, measuredFor, suggestions, suggestModels, closest, familyOf } from "./estimate.js";

const VERSION = "0.4.1";
const SITE = siteFile.site;
const OWNER = { name: siteFile.owner, url: siteFile.owner_url };
const DATA = { models: modelsFile.models, quants: modelsFile.quants, measured: [...(measuredFile.measured || []), ...modelsFile.measured], gpus: gpusFile.gpus };
// When the data was last checked: specs = the cards and models files; measured = the newest overnight result.
const AS_OF = { specs: [gpusFile.updated, modelsFile.updated].filter(Boolean).sort().pop() || null,
                measured: DATA.measured.map(m => m.date || "").sort().pop() || null };
const asOfText = () => `Data as of: specs ${AS_OF.specs}` + (AS_OF.measured ? `, newest measurement ${AS_OF.measured}` : "") + ".";
// (Nov 25 check: a spike was ClaudeBot reading all ~800 model/card pages) search and AI crawlers, counted apart from real asks
const CRAWLERS = ["ClaudeBot", "Claude-SearchBot", "GPTBot", "OAI-SearchBot", "Googlebot", "Google-Extended", "bingbot", "Applebot", "PerplexityBot",
  "Meta-ExternalAgent", "Amazonbot", "Bytespider", "CCBot", "DuckAssistBot", "YandexBot", "Baiduspider", "BrickBlueBot", "AhrefsBot", "SemrushBot"];
// (Nov 26) the owner's own fresh-agent test (bench/agent_eval.py) - left out of visitor counts, counted on its own
const SELF_UA = "localbit-self-test";
const NOT_CRAWL = "(" + CRAWLERS.map(c => `coalesce(ua, '') NOT LIKE '%${c}%'`).join(" AND ") + ` AND coalesce(ua, '') NOT LIKE '%${SELF_UA}%')`;
const IS_CRAWL = "(" + CRAWLERS.map(c => `coalesce(ua, '') LIKE '%${c}%'`).join(" OR ") + ")";
// paths only scanners ask for (looking for weak websites) - counted, but told apart from addresses an agent might expect
const SCANNER_SQL = "(path LIKE '%wp-%' OR path LIKE '%.php%' OR path LIKE '%.env%' OR path LIKE '%.git%' OR path LIKE '%admin%' OR path LIKE '%phpmyadmin%' OR path LIKE '%.asp%' OR path LIKE '%cgi-bin%' OR path LIKE '%.sql%' OR path LIKE '%config%' OR path LIKE '%backup%' OR path LIKE '%.bak%' OR path LIKE '%xmlrpc%')";
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const KNOWN_AGENTS = ["ChatGPT-User", "OAI-SearchBot", "GPTBot", "Claude-User", "Claude-SearchBot", "ClaudeBot", "Claude-Code", "Perplexity-User",
  "PerplexityBot", "Google-Extended", "Googlebot", "bingbot", "Applebot", "Meta-ExternalAgent", "Amazonbot", "Bytespider", "CCBot", "DuckAssistBot",
  "MistralAI-User", "cohere-ai", "Cursor", "python-httpx", "node", "curl"];

const INSTRUCTIONS = "LocalBit answers whether a local AI model will run on a graphics card, several cards ('2x RTX 3090') or a Mac, how much memory " +
  "it needs and how fast it will generate. check_fit for one model on one setup; compare for two models or two setups; suggest_models for what fits; " +
  "node_log for the newest measurements from LocalBit's RTX 3090 node; list_known for exact names and ids. Every answer says estimated (with a likely " +
  "range) or measured, how current the data is, and links a page to cite (source_url). If an answer turns out wrong, call report_issue with what was seen.";

const S = (props, extra = {}) => ({ type: "object", properties: props, ...extra });
const OUT = {
  check_fit: S({ model: { type: "string" }, hardware: { type: "string" }, verdict: { type: "string", enum: ["fits", "tight", "does_not_fit"] },
    quant: { type: "string" }, context: { type: "integer" }, memory_gb: S({ weights: { type: "number" }, context_cache: { type: "number" }, overhead: { type: "number" }, total: { type: "number" }, available: { type: "number" } }),
    gen_tokens_per_s: { type: "number" }, gen_tokens_per_s_range: { type: "array", items: { type: "number" } }, basis: { type: "string", enum: ["estimated", "measured"] },
    measured: { type: ["object", "null"] }, suggestions: { type: "array", items: { type: "string" } }, source_url: { type: "string" }, data_as_of: S({ specs: { type: ["string", "null"] }, measured: { type: ["string", "null"] } }) }),
  suggest_models: S({ hardware: { type: "string" }, models: { type: "array", items: S({ model: { type: "string" }, quant: { type: "string" }, memory_gb: { type: "number" }, gen_tokens_per_s: { type: "number" }, basis: { type: "string" } }) } }),
  compare: S({ a: { type: "object" }, b: { type: "object" }, a_node: { type: ["object", "null"] }, b_node: { type: ["object", "null"] } }),
  node_log: S({ readings: { type: "array", items: S({ model: { type: "string" }, date: { type: "string" }, gen_tps: { type: "number" }, quality_pct: { type: ["number", "null"] }, memory_gb: { type: "number" } }) } }),
  list_known: S({ models: { type: "array" }, hardware: { type: "array" } }),
};
const TOOLS = [
  { name: "check_fit", title: "Will this model run on this hardware?",
    description: "Checks whether one local AI model fits one hardware setup - a graphics card, several identical cards ('2x RTX 3090') or a Mac - and returns the verdict (fits / tight / does_not_fit), memory needed (weights + context cache + overhead) against memory available, and generation speed in tokens per second: measured on LocalBit's test node where it has run that pair, otherwise estimated with a likely range. When it doesn't fit, it says what to change (smaller quantization, shorter context, other hardware); it warns when the context exceeds the model's published maximum. Use this when the user names a model and their hardware. Use suggest_models instead when they only name hardware ('what can I run?'), compare when weighing two options, and list_known first if a name isn't recognised (unknown names return the closest known ones). Every answer includes a citable source_url and the date the data is current as of.",
    inputSchema: { type: "object", required: ["model", "hardware"], properties: {
      model: { type: "string", description: "Model name, e.g. 'Llama 3.1 8B', 'qwen3:30b', 'gpt-oss 20b', or a size like '13B model'. list_known gives exact names." },
      hardware: { type: "string", description: "Graphics card, several cards ('2x RTX 3090') or a Mac ('M2 Pro 32 GB'), or memory like '12 GB card'. list_known gives exact names." },
      context: { type: "integer", description: "Context length in tokens (default 8192)." },
      quant: { type: "string", description: "Quantization, e.g. Q4_K_M (default), Q8_0, F16." },
      kv_cache: { type: "string", description: "Context cache type: f16 (default), q8_0 or q4_0." } } },
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true } },
  { name: "suggest_models", title: "Which models fit this hardware?",
    description: "Lists the largest known local AI models that fit on the given hardware at the given context length (default 8,192 tokens), up to 10, biggest first, each with its quantization, memory needed and speed in tokens per second (measured where LocalBit's node has run it, otherwise estimated). min_tokens_per_s drops models slower than that. Use this when the user names only their hardware and asks what they can run; use check_fit to verify one specific model, and compare to weigh two. If nothing fits it says so; unknown hardware returns an error with how to describe it (a card name, memory like '16 GB', or a Mac chip).",
    inputSchema: { type: "object", required: ["hardware"], properties: {
      hardware: { type: "string", description: "Graphics card or computer, e.g. 'RTX 4060', 'M4 Pro', '16 GB'." },
      context: { type: "integer", description: "Context length in tokens (default 8192)." },
      min_tokens_per_s: { type: "number", description: "Only models at least this fast (estimated)." } } },
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true } },
  { name: "list_known", title: "Models and hardware LocalBit knows",
    description: "Returns LocalBit's catalog: kind 'models' gives every model with its id, name and parameter count (and active parameters for mixture-of-experts models); kind 'hardware' gives every graphics card and Mac with its id, name and memory. Each entry says whether LocalBit's test node has measured it. Call this first when unsure how to name a model or card, then pass the exact id to check_fit, compare or suggest_models. Sizes not listed still work in those tools ('13B model', '12 GB card', 'M2 Pro 32 GB').",
    inputSchema: { type: "object", required: ["kind"], properties: { kind: { type: "string", enum: ["models", "hardware"] } } },
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true } },
  { name: "compare", title: "Compare two models or two cards",
    description: "Compares two options head to head, in one of two modes: two models on the same hardware (give a_model, b_model and a_hardware), or one model on two hardware setups (give a_model, a_hardware and b_hardware). Returns which fits, which is faster (with the ratio), which leaves more memory free and - only where LocalBit's node measured both - which scores higher on its quality check and uses less energy per answer; otherwise it says those are unavailable. context (default 8,192 tokens) applies to both. Use this when the user is choosing between two options; use check_fit for a single model and hardware. Giving neither b_model nor b_hardware returns an error asking for the second option.",
    inputSchema: { type: "object", required: ["a_model", "a_hardware"], properties: {
      a_model: { type: "string", description: "First model, e.g. 'gemma 4 e4b'." },
      a_hardware: { type: "string", description: "First hardware, e.g. 'rtx 3090'." },
      b_model: { type: "string", description: "Second model (leave out to compare one model on two cards)." },
      b_hardware: { type: "string", description: "Second hardware (leave out to compare two models on the same card)." },
      context: { type: "integer", description: "Context length in tokens (default 8192)." } } },
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true } },
  { name: "node_log", title: "Latest readings from LocalBit's test node",
    description: "Returns the newest measurements from LocalBit's own RTX 3090 test node, newest first (default 10, up to 50): for each model, measured speed in tokens per second at 16K context, quality score (% of 60 script-graded questions right), card memory used, time to read a 3,000-word document, energy per answer, and the date. Use this when the user asks what has actually been tested or measured recently, or wants real results rather than estimates; use check_fit or compare to answer about a specific model and hardware (they include these measurements automatically when they apply).",
    inputSchema: { type: "object", properties: { limit: { type: "integer", description: "How many models (default 10)." } } },
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true } },
  { name: "get_details", title: "Full details of one model or card",
    description: "Returns everything LocalBit knows about one model (parameters, active parameters, layers, attention heads, maximum context, whether its specs are verified) or one graphics card or Mac (memory, memory bandwidth), plus its measurements from LocalBit's node and from the community. Use this when the user wants the specifications themselves or what has been measured for a model or card; use check_fit to ask whether a model runs on hardware, and list_known to browse names. Unknown names return the closest known ones.",
    inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string", description: "A model ('qwen3 32b') or hardware ('rtx 4090', 'm4 max')." },
      kind: { type: "string", enum: ["model", "hardware"], description: "Optional - which one the name is, if ambiguous." } } },
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true } },
  { name: "get_test_kit", title: "How to measure a model on your own machine",
    description: "Returns LocalBit's 3-minute test: a script (Python, nothing to install) that measures a model in the user's own Ollama the same way LocalBit's RTX 3090 node does, shows exactly what would be shared and asks before sending anything. Use this when the user has hardware LocalBit hasn't measured and is willing to contribute, or wants real numbers for their own machine; answers from check_fit say when a setup hasn't been measured yet. Results are sent with submit_result (the script does this itself after the user agrees).",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true } },
  { name: "submit_result", title: "Contribute a measurement",
    description: "Sends LocalBit a measurement made with its recipe (get_test_kit): the model's Ollama tag, quantization, hardware name and memory, Ollama version, OS and, for each context length, tokens per second (and optionally prompt speed and whether the model sat fully on the card). Use this after the user has seen the numbers and agreed to share them - never before; never include names, file paths or other personal details. Each result is checked against LocalBit's estimate: plausible ones are published as community results (labelled unverified), others are flagged for review. Use report_issue instead for a single wrong answer without a full measurement. Limited to 5 a minute.",
    inputSchema: { type: "object", required: ["model", "hardware", "results"], properties: {
      model: { type: "string", description: "The model's Ollama tag, e.g. 'llama3.1:8b'." }, quant: { type: "string", description: "Quantization, e.g. 'Q4_K_M'." },
      hardware: { type: "string", description: "Graphics card or Mac name, e.g. 'NVIDIA GeForce RTX 4060'." }, memory_gb: { type: "number", description: "Its memory in GB." },
      cards: { type: "integer", description: "Number of identical cards (default 1)." }, runtime: { type: "string", description: "e.g. 'Ollama 0.40.15'." }, os: { type: "string", description: "Windows, macOS or Linux." },
      recipe_version: { type: "string" },
      results: { type: "array", items: { type: "object", required: ["context", "gen_tps"], properties: { context: { type: "integer" }, gen_tps: { type: "number" }, prompt_tps: { type: "number" }, all_on_gpu: { type: "boolean" }, loaded_gb: { type: "number" } } } } } },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false } },
  { name: "report_issue", title: "Report a wrong or missing answer",
    description: "Sends LocalBit a report that an answer was wrong (it didn't fit, the speed was different, a spec is off) or that a model or card is missing, so it can be corrected. Use this after check_fit, compare or suggest_models gave an answer the user's real experience contradicts. Real results help most: the tokens per second and memory actually seen, the context length and the runtime. Never include names, emails or other personal details - notes are stored as written with emails, numbers and links removed. Returns a confirmation; each call files a separate report, so send it once. Limited to 5 reports a minute.",
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
  // (Nov 25 check: callers sent no model or hardware and got 'doesn't know the model "undefined"') say what's missing instead
  if (!String(args.model || "").trim() || !String(args.hardware || "").trim()) {
    const miss = [!String(args.model || "").trim() && "model", !String(args.hardware || "").trim() && "hardware"].filter(Boolean);
    return { error: true, text: `check_fit needs both a model and hardware - ${miss.join(" and ")} missing. Example: model "llama 3.1 8b", hardware "rtx 4060" (or memory, like "12 GB"). list_known shows what LocalBit knows.`,
             data: { missing: miss }, log: { verdict: "missing_args" } };
  }
  const m = findModel(args.model, DATA.models), g = findGpu(args.hardware, DATA.gpus);
  if (!m || !g) {
    const fam = !m ? familyOf(args.model, DATA.models) : [];
    if (fam.length > 1 && g) return { error: true, text: `${args.model} comes in ${fam.length} sizes LocalBit knows: ${fam.map(x => x.name).join(", ")}. Ask again with the size, e.g. "${fam[0].name}".`,
      data: { model_found: false, hardware_found: true, sizes: fam.map(x => ({ id: x.id, name: x.name, params_b: x.params_b })) }, log: { gpu_id: g.id, verdict: "needs_size" } };
    const cm = !m ? closest(args.model, DATA.models) : [], cg = !g ? closest(args.hardware, DATA.gpus) : [];
    return { error: true, text: (!m ? `LocalBit doesn't know the model "${args.model}" yet.${cm.length ? " Closest known: " + cm.join(", ") + "." : ""} Add its size (like "17B") for an estimate, or call list_known for exact names. ` : "") +
      (!g ? `LocalBit doesn't know the hardware "${args.hardware}" yet.${cg.length ? " Closest known: " + cg.join(", ") + "." : ""} Give its memory (like "12 GB") for an estimate, or call list_known.` : ""),
      data: { model_found: !!m, hardware_found: !!g, closest_models: cm, closest_hardware: cg }, log: { model_id: m && m.id, gpu_id: g && g.id, verdict: "unknown" } };
  }
  const e = estimate(m, g, args, DATA.quants);
  const meas = measuredFor(e, DATA.measured);
  // (Nov 26) where the node hasn't measured, results people submitted (checked for plausibility, labelled unverified)
  const comm = meas ? null : measuredFor(e, (communityFile.community || []).map(r => ({ ...r, runs: r.n })));
  const tips = suggestions(e, m, g, DATA);
  const speed = meas ? `${meas.gen_tokens_per_s} tokens/s measured (${meas.results} result${meas.results > 1 ? "s" : ""}, ${meas.quant}, ${meas.runtime}${meas.date ? ", measured " + meas.date : ""})`
              : comm ? `${comm.gen_tokens_per_s} tokens/s measured by ${comm.results} community run${comm.results > 1 ? "s" : ""} (unverified, ${comm.quant}, ${comm.runtime}${comm.date ? ", " + comm.date : ""}); estimate ${e.gen_tokens_per_s}`
                     : `about ${e.gen_tokens_per_s} tokens/s (estimated, likely ${e.gen_tokens_per_s_range[0]}-${e.gen_tokens_per_s_range[1]}${e.partly_on_cpu ? ", with part of the model running from system memory" : ""})`;
  const verdictText = { fits: "Yes, it fits.", tight: "Just barely - it may not fit once other apps use the card.", does_not_fit: "No, not entirely on this hardware." }[e.verdict];
  const lines = [
    `${e.model} on ${e.hardware} (${e.quant}, ${e.context.toLocaleString("en-US")}-token context): ${verdictText}`,
    `Memory: about ${e.memory_gb.total} GB needed of ${e.memory_gb.available} GB available (model ${e.memory_gb.weights} GB, context cache ${e.memory_gb.context_cache} GB, overhead ${e.memory_gb.overhead} GB).`,
    `Speed: ${speed}.`,
    ...tips.map(t => "- " + t),
  ];
  if (g.cards > 1) lines.push(`Note: ${g.cards} cards of ${g.per_card_gb} GB each, the model split across them by layers - memory adds up; speed stays near one card's, about 10% lower for the hand-off. Runtimes like llama.cpp and Ollama do this.`);
  if (m.max_ctx && e.context > m.max_ctx) lines.splice(1, 0, `Warning: ${m.name} handles at most ${m.max_ctx.toLocaleString("en-US")} tokens of context - ${e.context.toLocaleString("en-US")} is beyond what it was made for, whatever the memory. The numbers below are for memory only.`);
  else if (m.native_ctx && e.context > m.native_ctx) lines.push(`Note: past ${m.native_ctx.toLocaleString("en-US")} tokens ${m.name} needs long-context (YaRN) settings turned on in the runtime.`);
  if (m.family_only) lines.push(`Note: "${m.family_only}" - LocalBit knows one size of it, ${m.name}, so this is for that one.`);
  if (m.asked_as) lines.push(`Note: "${m.asked_as}" is built on the same design as ${m.name}, so it is sized as that.`);
  if (g.asked_as) lines.push(`Note: "${g.asked_as}" is sized as ${g.name}.`);
  if (g.vendor === "apple" && g.matched === "generic") lines.push(`Note: a Mac LocalBit doesn't list by name - unified memory, about 75% usable for the model, typical ${g.name.split(" (")[0]} bandwidth.`);
  if (m.matched === "generic" || g.matched === "generic") lines.push("Note: estimated from size alone - give the exact model or card name for a closer answer.");
  if (!m.verified && m.matched === "known") lines.push("Note: this model's specifications are from its published config and not yet re-checked.");
  const url = m.matched === "known" && g.matched === "known" && !g.cards ? `${SITE}/run/${m.id}/on/${g.id}` :
    `${SITE}/check?model=${encodeURIComponent(args.model)}&hardware=${encodeURIComponent(args.hardware)}`;
  if (!meas && !comm && g.matched === "known" && !g.cards && e.verdict !== "does_not_fit")
    lines.push(`Not measured on this hardware yet: anyone with it can add the first real numbers with LocalBit's 3-minute test (get_test_kit, or ${SITE}/test).`);
  lines.push(`Details: ${url}`);
  lines.push(asOfText());
  return { text: lines.join("\n"), data: { ...e, measured: meas, suggestions: tips, basis: meas ? "measured" : comm ? "community" : "estimated", community: comm || null, data_as_of: AS_OF, source_url: url,
           ...(m.max_ctx && e.context > m.max_ctx ? { context_beyond_model_max: true } : {}) },
           log: { model_id: m.id, gpu_id: g.id, verdict: e.verdict, context: e.context, quant: e.quant } };
}

function suggest(args) {
  const g = findGpu(args.hardware, DATA.gpus);
  if (!String(args.hardware || "").trim()) return { error: true, text: `suggest_models needs hardware - a card name like "rtx 4060" or memory like "16 GB".`, data: { missing: ["hardware"] }, log: { verdict: "missing_args" } };
  if (!g) return { error: true, text: `LocalBit doesn't know the hardware "${args.hardware}" yet - try a card name or its memory, like "12 GB".`, data: {}, log: { verdict: "unknown" } };
  const list = suggestModels(g, args, DATA);
  const text = list.length ? `Largest known models that fit on ${g.name} (${(+args.context || 8192).toLocaleString("en-US")}-token context; speeds estimated unless marked measured):\n` +
    list.map(x => `- ${x.model} (${x.quant}): ${x.memory_gb} GB, ${x.basis === "measured" ? x.gen_tokens_per_s + " tokens/s measured" : "~" + x.gen_tokens_per_s + " tokens/s"}`).join("\n") : `None of the known models fit on ${g.name} at that context.`;
  return { text: text + "\n" + asOfText(), data: { hardware: g.name, models: list, basis: list.some(x => x.basis === "measured") ? "mixed" : "estimated", data_as_of: AS_OF }, log: { gpu_id: g.id, verdict: list.length ? "listed" : "none" } };
}

function listKnown(args) {
  // (Nov 25) ids and sizes too, so an agent can pass an exact id and pick by size; Macs and memory sizes not listed still work
  if (args.kind === "hardware") {
    const rows = DATA.gpus.map(g => ({ id: g.id, name: g.name, memory_gb: g.vram_gb, bandwidth_gbs: g.bandwidth_gbs, measured: DATA.measured.some(r => r.gpu === g.id) }));
    return { text: `${rows.length} cards and Macs (also accepted: any memory size like "12 GB", or a Mac chip like "M2 Pro 32 GB"):\n` + rows.map(r => `- ${r.name} [${r.id}] ${r.memory_gb} GB${r.measured ? " · measured" : ""}`).join("\n"),
             data: { hardware: rows }, log: {} };
  }
  const rows = DATA.models.map(m => ({ id: m.id, name: m.name, params_b: m.params_b, active_b: m.active_b || m.params_b, measured: DATA.measured.some(r => r.model === m.id) }));
  return { text: `${rows.length} models (also accepted: any size like "13B model"):\n` + rows.map(r => `- ${r.name} [${r.id}] ${r.params_b}B${r.active_b < r.params_b ? `, ${r.active_b}B active` : ""}${r.measured ? " · measured" : ""}`).join("\n"),
           data: { models: rows }, log: {} };
}

// (Nov 25, owner: "fun things for the agents" -> compare two + the node log -> "Ok")
function compare(args) {
  const A = { model: args.a_model, hardware: args.a_hardware, context: args.context, quant: args.quant };
  const B = { model: args.b_model || args.a_model, hardware: args.b_hardware || args.a_hardware, context: args.context, quant: args.quant };
  if (!args.b_model && !args.b_hardware) return { error: true, text: "compare needs a second model (b_model) or a second card (b_hardware).", data: { missing: ["b_model or b_hardware"] }, log: { verdict: "missing_args" } };
  const a = checkFit(A), b = checkFit(B);
  if (a.error || b.error) return { error: true, text: [a.error && "First: " + a.text, b.error && "Second: " + b.text].filter(Boolean).join("\n"), data: {}, log: { verdict: "unknown" } };
  const da = a.data, db = b.data, label = d => args.b_model ? d.model : d.hardware;
  const sp = d => d.measured ? d.measured.gen_tokens_per_s : d.gen_tokens_per_s;
  const node = d => (measuredFile.measured || []).find(r => r.model === d.model_id && r.gpu === d.hardware_id && r.context === 16384) ||
                    (measuredFile.measured || []).find(r => r.model === d.model_id && r.gpu === d.hardware_id);
  const na = node(da), nb = node(db);
  const fits = d => d.verdict === "fits" ? "fits" : d.verdict === "tight" ? "just fits" : "doesn't fit";
  const lines = [`${label(da)} vs ${label(db)}${args.b_model ? " on " + da.hardware : ", running " + da.model} (${da.quant}, ${(+da.context).toLocaleString("en-US")}-token context):`];
  lines.push(`- Fit: ${label(da)} ${fits(da)} (${da.memory_gb.total} of ${da.memory_gb.available} GB); ${label(db)} ${fits(db)} (${db.memory_gb.total} of ${db.memory_gb.available} GB).`);
  const ra = sp(da), rb = sp(db), fast = ra >= rb ? [da, ra, rb] : [db, rb, ra];
  const r0 = v => Math.round(v * 10) / 10 >= 100 ? Math.round(v) : Math.round(v * 10) / 10;
  lines.push(`- Speed: ${label(fast[0])} is faster - ${r0(fast[1])} vs ${r0(fast[2])} tokens/s${Math.min(ra, rb) > 0 ? ` (${(Math.max(ra, rb) / Math.min(ra, rb)).toFixed(1)}x)` : ""}${da.measured || db.measured ? "" : ", both estimated"}.`);
  const fa = da.memory_gb.available - da.memory_gb.total, fb = db.memory_gb.available - db.memory_gb.total;
  lines.push(`- Room left: ${label(fa >= fb ? da : db)} leaves more free (${Math.max(fa, fb).toFixed(1)} GB vs ${Math.min(fa, fb).toFixed(1)} GB).`);
  if (na && nb && na.quality_pct != null && nb.quality_pct != null)
    lines.push(`- Quality (node check): ${label(na.quality_pct >= nb.quality_pct ? da : db)} scores higher - ${Math.max(na.quality_pct, nb.quality_pct)}% vs ${Math.min(na.quality_pct, nb.quality_pct)}% right.`);
  if (na && nb && na.power_w && nb.power_w) { const wa = na.power_w * 400 / na.gen_tps / 3600, wb = nb.power_w * 400 / nb.gen_tps / 3600;
    lines.push(`- Energy (node): ${label(wa <= wb ? da : db)} uses less - ${Math.min(wa, wb).toFixed(2)} vs ${Math.max(wa, wb).toFixed(2)} Wh per 300-word answer.`); }
  if (!(na && nb)) lines.push("- Quality and energy: only shown when LocalBit's node has measured both.");
  lines.push(asOfText());
  return { text: lines.join("\n"), data: { a: da, b: db, a_node: na || null, b_node: nb || null, data_as_of: AS_OF },
           log: { model_id: da.model_id, gpu_id: da.hardware_id, verdict: "compare" } };
}
function nodeEntries(limit = 10) {
  const by = {};
  for (const r of measuredFile.measured || []) { const k = r.model; if (!by[k] || r.context === 16384) by[k] = r; }
  return Object.values(by).sort((x, y) => String(y.quality_date || y.date).localeCompare(String(x.quality_date || x.date)) || String(y.date).localeCompare(String(x.date)))
    .slice(0, Math.max(1, Math.min(50, +limit || 10)))
    .map(r => ({ model: (DATA.models.find(m => m.id === r.model) || {}).name || r.model, model_id: r.model, gpu: "RTX 3090", date: r.date,
                 gen_tps: Math.round(r.gen_tps), quality_pct: r.quality_pct ?? null, memory_gb: Math.round(r.gpu_mem_peak_gib * 10) / 10, read_4k_s: r.prompt_tps_4k ? +(4000 / r.prompt_tps_4k).toFixed(1) : null,
                 wh_per_answer: r.power_w ? +(r.power_w * 400 / r.gen_tps / 3600).toFixed(2) : null }));
}
function nodeLog(args) {
  const e = nodeEntries(args.limit);
  const text = e.length ? `Latest readings from LocalBit's RTX 3090 node (newest first):\n` + e.map(x => `- ${x.date}: ${x.model} - ${x.gen_tps} tokens/s` +
    (x.quality_pct != null ? `, ${x.quality_pct}% quality` : "") + `, ${x.memory_gb} GB, ${x.read_4k_s ?? "-"} s to read 3,000 words, ${x.wh_per_answer ?? "-"} Wh per answer`).join("\n") : "No readings yet.";
  return { text, data: { readings: e, data_as_of: AS_OF }, log: { verdict: "log" } };
}
for (const tdef of TOOLS) if (OUT[tdef.name]) tdef.outputSchema = OUT[tdef.name];
// ---------- contributions (Nov 26, owner: "plan then build") ----------
function getTestKit() {
  const text = [`LocalBit's 3-minute test measures a model on your own machine the same way LocalBit's RTX 3090 node does, then asks before sharing anything.`,
    `1. Needs Python 3.8+ and Ollama with the model pulled.`, `2. Download: ${SITE}/test.py  (source: ${siteFile.repo}/blob/main/bench/localbit_test.py)`,
    `3. Run: python test.py --model <ollama tag>   (add --dry-run to see the numbers without sending)`,
    `It shows exactly what would be sent - model, card or Mac name and memory, speeds, Ollama version, OS - and asks yes/no. No names, file paths or IPs.`,
    `Recipe (if you'd rather run it yourself): ${SITE}/recipe.json - then send results with submit_result.`].join("\n");
  return { text, data: { script_url: SITE + "/test.py", recipe_url: SITE + "/recipe.json", recipe_version: recipeFile.recipe_version, page: SITE + "/test" }, log: { verdict: "test_kit" } };
}
function checkSubmission(b) {
  const reasons = [], rows = [];
  const res = Array.isArray(b.results) ? b.results.slice(0, 4) : [];
  if (!b.model || !b.hardware || !res.length) return { status: "rejected", reasons: ["needs model, hardware and at least one result"], rows };
  const m = findModel(String(b.model), DATA.models);
  let hw = String(b.hardware); if (+b.cards > 1 && !/\d\s*x/i.test(hw)) hw = `${+b.cards}x ${hw}`;
  const g = findGpu(hw, DATA.gpus) || (b.memory_gb ? findGpu(`${b.memory_gb} GB`, DATA.gpus) : null);
  if (!m) reasons.push("model not known to LocalBit");
  if (!g) reasons.push("hardware not known to LocalBit");
  if (g && b.memory_gb && g.vram_gb && Math.abs(+b.memory_gb - g.vram_gb) / g.vram_gb > 0.25) reasons.push(`reported memory ${b.memory_gb} GB differs from the card's ${g.vram_gb} GB`);
  for (const r of res) {
    const ctx = Math.round(+r.context || 0), tps = +r.gen_tps;
    const rr = { context: ctx, gen_tps: tps, prompt_tps: Number.isFinite(+r.prompt_tps) ? +r.prompt_tps : null, all_on_gpu: r.all_on_gpu === undefined ? null : !!r.all_on_gpu, loaded_gb: Number.isFinite(+r.loaded_gb) ? +r.loaded_gb : null, reasons: [] };
    if (!(ctx >= 512 && ctx <= 1048576) || !(tps > 0.05 && tps < 5000)) { rr.reasons.push("result out of range"); rows.push(rr); continue; }
    if (rr.all_on_gpu === false) rr.reasons.push("model was partly off the graphics card");
    if (m && g) {
      const e = estimate(m, g, { context: ctx, quant: b.quant }, DATA.quants);
      rr.est_tps = e.gen_tokens_per_s; rr.ratio = +(tps / e.gen_tokens_per_s).toFixed(2);
      if (rr.ratio < 0.35 || rr.ratio > 2.2) rr.reasons.push(`${tps} tokens/s is far from the expected ${e.gen_tokens_per_s}`);
      if (e.verdict === "does_not_fit" && rr.all_on_gpu) rr.reasons.push("this model shouldn't fit entirely on that hardware");
    }
    rows.push(rr);
  }
  const status = reasons.some(x => /not known/.test(x)) || rows.some(r => r.reasons.length) ? "flagged" : "community";
  return { status, reasons, rows, m, g };
}
function submitResult(env, ctx, b, source, client) {
  const c = checkSubmission(b || {});
  if (c.status === "rejected") return { error: true, text: "Not recorded: " + c.reasons.join("; ") + ". See get_test_kit for the format.", data: { status: "rejected" }, log: { verdict: "rejected" } };
  const now = new Date().toISOString();
  if (env && env.DB) {
    try {
      for (const r of c.rows) ctx.waitUntil(env.DB.prepare("INSERT INTO submissions (ts, source, client, recipe_version, model_q, model_id, quant, hw_q, gpu_id, cards, memory_gb, context, gen_tps, prompt_tps, all_on_gpu, loaded_gb, runtime, os, est_tps, ratio, status, reasons) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .bind(now, source, String(client || "").slice(0, 60), String(b.recipe_version || "").slice(0, 10), String(b.model).slice(0, 80), c.m ? c.m.id : null, String(b.quant || "").slice(0, 20) || null,
              String(b.hardware).slice(0, 80), c.g ? c.g.id : null, +b.cards || 1, Number.isFinite(+b.memory_gb) ? +b.memory_gb : null, r.context, r.gen_tps, r.prompt_tps, r.all_on_gpu === null ? null : (r.all_on_gpu ? 1 : 0),
              r.loaded_gb, String(b.runtime || "").slice(0, 40), String(b.os || "").slice(0, 20), r.est_tps ?? null, r.ratio ?? null, r.reasons.length || c.status === "flagged" ? "flagged" : "community",
              [...c.reasons, ...r.reasons].join("; ").slice(0, 240) || null).run().catch(() => {}));
    } catch {}
  }
  const what = `${c.m ? c.m.name : b.model} on ${c.g ? c.g.name : b.hardware}`;
  const text = c.status === "community"
    ? `Thank you - recorded as a community result for ${what} (${c.rows.map(r => `${r.gen_tps} tokens/s at ${r.context.toLocaleString("en-US")}`).join(", ")}). It will appear in LocalBit's answers, labelled unverified, after tonight's update.`
    : `Recorded, but flagged for review rather than published: ${[...c.reasons, ...c.rows.flatMap(r => r.reasons)].join("; ")}. If the numbers are right, nothing more is needed - flagged results are checked by hand.`;
  return { text, data: { status: c.status, rows: c.rows.map(({ reasons, ...r }) => ({ ...r, flags: reasons })) }, log: { model_id: c.m && c.m.id, gpu_id: c.g && c.g.id, verdict: "submit_" + c.status } };
}
function getDetails(args) {
  const q = String(args.name || "").trim();
  if (!q) return { error: true, text: "get_details needs a name - a model ('qwen3 32b') or hardware ('rtx 4090'). list_known gives exact names.", data: {}, log: { verdict: "missing_args" } };
  const kind = args.kind || "";
  const m = kind === "hardware" ? null : findModel(q, DATA.models), g = kind === "model" || (m && m.matched === "known") ? null : findGpu(q, DATA.gpus);
  if (m && m.matched === "known") {
    const node = (measuredFile.measured || []).filter(r => r.model === m.id), com = (communityFile.community || []).filter(r => r.model === m.id);
    const lines = [`${m.name}: ${m.params_b}B parameters${m.active_b && m.active_b < m.params_b ? ` (${m.active_b}B active per token - mixture of experts)` : ""}, ${m.layers} layers, ${m.kv_heads} KV heads.`,
      m.max_ctx ? `Context: up to ${m.max_ctx.toLocaleString("en-US")} tokens${m.native_ctx ? ` (${m.native_ctx.toLocaleString("en-US")} without long-context settings)` : ""}.` : "Context: maximum not on record.",
      `Specs: ${m.verified ? "checked against the model's own metadata" : "from its published config, not yet re-checked"}.`,
      node.length ? `Measured on LocalBit's RTX 3090: ${node.map(r => `${r.gen_tps} tokens/s at ${(r.context / 1024)}K`).join(", ")}${node[0].quality_pct != null ? `; quality ${node[0].quality_pct}% right` : ""}.` : "Not measured on LocalBit's node yet.",
      com.length ? `Community results: ${com.map(r => `${r.gpu} ${r.gen_tps} tokens/s (${r.n} run${r.n > 1 ? "s" : ""})`).join(", ")}.` : "No community results yet.",
      asOfText()];
    return { text: lines.join("\n"), data: { kind: "model", model: { id: m.id, name: m.name, params_b: m.params_b, active_b: m.active_b || m.params_b, layers: m.layers, kv_heads: m.kv_heads, head_dim: m.head_dim, max_context: m.max_ctx || null, native_context: m.native_ctx || null, verified: !!m.verified }, node_measurements: node, community: com, data_as_of: AS_OF }, log: { model_id: m.id, verdict: "details" } };
  }
  if (g && g.matched === "known") {
    const node = (measuredFile.measured || []).filter(r => r.gpu === g.id), com = (communityFile.community || []).filter(r => r.gpu === g.id);
    const lines = [`${g.name}${g.cards ? "" : ""}: ${g.vram_gb} GB ${g.vendor === "apple" ? "unified memory (about 75% usable for models)" : "of graphics memory"}, ${g.bandwidth_gbs} GB/s memory bandwidth (sets generation speed).`,
      node.length ? `Measured here by LocalBit's node: ${[...new Set(node.map(r => r.model))].length} models - see ${SITE}/measured.` : "Not LocalBit's test card - answers for it are estimates unless the community has measured it.",
      com.length ? `Community results: ${com.map(r => `${r.model} ${r.gen_tps} tokens/s`).join(", ")}.` : `No community results yet - ${SITE}/test adds the first.`, asOfText()];
    return { text: lines.join("\n"), data: { kind: "hardware", hardware: { id: g.id, name: g.name, vendor: g.vendor, memory_gb: g.vram_gb, bandwidth_gbs: g.bandwidth_gbs, usable_fraction: g.usable_fraction || null }, node_measurements: node, community: com, data_as_of: AS_OF }, log: { gpu_id: g.id, verdict: "details" } };
  }
  const cm = closest(q, DATA.models), cg = closest(q, DATA.gpus);
  return { error: true, text: `LocalBit doesn't know "${q}".${cm.length || cg.length ? " Closest known: " + [...cm, ...cg].slice(0, 4).join(", ") + "." : ""} list_known gives exact names.`, data: { closest: [...cm, ...cg] }, log: { verdict: "unknown" } };
}
const RUN = { check_fit: checkFit, suggest_models: suggest, list_known: listKnown, compare, node_log: nodeLog, get_details: getDetails, get_test_kit: getTestKit };

// ---------- logging (no IPs, nothing personal) ----------
function agentOf(ua) {
  const s = String(ua || "");
  const k = KNOWN_AGENTS.find(a => s.toLowerCase().includes(a.toLowerCase()));
  return k || s.slice(0, 60);
}
function logCall(env, ctx, row) {
  if (!env || !env.DB) return;
  const cut = (v, n = 80) => (v == null ? null : String(v).slice(0, n));
  try {
  const stmt = env.DB.prepare("INSERT INTO calls (ts, kind, client, ua, tool, model_q, hw_q, model_id, gpu_id, verdict, context, quant) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(new Date().toISOString(), cut(row.kind, 20), cut(row.client), cut(row.ua, 60), cut(row.tool, 40), cut(row.model_q), cut(row.hw_q),
          cut(row.model_id, 40), cut(row.gpu_id, 40), cut(row.verdict, 20), row.context || null, cut(row.quant, 12));
  ctx.waitUntil(stmt.run().catch(() => {}));
  } catch {}   // (Nov 25) a logging hiccup never costs an agent its answer
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

// ---------- errors (Nov 25 - a lesson from running a home assistant: log failures where they can be seen; never an IP) ----------
function logError(env, ctx, where, tool, e) {
  if (!env || !env.DB) return;
  try {
    const msg = String((e && (e.stack || e.message)) || e).split("\n").slice(0, 2).join(" | ").slice(0, 240);
    ctx.waitUntil(env.DB.prepare("INSERT INTO errors (ts, path, tool, message) VALUES (?,?,?,?)").bind(new Date().toISOString(), String(where).slice(0, 80), tool ? String(tool).slice(0, 40) : null, msg).run().catch(() => {}));
  } catch {}
}

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
      if ((p.name === "report_issue" || p.name === "submit_result") && await limited(env, request, "REPORTS")) return fail(-32000, "Too many submissions from here - try again in a minute.");
      const fn = p.name === "report_issue" ? (a => saveReport(env, ctx, a, "mcp", ua)) : p.name === "submit_result" ? (a => submitResult(env, ctx, a, "mcp", ua)) : RUN[p.name];
      if (!fn) return fail(-32602, "Unknown tool: " + p.name);
      let out;
      try { out = fn(args); }
      catch (e) { logError(env, ctx, "/mcp", p.name, e); return fail(-32603, "LocalBit hit an internal error answering that - it has been logged. Try again, or rephrase the model or hardware."); }
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
const CSS = `:root{--bg:#fff;--card:#fff;--ink:#1b1c1e;--mute:#62656b;--line:#e3e3df;--accent:#2457d6;--ok:#13795b;--okbg:#e6f4ee;--warn:#9a6200;--warnbg:#fdf1dc;--bad:#b3261e;--badbg:#fbe7e5;--code:#f0f0ec}

*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
header{border-bottom:1px solid var(--line);background:var(--bg)}header .in,main,footer .in{max-width:880px;margin:0 auto;padding:0 20px}
header .in{display:flex;align-items:center;justify-content:space-between;height:58px;gap:16px}
.logo{font-weight:750;font-size:1.15rem;letter-spacing:-.01em;color:var(--ink)}.logo b{color:var(--accent)}
nav a{color:var(--mute);margin-left:18px;font-size:.95rem;white-space:nowrap}@media (max-width:620px){header .in{height:auto;padding-top:10px;padding-bottom:10px;flex-wrap:wrap;gap:4px 12px}nav a{margin:0 12px 0 0;font-size:.88rem}}nav a:hover{color:var(--ink)}
main{padding:34px 20px 20px}h1{font-size:1.9rem;line-height:1.2;letter-spacing:-.02em;margin:0 0 10px}h2{font-size:1.15rem;margin:34px 0 10px}
.lede{color:var(--mute);font-size:1.08rem;max-width:640px;margin:0 0 24px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px 20px;margin:16px 0}
.ask{display:flex;gap:10px;flex-wrap:wrap}.ask input{flex:1 1 200px;font:inherit;padding:11px 13px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--ink)}
button,.btn{font:inherit;font-weight:600;padding:11px 18px;border:0;border-radius:10px;background:var(--accent);color:#fff;cursor:pointer}
.hint{color:var(--mute);font-size:.88rem;margin-top:10px}
.verdict{display:inline-block;font-weight:700;padding:6px 12px;border-radius:999px;font-size:.95rem}
.v-fits{background:var(--okbg);color:var(--ok)}.v-tight{background:var(--warnbg);color:var(--warn)}.v-does_not_fit{background:var(--badbg);color:var(--bad)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:18px 0 6px}
.stat{background:#f6f6f4;border-radius:8px;padding:12px 14px}.stat .k{color:var(--mute);font-size:.82rem}.stat .v{font-size:1.35rem;font-weight:700}.stat .s{color:var(--mute);font-size:.82rem}
.bar{height:10px;border-radius:6px;background:var(--line);overflow:hidden;display:flex;margin:6px 0 4px}.bar i{display:block;height:100%}
.tag{display:inline-block;font-size:.75rem;font-weight:700;letter-spacing:.03em;text-transform:uppercase;padding:2px 8px;border-radius:6px;background:var(--code);color:var(--mute);margin-left:6px;vertical-align:middle}
.tag.m{background:var(--okbg);color:var(--ok)}
ul.tips{margin:8px 0 0;padding-left:20px}ul.tips li{margin:4px 0}
.grid3{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px}.grid3 .card{margin:0}
.grid3 h3{margin:0 0 6px;font-size:1rem}.grid3 p{margin:0;color:var(--mute);font-size:.94rem}
code,pre{font:.88em ui-monospace,SFMono-Regular,Consolas,monospace;background:var(--code);border-radius:6px;padding:.12rem .4rem}pre{padding:12px 14px;overflow:auto;white-space:pre-wrap}
table{border-collapse:collapse;width:100%;font-size:.92rem}th,td{padding:10px 10px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}
th{color:var(--mute);font-weight:600;font-size:.8rem;vertical-align:bottom}td:first-child,th:first-child{text-align:left;white-space:normal}
.scroll{overflow-x:auto}.jump{display:flex;flex-wrap:wrap;gap:6px 14px;margin:0 0 6px;font-size:.92rem}.jump a{margin-left:0;color:var(--mute);border-bottom:1px dotted var(--line)}.jump a:hover{color:var(--ink);text-decoration:none}
.models{border-top:1px solid var(--line)}.model{padding:12px 0 10px;border-bottom:1px solid var(--line);scroll-margin-top:12px}
.model h3{display:inline;margin:0;font-size:1.05rem}.model h3 a{color:var(--ink)}.mmeta{display:inline;color:var(--mute);font-size:.8rem;margin-left:8px}
.mr{display:grid;grid-template-columns:190px 92px minmax(80px,1fr) 210px;align-items:center;column-gap:14px;padding:2px 0;font-size:.88rem}
.mr:first-of-type{margin-top:6px}.mk{display:flex;align-items:center;gap:7px;font-weight:600}.mk .ic{width:13px;height:13px;color:var(--mute);flex:none}
.mk em{font-style:normal;font-weight:400;color:var(--mute);font-size:.7rem;white-space:nowrap}
.mn{font-variant-numeric:tabular-nums;font-size:1rem;font-weight:700;text-align:right;white-space:nowrap}.mn small{font-size:.72rem;font-weight:500;color:var(--mute);margin-left:3px}
.mb{display:block;height:8px;background:#f0f0ee;border-radius:4px;overflow:hidden}.mb i{display:block;height:100%;background:#c9cbd1}
.mb.cy i{background:#f4b326}.mb.ck i{background:#9782eb}.mb.cr i{background:#4dcdb4}.mb.cz i{background:#f79c6e}.mb.cb2 i{background:#66a4e9}
.mr.cy .ic{color:#c98a00}.mr.ck .ic{color:#6a4ce2}.mr.cr .ic{color:#00957a}.mr.cz .ic{color:#d9561a}.mr.cb2 .ic{color:#257de0}
.mx{color:var(--mute);font-size:.78rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

@media (max-width:640px){.mr{grid-template-columns:1fr auto;row-gap:2px}.mb{grid-column:1 / -1}.mx{grid-column:1 / -1;margin-bottom:4px}.mmeta{display:block;margin:0}}.qgrid{display:grid;gap:14px}.qref{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px}.qn{font-weight:650;margin-bottom:6px}
.qrow{display:grid;grid-template-columns:26px 92px 1fr 104px;grid-template-areas:"i l b v" ". . x x";align-items:center;gap:2px 10px;margin:6px 0}
.qrow .ct{grid-area:b;height:14px;background:var(--card);border-radius:7px}.qrow .cb{border-radius:7px}.ql{grid-area:l;font-size:.88rem;font-weight:600}.qrow .cb.qsb{background:#d08a00}.qrow .cb.qmb{background:var(--accent)}.qrow .cb.ql2b{background:#8a63d2}.qrow .cb.qrb{background:#13897a}.qrow .cb.qpb{background:#5c8a2e}.ql2{background:#efe8fb;color:#6b47b8}.qr{background:#e3f4f1;color:#0f7468}.qp{background:#ebf3e2;color:#4a7424}@media (max-width:560px){.qrow{grid-template-columns:26px 1fr 96px;grid-template-areas:"i l v" "b b b" "x x x"}}
.qv{grid-area:v;font-weight:700;font-size:.9rem;text-align:right;white-space:nowrap}.qx{grid-area:x;color:var(--mute);font-size:.8rem}
.qi{grid-area:i;display:inline-flex;width:24px;height:24px;border-radius:7px;align-items:center;justify-content:center;vertical-align:middle}
.qs,.qm{background:none;color:var(--mute)}.ic{width:15px;height:15px}
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
<link rel="icon" href="/logo.svg"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="color-scheme" content="light"><style>:root{color-scheme:light}${CSS}</style></head><body>
<header><div class="in"><a class="logo" href="${origin}/">Local<b>Bit</b></a><nav><a href="${origin}/measured">Latest tested</a><a href="${origin}/log">Node log</a><a href="${origin}/test">Test yours</a><a href="${origin}/compare">Compare</a><a href="${origin}/#agents">For agents</a><a href="${origin}/about">About</a></nav></div></header>
<main>${body}</main>
<footer><div class="in"><span>LocalBit node ${VERSION}</span><span>${esc(asOfText().replace("Data as of: ", "Last reading: "))}</span><a href="${origin}/llms.txt">llms.txt</a><a href="${origin}/docs">Docs</a><a href="${origin}/privacy">Privacy</a><a href="${origin}/about">About &amp; data license</a><a href="${siteFile.repo}">GitHub</a><span>MCP: <code>${origin}/mcp</code></span></div></footer>
</body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
}
function askBox(origin, model = "", hw = "") {
  return `<form class="ask" method="get" action="${origin}/check"><input name="model" placeholder="Model - e.g. Llama 3.1 8B, qwen3:30b" value="${esc(model)}" aria-label="Model">
<input name="hardware" placeholder="Card or Mac - e.g. RTX 4060, M4 Max, 12 GB" value="${esc(hw)}" aria-label="Hardware"><button>Check</button></form>`;
}
function home(origin) {
  const nMeas = new Set((measuredFile.measured || []).map(r => r.model)).size;
  return page("LocalBit - will this AI model run on my hardware?", `<h1>Will this AI model run on my hardware?</h1>
<p class="lede">Memory, speed and a verdict for any local model on your graphics card or Mac. Estimated from published specs. Measured where the node has run it.</p>
<div class="card">${askBox(origin)}<div class="hint">Try: <a href="${origin}/check?model=llama%203.1%208b&hardware=rtx%204060">Llama 3.1 8B on an RTX 4060</a> · <a href="${origin}/check?model=qwen3%2030b&hardware=rtx%204090">Qwen3 30B on an RTX 4090</a> · <a href="${origin}/check?model=llama%203.3%2070b&hardware=rtx%203090">Llama 3.3 70B on an RTX 3090</a></div></div>
<div class="grid3" style="margin-top:22px">
<div class="card"><h3>Live node</h3><p>An RTX 3090 in the field, testing models every night. ${nMeas} logged so far. <a href="${origin}/measured">Latest tested</a>.</p></div>
<div class="card"><h3>Labeled readings</h3><p>Every answer says estimated or measured, and when it was last read.</p></div>
<div class="card"><h3>Open data</h3><p>Readings and tables under CC BY 4.0. Scripts on <a href="${siteFile.repo}">GitHub</a>.</p></div></div>
<h2 id="agents">For AI agents</h2>
<div class="card"><p style="margin-top:0"><b>MCP server</b> (Streamable HTTP, no key): <code>${origin}/mcp</code><br><span class="small">Listed in the MCP Registry as <code>io.github.adamson-gh/localbit</code></span></p>
<p>Tools: <code>check_fit</code> · <code>suggest_models</code> · <code>compare</code> · <code>get_details</code> · <code>node_log</code> · <code>list_known</code> · <code>get_test_kit</code> · <code>submit_result</code> · <code>report_issue</code></p>
<p style="margin-bottom:0"><b>JSON API:</b> <code>GET ${origin}/api/check?model=llama%203.1%208b&amp;hardware=rtx%203090&amp;context=8192</code> · <a href="${origin}/llms.txt">llms.txt</a></p></div>
<h2>What the node logs</h2><p class="small">The tool called, the model and hardware asked about, and the calling app's self-reported name. No IP addresses, accounts or personal data. <a href="${origin}/about">Who runs it, privacy, data license.</a></p>`, origin,
  "Will an AI model run on your GPU or Mac? Memory needed and tokens per second - estimated, and measured on a real RTX 3090.");
}
function resultCard(out) {
  const d = out.data, mg = d.memory_gb || {}, meas = d.measured;
  const vt = { fits: "Fits", tight: "Just barely fits", does_not_fit: "Doesn't fit" }[d.verdict] || d.verdict;
  const tot = Math.max(mg.total || 0, mg.available || 0) || 1, pct = v => Math.max(0, Math.min(100, 100 * (v || 0) / tot)).toFixed(1);
  const speed = meas ? meas.gen_tokens_per_s : d.gen_tokens_per_s;
  return `<div class="card"><span class="verdict v-${esc(d.verdict)}">${esc(vt)}</span> <span class="small">${esc(d.quant)} · ${(+d.context).toLocaleString("en-US")}-token context</span>
<div class="stats"><div class="stat"><div class="k"><span class="qi qm">${ICON.size}</span>Memory needed</div><div class="v">${mg.total} GB</div><div class="s">of ${mg.available} GB available</div></div>
<div class="stat"><div class="k"><span class="qi qs">${ICON.speed}</span>Speed${meas ? '<span class="tag m">measured</span>' : '<span class="tag">estimated</span>'}</div><div class="v">${speed} <span style="font-size:.8rem;font-weight:500">tokens/s</span></div><div class="s">${meas ? esc((meas.runtime || "") + (meas.date ? ", " + meas.date : "")) : (d.partly_on_cpu ? "part runs from system memory" : `likely ${d.gen_tokens_per_s_range[0]}-${d.gen_tokens_per_s_range[1]}`)}</div></div></div>
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
const ICON_PNG_B64 = "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";   // 180x180 logo for phones' home screens
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#2457d6"/><path d="M150 120 V372 H362" fill="none" stroke="#fff" stroke-width="56" stroke-linecap="round" stroke-linejoin="round"/><g fill="#fff"><rect x="226" y="282" width="34" height="58" rx="10" opacity=".55"/><rect x="276" y="236" width="34" height="104" rx="10" opacity=".75"/><rect x="326" y="180" width="34" height="160" rx="10"/></g></svg>`;
// (Nov 25: Glama - "No documentation or privacy policy URL ... ChatGPT's requires a privacy policy") a privacy page and a docs page
function testPage(origin) {
  return page("Measure your own machine - LocalBit", `<h1>Measure your own machine</h1><p class="lede">Three minutes, your hardware, the same method as the node. Share the numbers only if you want to.</p>
<div class="card"><p style="margin-top:0"><b>1.</b> You need Python 3.8+ and <a href="https://ollama.com">Ollama</a> with a model pulled.</p>
<p><b>2.</b> <a href="${origin}/test.py">Download localbit_test.py</a> (one file, nothing to install - <a href="${siteFile.repo}/blob/main/bench/localbit_test.py">read the source</a>).</p>
<p><b>3.</b> Run <code>python localbit_test.py</code> and pick a model. Add <code>--dry-run</code> to measure without sending anything.</p>
<p style="margin-bottom:0"><b>4.</b> It prints exactly what would be shared - the model, your card or Mac name and memory, the speeds, Ollama version and OS - and asks yes or no.</p></div>
<h2>What gets shared, if you say yes</h2><p>Only those numbers. Never names, usernames, file paths, IP addresses or serial numbers. Results are checked against LocalBit's estimate: plausible ones appear in answers as <b>community</b> results, labelled unverified; unusual ones are held for review. They become open data (CC BY 4.0).</p>
<h2>For agents</h2><p><code>get_test_kit</code> returns these steps; <code>submit_result</code> sends a result after the user agrees. Recipe: <a href="${origin}/recipe.json">/recipe.json</a>.</p>`, origin);
}
function privacyPage(origin) {
  return page("Privacy policy - LocalBit", `<h1>Privacy policy</h1><p class="lede">Short version: LocalBit keeps what was asked, never who asked.</p>
<h2>What is recorded</h2><ul><li>For each request: the time, which page or tool, the model and hardware named, the answer's verdict, and the calling app's self-reported name (its user agent or MCP client name).</li>
<li>Reports that an answer was wrong: what was reported, with emails, phone numbers and links removed from the note.</li>
<li>Addresses that don't exist when someone asks for one: the path only.</li>
<li>Internal errors: where they happened and the error message.</li></ul>
<h2>What is not recorded</h2><ul><li>IP addresses, accounts, cookies, device identifiers, or anything that identifies a person.</li>
<li>Cloudflare's rate limiter looks at the caller's address for a moment to stop abuse (120 requests a minute); LocalBit never stores it.</li></ul>
<h2>Use and sharing</h2><p>The records are used only to see what people and agents ask about, find mistakes and improve the answers. They are not sold or shared. Aggregate measurements from LocalBit's own test machine are published as open data (CC BY 4.0); the request log is not.</p>
<h2>Keeping</h2><p>The log is kept to improve the service and backed up privately by the operator. No sign-in exists, so there is no account data to delete.</p>
<h2>Operator and contact</h2><p>LocalBit is run by <a href="${OWNER.url}">${OWNER.name}</a>. Questions: open an issue on <a href="${siteFile.repo}/issues">GitHub</a>.</p>
<p class="small">Hosted on Cloudflare Workers; Cloudflare's own privacy policy covers its network.</p>`, origin);
}
function docsPage(origin) {
  const toolRows = TOOLS.map(x => `<li><code>${esc(x.name)}</code> - ${esc(x.title)}</li>`).join("");
  return page("Documentation - LocalBit", `<h1>Documentation</h1><p class="lede">Connect an agent, or call the JSON API. Free, no key, no sign-in.</p>
<h2>MCP</h2><p>Endpoint (Streamable HTTP): <code>${origin}/mcp</code> - registry name <code>${esc(siteFile.registry_name)}</code>. Discovery file: <a href="${origin}/.well-known/mcp.json">/.well-known/mcp.json</a>.</p><ul>${toolRows}</ul>
<p>Each tool's full description and input schema come back from <code>tools/list</code>; every answer says estimated (with a likely range) or measured, the date the data is current as of, and a <code>source_url</code> to cite.</p>
<h2>JSON API</h2><ul><li><code>GET ${origin}/api/check?model=llama%203.1%208b&amp;hardware=rtx%204060&amp;context=8192&amp;quant=Q4_K_M</code></li>
<li><code>GET ${origin}/api/compare?a_model=...&amp;a_hardware=...&amp;b_model=...</code> (or <code>b_hardware</code>)</li>
<li><code>GET ${origin}/api/suggest?hardware=16%20GB</code> · <code>/api/models</code> · <code>/api/hardware</code> · <code>/api/measured</code> · <code>/api/log</code></li>
<li><code>GET ${origin}/api/details?name=rtx%204090</code> · <code>GET ${origin}/recipe.json</code> · <code>GET ${origin}/test.py</code></li>
<li><code>POST ${origin}/api/submit</code> (a measurement made with the recipe - see <a href="${origin}/test">/test</a>)</li>
<li><code>POST ${origin}/api/report</code> (JSON: problem, model, hardware, observed_tokens_per_s, observed_memory_gb, runtime, note)</li></ul>
<h2>Hardware</h2><p>Card names ("RTX 4060"), several cards ("2x RTX 3090"), Macs by chip ("M2 Pro 32 GB"), or just memory ("12 GB card").</p>
<h2>Limits</h2><p>120 requests a minute per address; 5 reports a minute.</p>
<h2>More</h2><p><a href="${origin}/llms.txt">llms.txt</a> · <a href="${origin}/measured">measurements</a> · <a href="${origin}/privacy">privacy</a> · <a href="${siteFile.repo}">source</a> · <a href="${siteFile.repo}/blob/main/CHANGELOG.md">changelog</a></p>`, origin);
}
function about(origin) {
  return page("About LocalBit - who runs it, privacy, data license", `<h1>About LocalBit</h1>
<p class="lede">One question, answered well: will this AI model run on this hardware?</p>
<h2>Operator</h2><p>LocalBit is an independent project by <a href="${OWNER.url}">${OWNER.name}</a> on GitHub. It isn't connected with NVIDIA, AMD, Intel, Apple, Ollama or any model maker.</p>
<h2>How far to trust a reading</h2><p>Most answers are <b>estimates</b> from each model's design and each card's published specs. Speeds marked <b>measured</b> come from LocalBit's own RTX 3090 test machine (Windows, Ollama), re-run regularly. Laptop versions of cards are slower than desktop ones, and two-card or CPU-only setups aren't modeled yet. Check before you buy hardware on the strength of an estimate. Every answer says how current its data is.</p>
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
// (Nov 25, owner: "I can't tell if one is better than the other") the measured page leads with two plain charts and a how-to-read
const ICON = {
  speed: `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" fill="currentColor"/></svg>`,
  size: `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
};
// (Nov 25, owner: "put each model's results together ... other metrics we found important") one card per measured model with
// everything about it: speed, staying fast in long chats, reading a document, size on the card, energy - each with its icon
ICON.read = `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2h9l5 5v15H6z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M9 12h8M9 16h8M9 8h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
ICON.quality = `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
ICON.long = `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v10H9l-5 4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M8 10h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
ICON.power = `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
function charts(ids, byModel, name, origin) {
  // (Nov 25, owner: "too AI generated ... the energy bar isn't consistent") every bar is the number printed beside it, scaled to the
  // largest of the models shown (Size: to the card's 24 GB). One ink, thin bars, plain labels; "lower is better" said where it is.
  const pick = id => byModel[id].find(x => x.context === 16384) || byModel[id][0];
  const at = (id, ctx) => (byModel[id].find(x => x.context === ctx) || {}).gen_tps;
  const vals = ids.map(id => { const r = pick(id), s4 = at(id, 4096), s32 = at(id, 32768);
    return { id, r, speed: +r.gen_tps, keep: s4 && s32 ? Math.min(100, Math.round(100 * s32 / s4)) : null, s4, s32,
             read: r.prompt_tps_4k ? 4000 / r.prompt_tps_4k : null, size: +r.gpu_mem_peak_gib || 0,
             wh: r.power_w && r.gen_tps ? r.power_w * 400 / r.gen_tps / 3600 : null, q: r.quality_pct != null ? r.quality_pct : null, qc: r.quality_by_cat }; });
  const mx = k => Math.max(...vals.map(v => v[k] || 0), 1e-9);
  // (Nov 25, owner: "speed = yellow, energy = orange, very light ... more compact") one line per measure; the sentence is the tooltip
  const bar = (v, of, c = "") => `<span class="mb ${c}"><i style="width:${Math.max(1.5, Math.min(100, 100 * v / of)).toFixed(1)}%"></i></span>`;
  const row = (icon, label, dir, num, unit, b, note, c = "") => `<div class="mr ${c}" title="${esc(note)}"><div class="mk">${icon}<span>${label}</span>${dir ? `<em>${dir}</em>` : ""}</div>
<div class="mn">${num}<small>${unit}</small></div>${b}<div class="mx">${note}</div></div>`;
  const sec = v => v < 10 ? v.toFixed(1) : String(Math.round(v));
  const cards = vals.map(v => { const m = DATA.models.find(x => x.id === v.id) || {};
    const size = m.params_b ? `${m.params_b}B parameters` + (m.active_b && m.active_b < m.params_b ? `, ${m.active_b}B active` : "") : "";
    return `<section class="model" id="${esc(v.id)}"><h3><a href="${origin}/run/${esc(v.id)}/on/rtx-3090">${esc(name(v.id))}</a></h3><div class="mmeta">${esc(size)} · ${esc(v.r.quant || "")} · ${esc(v.r.ollama_tag || "")} · ${esc(v.r.date || "")}</div>
${row(ICON.speed, "Speed", "", v.speed.toFixed(0), "tokens/s", bar(v.speed, mx("speed"), "cy"), `300 words in about ${Math.max(1, Math.round(400 / v.speed))} s`, "cy")}
${v.q != null ? row(ICON.quality, "Quality", "", v.q, "% right", bar(v.q, 100, "ck"), ["math", "instructions", "facts", "code"].map(c => `${c} ${(v.qc || {})[c] || 0}/15`).join(" · "), "ck") : row(ICON.quality, "Quality", "", "-", "", `<span class="mb"></span>`, "first check runs tonight", "ck")}
${v.read != null ? row(ICON.read, "Reading", "lower is better", sec(v.read), "seconds", bar(v.read, mx("read"), "cr"), `wait for a 3,000-word document`, "cr") : ""}
${row(ICON.size, "Size", "lower is better", v.size.toFixed(1), "of 24 GB", bar(v.size, 24, "cz"), `${(24 - v.size).toFixed(1)} GB free`, "cz")}
${v.wh != null ? row(ICON.power, "Energy", "lower is better", v.wh.toFixed(2), "Wh", bar(v.wh, mx("wh"), "cb2"), `per 300-word answer · ${Math.round(v.r.power_w)} W`, "cb2") : ""}
</section>`; }).join("");
  const nav = `<nav class="jump" aria-label="Models measured">${vals.map(v => `<a href="#${esc(v.id)}">${esc(name(v.id))}</a>`).join("")}</nav>`;
  return `${nav}<div class="models">${cards}</div>
<h2>Readings</h2>
<dl class="defs"><dt>Speed</dt><dd>Words per second once it starts writing, in tokens. People read about 8; anything well above keeps ahead of you.</dd>
<dt>Quality</dt><dd>Share of 60 questions answered right - 15 each of multi-step math, stacked format rules, less common facts and tricky code reading. Written for LocalBit, graded by a script, no AI judge. Thinking off. Version 2 (version 1 was too easy to tell models apart). A quick check, not a full benchmark.</dd>
<dt>Reading</dt><dd>Wait before the first word when handed a 4,000-token (about 3,000-word) document. A model reads everything it is given before answering.</dd>
<dt>Size</dt><dd>Card memory in use while running, including about 0.5-1 GB for the desktop.</dd>
<dt>Energy</dt><dd>Electricity to write a 300-word answer. Each bar is the number beside it, against the other models here; Size is against the full card.</dd></dl>
<h2>Choosing</h2>
<p>Quality against speed. Bigger models score higher and run slower. Pick the highest Quality that is still fast enough for you; for long documents, check Reading.</p>`;
}
function comparePage(sp, origin) {
  const out = compare(sp);
  const box = `<form class="ask" method="get" action="${origin}/compare"><input name="a_model" placeholder="Model" value="${esc(sp.a_model || "")}"><input name="a_hardware" placeholder="Card" value="${esc(sp.a_hardware || "")}">
<span class="small" style="align-self:center;flex-basis:100%">versus</span><input name="b_model" placeholder="Other model (or leave)" value="${esc(sp.b_model || "")}"><input name="b_hardware" placeholder="Other card (or leave)" value="${esc(sp.b_hardware || "")}"><button>Compare</button></form>`;
  if (out.error) return page("Compare - LocalBit", `<h1>Compare</h1><p class="lede">Two models on one card, or one model on two cards.</p><div class="card">${box}${sp.a_model ? `<p class="small">${esc(out.text)}</p>` : ""}</div>`, origin);
  const lines = out.text.split("\n");
  return page(`${lines[0].replace(/:$/, "")} - LocalBit`, `<h1>${esc(lines[0].replace(/ \(.*$/, ""))}</h1><p class="small">${esc((lines[0].match(/\((.*)\)/) || [])[1] || "")}</p>
<div class="card"><ul class="tips" style="margin:0">${lines.slice(1, -1).map(l => `<li>${esc(l.replace(/^- /, ""))}</li>`).join("")}</ul></div>
<div class="card">${box}</div>`, origin);
}
function logPage(origin) {
  const e = nodeEntries(50);
  return page("Node log - LocalBit", `<h1>Node log</h1><p class="lede" style="margin-bottom:6px">Readings from the field, newest first.</p>
<p class="small" style="margin:0 0 18px">RTX 3090 node · runs nightly · <a href="${origin}/log.rss">RSS</a> · agents: <code>node_log</code></p>
${e.length ? `<div class="models">${e.map(x => `<section class="model"><h3><a href="${origin}/measured#${esc(x.model_id)}">${esc(x.model)}</a></h3><span class="mmeta">${esc(x.date)}</span>
<div class="small" style="margin-top:4px">${x.gen_tps} tokens/s${x.quality_pct != null ? ` · ${x.quality_pct}% quality` : ""} · ${x.memory_gb} GB · ${x.read_4k_s ?? "-"} seconds to read 3,000 words · ${x.wh_per_answer ?? "-"} Wh per answer</div></section>`).join("")}</div>` : "<p>No readings yet.</p>"}`, origin);
}
function logRss(origin) {
  const e = nodeEntries(30);
  const items = e.map(x => `<item><title>${esc(x.model)} on an RTX 3090: ${x.gen_tps} tokens/s${x.quality_pct != null ? `, ${x.quality_pct}% quality` : ""}</title><link>${esc(origin)}/measured#${esc(x.model_id)}</link><guid isPermaLink="false">${esc(x.model_id)}-${esc(x.date)}</guid><pubDate>${new Date(x.date + "T06:00:00Z").toUTCString()}</pubDate><description>${esc(`${x.memory_gb} GB on the card; ${x.read_4k_s ?? "-"} s to read 3,000 words; ${x.wh_per_answer ?? "-"} Wh per answer.`)}</description></item>`).join("");
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>LocalBit node log</title><link>${esc(origin)}/log</link><description>New readings from LocalBit's RTX 3090 test node.</description>${items}</channel></rss>`,
    { headers: { "content-type": "application/rss+xml; charset=utf-8" } });
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
      `<td>${f(mid.quality_pct)}</td><td>${f(at(rs, 16384, "prompt_tps_4k"))}</td><td>${f(mid.gpu_mem_peak_gib, 1)}</td><td>${f(mid.power_w)}</td><td>${f(mid.tokens_per_joule, 2)}</td><td>${esc(mid.date || "")}</td></tr>`; }).join("");
  const any = rows[0] || {};
  const last = rows.map(r => r.date || "").sort().pop() || "";
  return page("Latest Models Tested - LocalBit", `<h1>Latest Models Tested</h1>
<p class="lede" style="margin-bottom:6px">A live in-field node.</p>
<p class="small" style="margin:0 0 20px">RTX 3090 · 24 GB · ${esc(any.runtime || "Ollama")} · ${ids.length} model${ids.length === 1 ? "" : "s"} logged · last run ${esc(last)} · runs nightly</p>
${ids.length ? charts(ids, byModel, name, origin) : ""}
${ids.length ? `<details class="card"><summary>All the numbers as a table</summary><div class="scroll"><table class="meas">
<thead><tr><th rowspan="2">Model</th><th colspan="3" style="text-align:center">Tokens/s by context</th><th rowspan="2">Quality<br>% right</th><th rowspan="2">Prompt<br>tokens/s</th><th rowspan="2">Memory<br>GB</th><th rowspan="2">Power<br>W</th><th rowspan="2">Tokens<br>per joule</th><th rowspan="2">Date</th></tr><tr><th>4K</th><th>16K</th><th>32K</th></tr></thead>
<tbody>${body}</tbody></table><div class="meas-note">Prompt = reading a 4,000-token prompt at 16K context. Memory = the whole card's peak at 16K. Power = the card's average while generating.</div></div></details>` : "<p>No results yet.</p>"}
<h2>Method</h2><p>Each model alone on the card, the middle of 3 runs at each context length, temperature 0, the same made-up prompts for every model. NVIDIA GeForce RTX 3090 24 GB, Windows, ${esc(any.runtime || "Ollama")}${any.driver ? ", driver " + esc(String(any.driver).split(",")[0]) : ""}. "Card memory used" is the whole card's peak, including about 0.5-1 GB for the desktop. Power is the card's average draw while generating.</p>
<h2>Data</h2><p>JSON: <a href="${origin}/api/measured">${origin}/api/measured</a> · every raw run and the scripts: <a href="${siteFile.repo}">github.com/adamson-gh/localbit</a> · license <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a> - credit LocalBit. See something different on your 3090? Use the form on a result page.</p>`, origin);
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
    `## For agents\n- MCP (Streamable HTTP): ${origin}/mcp - tools: check_fit(model, hardware, context?, quant?, kv_cache?), suggest_models(hardware, context?, min_tokens_per_s?), compare(a_model, a_hardware, b_model?, b_hardware?, context?), node_log(limit?), get_details(name, kind?), get_test_kit(), submit_result(model, hardware, results, ...), list_known(kind), report_issue(problem, model?, hardware?, observed_tokens_per_s?, observed_memory_gb?, runtime?, note?)\n` +
    `- JSON API: ${origin}/api/check?model=...&hardware=...&context=...&quant=... ; ${origin}/api/suggest?hardware=... ; ${origin}/api/models ; ${origin}/api/hardware ; ${origin}/api/measured ; ${origin}/api/compare?a_model=...&a_hardware=...&b_model=... ; ${origin}/api/log ; ${origin}/log.rss ; POST ${origin}/api/report (JSON)\n\n` +
    `## Contribute\n- No measurement for your hardware? ${origin}/test - a 3-minute script (${origin}/test.py, recipe ${origin}/recipe.json) measures a model in your own Ollama, shows what it would send and asks first. Agents: get_test_kit, then submit_result after the user agrees. Community results are labeled "community" (unverified).\n\n` +
    `## Notes\n- Speeds are labeled "estimated" or "measured"; every answer ends with the date the data is current as of (data_as_of in JSON).\n- ${asOfText()}\n- Measured results (RTX 3090): ${origin}/measured (table) and ${origin}/api/measured (JSON)\n- LocalBit records the tool, model and hardware asked about and the client's self-reported name - no IP addresses or personal data.\n- Open data: measurements and tables are CC BY 4.0 (credit LocalBit). Limits: 120 requests/minute per address. Run by ${OWNER.name} (${OWNER.url}). Details: ${origin}/about\n`;
}
function sitemap(origin) {
  const urls = [origin + "/", origin + "/measured", origin + "/log", origin + "/compare", origin + "/test", origin + "/docs", origin + "/privacy", origin + "/about"];
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
  // (Nov 25, owner: "yes add that") estimate vs measured for every measured model: drift over 10% means the formula needs a look
  const drift = (measuredFile.measured || []).map(r => { const m = DATA.models.find(x => x.id === r.model), g = DATA.gpus.find(x => x.id === r.gpu);
    if (!m || !g || !r.gen_tps) return null; const e = estimate(m, g, { context: r.context, quant: r.quant }, DATA.quants);
    return { model: r.model, gpu: r.gpu, context: r.context, measured: r.gen_tps, estimated: e.gen_tokens_per_s, off_pct: Math.round(100 * (e.gen_tokens_per_s - r.gen_tps) / r.gen_tps) }; }).filter(Boolean);
  return json({ days, estimate_drift: drift,
    by_day: await q("SELECT substr(ts,1,10) day, count(*) n FROM calls WHERE ts >= ? GROUP BY day ORDER BY day"),
    by_kind: await q("SELECT kind, count(*) n FROM calls WHERE ts >= ? GROUP BY kind ORDER BY n DESC"),
    by_agent: await q(`SELECT coalesce(nullif(client,''), ua) agent, count(*) n FROM calls WHERE ts >= ? AND ${NOT_CRAWL} GROUP BY agent ORDER BY n DESC LIMIT 25`),
    self_tests: (await q(`SELECT count(*) n FROM calls WHERE ts >= ? AND ua LIKE '%${SELF_UA}%'`).catch(() => [{ n: 0 }]))[0]?.n || 0,
    crawlers: await q(`SELECT ua crawler, count(*) n FROM calls WHERE ts >= ? AND ${IS_CRAWL} GROUP BY ua ORDER BY n DESC LIMIT 15`),
    crawl_total: (await q(`SELECT count(*) n FROM calls WHERE ts >= ? AND ${IS_CRAWL}`))[0]?.n || 0,
    by_tool: await q("SELECT tool, count(*) n FROM calls WHERE ts >= ? AND tool IS NOT NULL GROUP BY tool ORDER BY n DESC"),
    top_models: await q(`SELECT coalesce(model_id, model_q) model, count(*) n FROM calls WHERE ts >= ? AND ${NOT_CRAWL} AND (model_id IS NOT NULL OR model_q IS NOT NULL) GROUP BY model ORDER BY n DESC LIMIT 25`),
    top_hardware: await q(`SELECT coalesce(gpu_id, hw_q) hardware, count(*) n FROM calls WHERE ts >= ? AND ${NOT_CRAWL} AND (gpu_id IS NOT NULL OR hw_q IS NOT NULL) GROUP BY hardware ORDER BY n DESC LIMIT 25`),
    errors_total: (await q("SELECT count(*) n FROM errors WHERE ts >= ?").catch(() => [{ n: null }]))[0]?.n,
    recent_errors: await q("SELECT ts, path, tool, message FROM errors WHERE ts >= ? ORDER BY ts DESC LIMIT 15").catch(() => []),
    limited_total: (await q("SELECT count(*) n FROM calls WHERE ts >= ? AND kind = 'limited'"))[0]?.n || 0,
    misses_total: (await q("SELECT count(*) n FROM misses WHERE ts >= ?").catch(() => [{ n: 0 }]))[0]?.n || 0,
    top_misses: await q(`SELECT path, count(*) n, ${SCANNER_SQL} scanner FROM misses WHERE ts >= ? GROUP BY path ORDER BY n DESC LIMIT 20`).catch(() => []),
    submissions: await q("SELECT status, count(*) n FROM submissions WHERE ts >= ? GROUP BY status").catch(() => []),
    recent_submissions: await q("SELECT ts, model_id, model_q, gpu_id, hw_q, context, gen_tps, est_tps, status, reasons FROM submissions WHERE ts >= ? ORDER BY ts DESC LIMIT 15").catch(() => []),
    // (Nov 26) which formats agents use or look for - the map of what's catching on
    formats: await q(`SELECT CASE WHEN kind LIKE 'mcp_%' AND kind != 'mcp_json' THEN 'MCP (tools)' WHEN kind = 'api' OR kind = 'submit' THEN 'JSON API' WHEN kind = 'llms_txt' THEN 'llms.txt'
      WHEN kind = 'mcp_json' THEN 'mcp.json discovery file' WHEN kind = 'log_rss' THEN 'RSS feed' WHEN kind IN ('recipe', 'test_script') THEN 'test recipe / script'
      WHEN kind = 'limited' THEN 'turned away' ELSE 'web pages' END format, count(*) n FROM calls WHERE ts >= ? AND ${NOT_CRAWL} GROUP BY format ORDER BY n DESC`).catch(() => []),
    format_misses: await q(`SELECT CASE WHEN path LIKE '%agent-card.json' OR path LIKE '%agent.json' THEN 'A2A agent card' WHEN path LIKE '%oauth%' OR path LIKE '%openid%' THEN 'sign-in discovery (OAuth)'
      WHEN path LIKE '%openapi%' OR path LIKE '%swagger%' THEN 'OpenAPI' WHEN path LIKE '%/sse%' THEN 'old MCP (SSE)' WHEN path LIKE '%ai-plugin%' THEN 'ChatGPT plugin manifest'
      WHEN path LIKE '/.well-known/%' THEN 'other well-known file' ELSE NULL END format, count(*) n FROM misses WHERE ts >= ? GROUP BY format HAVING format IS NOT NULL ORDER BY n DESC`).catch(() => []),
    reports_by_problem: await q("SELECT problem, count(*) n FROM reports WHERE ts >= ? GROUP BY problem ORDER BY n DESC").catch(() => []),
    recent_reports: await q("SELECT ts, source, client, model_q, hw_q, model_id, gpu_id, problem, obs_tps, obs_mem_gb, context, runtime, note FROM reports WHERE ts >= ? ORDER BY ts DESC LIMIT 25").catch(() => []),
    unknown_asks: await q("SELECT model_q, hw_q, count(*) n FROM calls WHERE ts >= ? AND (verdict = 'unknown' OR model_id LIKE 'generic%' OR gpu_id LIKE 'generic%') GROUP BY model_q, hw_q ORDER BY n DESC LIMIT 25"),
  });
}

export default {
  async fetch(request, env, ctx) {
    try { return await handle(request, env, ctx); }
    catch (e) {
      let where = "?"; try { where = new URL(request.url).pathname; } catch {}
      logError(env, ctx, where, null, e);
      return json({ error: "LocalBit hit an internal error - it has been logged." }, 500);
    }
  },
};
async function handle(request, env, ctx) {
    const url = new URL(request.url), origin = url.origin, path = url.pathname.replace(/\/+$/, "") || "/";
    const ua = agentOf(request.headers.get("user-agent"));
    if (path !== "/stats" && request.method !== "OPTIONS" && await limited(env, request)) { logCall(env, ctx, { kind: "limited", ua }); return tooMany(); }
    if (path === "/mcp") return mcp(request, env, ctx);
    if (path === "/stats") return stats(request, env);
    if (request.method === "OPTIONS") return new Response(null, { headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type, mcp-protocol-version" } });
    if (path === "/api/submit" && request.method === "POST") {
      if (await limited(env, request, "REPORTS")) { logCall(env, ctx, { kind: "limited", ua, tool: "submit_result" }); return tooMany(); }
      const raw = await request.text();
      if (raw.length > 16384) return json({ error: "too large" }, 413);
      let b; try { b = JSON.parse(raw); } catch { return json({ error: "send JSON" }, 400); }
      const o = submitResult(env, ctx, b, "api", (b && b.client) || ua);
      logCall(env, ctx, { kind: "submit", ua, tool: "submit_result", model_q: b && b.model, hw_q: b && b.hardware, ...o.log });
      return json({ answer: o.text, ...o.data }, o.error ? 400 : 200);
    }
    if (path === "/api/report" && request.method === "POST") {
      if (await limited(env, request, "REPORTS")) { logCall(env, ctx, { kind: "limited", ua, tool: "report_issue" }); return tooMany(); }
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
    // (Nov 26) a fresh agent guessed /api/list_known from the tool's name - answer it like list_known
    if (path === "/api/list_known") { const o = RUN.list_known({ kind: sp.kind || "hardware", ...sp }); logCall(env, ctx, { kind: "api", ua, tool: "list_known", ...(o.log || {}) }); return json({ answer: o.text, ...o.data }, o.error ? 400 : 200); }
    if (path === "/api/models") return json({ models: DATA.models.map(({ id, name, params_b, active_b, verified }) => ({ id, name, params_b, active_b, verified })) });
    if (path === "/api/hardware") return json({ hardware: DATA.gpus.map(({ id, name, vram_gb, bandwidth_gbs }) => ({ id, name, vram_gb, bandwidth_gbs })) });
    if (path === "/api/measured") return json({ license: "CC BY 4.0 - credit LocalBit", data_as_of: AS_OF, measured: DATA.measured });
    if (path === "/check") { const o = checkFit(sp); logCall(env, ctx, { kind: "check_page", ua, tool: "check_fit", model_q: sp.model, hw_q: sp.hardware, ...o.log }); return checkPage(sp, origin); }
    if (path === "/compare") { const o = compare(sp); logCall(env, ctx, { kind: "compare_page", ua, tool: "compare", model_q: sp.a_model, hw_q: sp.a_hardware, ...o.log }); return comparePage(sp, origin); }
    if (path === "/api/compare") { const o = compare(sp); logCall(env, ctx, { kind: "api", ua, tool: "compare", model_q: sp.a_model, hw_q: sp.a_hardware, ...o.log }); return json({ answer: o.text, ...o.data }, o.error ? 404 : 200); }
    if (path === "/log") { logCall(env, ctx, { kind: "log", ua }); return logPage(origin); }
    if (path === "/log.rss") { logCall(env, ctx, { kind: "log_rss", ua }); return logRss(origin); }
    if (path === "/api/log") { const o = nodeLog(sp); return json({ answer: o.text, ...o.data }); }
    if (path === "/measured") { logCall(env, ctx, { kind: "measured", ua }); return measuredPage(origin); }
    // (Nov 26 check: browsers asked for /favicon.ico and /apple-touch-icon.png and got "not found")
    if (path === "/favicon.ico") return new Response(LOGO_SVG, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" } });
    if (path === "/apple-touch-icon.png" || path === "/apple-touch-icon-precomposed.png" || path === "/logo.png")
      return new Response(Uint8Array.from(atob(ICON_PNG_B64), c => c.charCodeAt(0)), { headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" } });
    if (path === "/recipe.json") { logCall(env, ctx, { kind: "recipe", ua }); return json(recipeFile); }
    if (path === "/test.py") { logCall(env, ctx, { kind: "test_script", ua }); return new Response(TEST_SCRIPT, { headers: { "content-type": "text/x-python; charset=utf-8", "content-disposition": 'attachment; filename="localbit_test.py"' } }); }
    if (path === "/test") { logCall(env, ctx, { kind: "test_page", ua }); return testPage(origin); }
    if (path === "/api/details") { const o = getDetails(sp); logCall(env, ctx, { kind: "api", ua, tool: "get_details", model_q: sp.name, ...o.log }); return json({ answer: o.text, ...o.data }, o.error ? 404 : 200); }
    if (path === "/logo.svg") return new Response(LOGO_SVG, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" } });
    if (path === "/privacy") { logCall(env, ctx, { kind: "privacy", ua }); return privacyPage(origin); }
    if (path === "/docs") { logCall(env, ctx, { kind: "docs", ua }); return docsPage(origin); }
    if (path === "/about") { logCall(env, ctx, { kind: "about", ua }); return about(origin); }
    // (Nov 25) standard discovery files: Glama's ownership claim, and the proposed MCP server description
    // (Nov 25) Glama's claim: a token bound to the owner's Glama account - no email, nothing personal. Served for the endpoint
    // (/mcp/.well-known/glama.json) and the domain (/.well-known/glama.json); keep it published to stay verified.
    if (path === "/.well-known/glama.json" || path === "/mcp/.well-known/glama.json") return json({ "$schema": "https://glama.ai/mcp/schemas/connector.json", claim: siteFile.glama_claim });
    if (path === "/.well-known/mcp.json") { logCall(env, ctx, { kind: "mcp_json", ua }); } if (path === "/.well-known/mcp.json") return json({ name: "LocalBit", description: "Will this AI model run on this hardware? Memory needed and estimated or measured speed for local models on graphics cards and Macs.",
      version: VERSION, endpoint: SITE + "/mcp", transport: "streamable-http", protocol_versions: PROTOCOLS, authentication: "none",
      tools: TOOLS.map(x => x.name), registry: siteFile.registry_name, documentation: SITE + "/docs", privacy_policy: SITE + "/privacy", icon: SITE + "/logo.svg", website: SITE, repository: siteFile.repo });
    if (path === "/llms.txt") { logCall(env, ctx, { kind: "llms_txt", ua }); return new Response(llmsTxt(origin), { headers: { "content-type": "text/plain; charset=utf-8" } }); }
    if (path === "/sitemap.xml") return sitemap(origin);
    if (path === "/robots.txt") return new Response(`User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`, { headers: { "content-type": "text/plain" } });
    const pm = path.match(/^\/run\/([a-z0-9.\-]+)\/on\/([a-z0-9.\-]+)$/);
    if (pm) { const r = pairPage(pm[1], pm[2], origin); if (r) { logCall(env, ctx, { kind: "page", ua, model_id: pm[1], gpu_id: pm[2] }); return r; } }
    if (path === "/") { logCall(env, ctx, { kind: "home", ua }); return home(origin); }
    // (Nov 25, owner: "yes") addresses asked for that don't exist - agents guessing standard paths, plus scanner noise. Path only.
    if (env && env.DB) { try { ctx.waitUntil(env.DB.prepare("INSERT INTO misses (ts, path, ua) VALUES (?,?,?)").bind(new Date().toISOString(), path.slice(0, 100), String(ua || "").slice(0, 60)).run().catch(() => {})); } catch {} }
    return new Response("Not found", { status: 404 });
}

