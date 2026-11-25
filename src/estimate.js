// LocalBit - will this AI model run on this hardware? Pure functions, no I/O.
// Memory = weights at the chosen quantization + the attention cache for the context + a little runtime overhead.
// Speed  = generating a token reads every active weight once, so it's bound by memory bandwidth:
//          tokens/s ~= efficiency x bandwidth / bytes read per token. Efficiency is calibrated on measured runs
//          (RTX 3090, Qwen3.8 27B Q4_K_M, Ollama: 47.7 tok/s measured vs 56.5 theoretical -> ~0.84).

const GiB = 2 ** 30;
const EFF = { nvidia: 0.82, amd: 0.7, apple: 0.7, intel: 0.6 };
const MOE_EFF = 0.5;             // expert routing and smaller kernels cost much of the bandwidth win - a rough guess until measured results replace it
const CPU_BW_GBS = 60;           // a typical desktop's system memory, for the part that doesn't fit on the card
const RESERVE_GIB = 0.6;         // what the desktop, browser and drivers usually keep on a discrete card

export function norm(s) {
  return String(s || "").toLowerCase().replace(/[’']/g, "").replace(/\b(nvidia|geforce|amd|radeon|intel|apple|graphics|card|gpu|my|an?|the)\b/g, " ")
    .replace(/[_]/g, " ").replace(/\s+/g, " ").trim();
}
const squash = s => norm(s).replace(/[\s.\-:]/g, "");

function bestMatch(q, rows) {
  const nq = norm(q), sq = squash(q);
  if (!sq) return null;
  let best = null, bestLen = 0;
  for (const r of rows) {
    for (const a of [r.id, r.name, ...(r.aliases || [])]) {
      const sa = squash(a);
      if (!sa) continue;
      if (sa === sq) return r;                                   // exact
      // whole-alias containment, longest wins ("rtx 4060 ti 16gb" beats "4060 ti" beats "4060")
      const re = new RegExp("(^|[^a-z0-9])" + norm(a).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "[\\s.\\-:]*") + "($|[^a-z0-9])");
      if (re.test(nq) && sa.length > bestLen) { best = r; bestLen = sa.length; }
    }
  }
  return best;
}

export function findGpu(q, gpus) {
  const g = bestMatch(q, gpus);
  if (g) return { ...g, matched: "known" };
  const m = norm(q).match(/(\d+(?:\.\d+)?)\s*gb/);
  if (m) {   // "a 12 GB card" - memory known, bandwidth not: assume a mid-range card
    return { id: "generic-" + m[1] + "gb", name: m[1] + " GB graphics card (model not given)", vendor: "nvidia", vram_gb: +m[1], bandwidth_gbs: 450, matched: "generic" };
  }
  return null;
}

export function findModel(q, models) {
  const mdl = bestMatch(q, models);
  if (mdl) return { ...mdl, matched: "known" };
  const m = norm(q).match(/(\d+(?:\.\d+)?)\s*b\b/);
  if (m) {   // "some 13B model" - size known, design not: a typical dense model of that size
    const p = +m[1];
    return { id: "generic-" + m[1] + "b", name: m[1] + "B model (design not known to LocalBit)", params_b: p, generic_kv_bytes_per_token_f16: Math.round(40000 * Math.sqrt(p)), matched: "generic" };
  }
  return null;
}

export function quantBits(q, model, quants) {
  const s = String(q || "").toUpperCase().replace(/\s+/g, "");
  if (quants[s]) return [s, quants[s]];
  const alias = { Q4: "Q4_K_M", "4BIT": "Q4_K_M", "INT4": "Q4_K_M", Q5: "Q5_K_M", Q6: "Q6_K", Q8: "Q8_0", "8BIT": "Q8_0", INT8: "Q8_0", Q3: "Q3_K_M", Q2: "Q2_K", FP16: "F16", "16BIT": "F16" }[s];
  if (alias) return [alias, quants[alias]];
  const d = (model && model.default_quant) || "Q4_K_M";
  return [d, quants[d]];
}

export function kvBytes(model, ctx, kvBytesPerElem = 2) {
  if (model.generic_kv_bytes_per_token_f16) return model.generic_kv_bytes_per_token_f16 * ctx * (kvBytesPerElem / 2);
  const swa = model.swa_layers || 0;
  const full = model.kv_layers != null ? model.kv_layers : model.layers - swa;
  const perTok = (layers, dim) => layers * model.kv_heads * dim * 2 * kvBytesPerElem;   // K and V
  return perTok(full, model.head_dim) * ctx + perTok(swa, model.head_dim_swa || model.head_dim) * Math.min(ctx, model.swa_window || ctx);
}

export function estimate(model, gpu, opts = {}, quants = {}) {
  const ctx = Math.max(512, Math.min(+opts.context || 8192, 1048576));
  const [quant, bits] = quantBits(opts.quant, model, quants);
  const kvElem = /q8/i.test(opts.kv_cache || "") ? 1 : /q4/i.test(opts.kv_cache || "") ? 0.5 : 2;
  const weights = model.params_b * 1e9 * bits / 8;
  const kv = kvBytes(model, ctx, kvElem);
  const overhead = 0.3 * GiB + 0.01 * weights;
  const total = weights + kv + overhead;
  const usable = gpu.vram_gb * GiB * (gpu.usable_fraction || 1) - (gpu.vendor === "apple" ? 0 : RESERVE_GIB * GiB);
  const verdict = total <= usable * 0.95 ? "fits" : total <= usable ? "tight" : "does_not_fit";
  const active = (model.active_b || model.params_b) * 1e9 * bits / 8;
  const perToken = active + kv * 0.5;                          // the cache is read too - about half full on average
  const eff = (EFF[gpu.vendor] || 0.65) * (model.active_b ? MOE_EFF : 1);
  let tps;
  if (verdict !== "does_not_fit") tps = eff * gpu.bandwidth_gbs * 1e9 / perToken;
  else {                                                        // the rest runs from system memory - much slower
    const f = Math.max(0, usable / total);
    tps = 1 / ((f * perToken) / (eff * gpu.bandwidth_gbs * 1e9) + ((1 - f) * perToken) / (0.7 * CPU_BW_GBS * 1e9));
  }
  const r1 = x => Math.round(x * 10) / 10;
  return {
    model: model.name, model_id: model.id, model_match: model.matched, hardware: gpu.name, hardware_id: gpu.id, hardware_match: gpu.matched,
    quant, context: ctx, verdict,
    memory_gb: { weights: r1(weights / GiB), context_cache: r1(kv / GiB), overhead: r1(overhead / GiB), total: r1(total / GiB), available: r1(usable / GiB) },
    gen_tokens_per_s: Math.max(0.1, r1(tps)),
    partly_on_cpu: verdict === "does_not_fit",
  };
}

export function measuredFor(est, measured) {
  const rows = measured.filter(m => m.model === est.model_id && m.gpu === est.hardware_id);
  if (!rows.length) return null;
  const same = rows.filter(m => m.quant === est.quant);
  let use = same.length ? same : rows;
  // the run closest in context length - speed drops as the context grows
  const near = Math.min(...use.map(m => Math.abs(Math.log2((m.context || 8192) / est.context))));
  use = use.filter(m => Math.abs(Math.log2((m.context || 8192) / est.context)) === near);
  const tps = use.map(m => m.gen_tps).sort((a, b) => a - b);
  return { gen_tokens_per_s: tps[Math.floor(tps.length / 2)], results: use.reduce((n, m) => n + (m.runs || 1), 0) > 1 ? use.reduce((n, m) => n + (m.runs || 1), 0) : 1,
           quant: use[0].quant, runtime: use[0].runtime, context: use[0].context, date: use.map(m => m.date || "").sort().pop() || null, gpu_mem_peak_gib: use[0].gpu_mem_peak_gib, prompt_tps_4k: use[0].prompt_tps_4k };
}

export function suggestions(est, model, gpu, data) {
  const out = [];
  if (est.verdict === "fits") return out;
  for (const q of ["Q4_K_M", "Q3_K_M", "Q2_K"]) {
    if (data.quants[q] >= data.quants[est.quant]) continue;
    const e = estimate(model, gpu, { context: est.context, quant: q }, data.quants);
    if (e.verdict === "fits") { out.push(`Use a smaller quantization: ${q} needs about ${e.memory_gb.total} GB (some quality loss).`); break; }
  }
  if (est.context > 4096) {
    const e = estimate(model, gpu, { context: 4096, quant: est.quant }, data.quants);
    if (e.verdict === "fits") out.push(`Use a shorter context: at 4,096 tokens it needs about ${e.memory_gb.total} GB.`);
  }
  const bigger = data.gpus.filter(g => estimate(model, g, { context: est.context, quant: est.quant }, data.quants).verdict === "fits")
    .sort((a, b) => a.vram_gb - b.vram_gb).slice(0, 3).map(g => g.name);
  if (bigger.length) out.push(`Hardware where it fits as asked: ${bigger.join(", ")}.`);
  return out;
}

export function suggestModels(gpu, opts, data) {
  const ctx = +opts.context || 8192, minTps = +opts.min_tokens_per_s || 0;
  return data.models.map(m => estimate({ ...m, matched: "known" }, gpu, { context: ctx }, data.quants))
    .filter(e => e.verdict === "fits" && e.gen_tokens_per_s >= minTps)
    .sort((a, b) => b.memory_gb.weights - a.memory_gb.weights).slice(0, 10)
    .map(e => ({ model: e.model, quant: e.quant, memory_gb: e.memory_gb.total, gen_tokens_per_s: e.gen_tokens_per_s }));
}
