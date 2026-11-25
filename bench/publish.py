"""LocalBit: the overnight runs (data/runs_3090.jsonl) -> data/measured.json, one row per model and context: the middle of the
3 generation runs, the prompt speeds, memory, power. Run after the bench; the Worker reads data/measured.json.
  python bench/publish.py"""
import json, os, statistics
from collections import defaultdict
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
TAG_TO_ID = {"llama3.2:3b": "llama-3.2-3b", "llama3.1:8b": "llama-3.1-8b", "qwen3:8b": "qwen3-8b", "gemma3:12b": "gemma-3-12b", "qwen3:14b": "qwen3-14b",
             "phi4:14b": "phi-4", "gpt-oss:20b": "gpt-oss-20b", "mistral-small:24b": "mistral-small-24b", "gemma3:27b": "gemma-3-27b",
             "qwen3:30b": "qwen3-30b-a3b", "qwen3:32b": "qwen3-32b", "qwen3.8:27b": "qwen3.8-27b", "gemma4:e4b": "gemma4-e4b", "llama3.3:70b": "llama-3.3-70b"}


def main():
    RUNS = Path(os.environ.get("LOCALBIT_RUNS", ROOT / "data" / "runs_3090.jsonl"))
    OUT = Path(os.environ.get("LOCALBIT_MEASURED", ROOT / "data" / "measured.json"))
    rows = [json.loads(l) for l in RUNS.read_text(encoding="utf-8").splitlines() if l.strip()] if RUNS.exists() else []
    by = defaultdict(list)
    for r in rows:
        by[(r["model"], r.get("ctx"))].append(r)
    quizzes = {}   # the newest quality check per model
    for r in rows:
        if r.get("test") == "quiz" and r.get("n"):
            quizzes[r["model"]] = r
    out = []
    for (model, ctx), rs in sorted(by.items(), key=lambda kv: (kv[0][0], kv[0][1] or 0)):
        if ctx is None:
            continue
        # (Nov 25 - lesson from a home assistant's watchdog) a run that landed partly off the graphics card measures the wrong thing - left out
        gens = [r for r in rs if r["test"] == "gen" and r.get("gen_tps") and r.get("all_on_gpu") is not False]
        if len(gens) < 2:
            continue
        mid = sorted(gens, key=lambda r: r["gen_tps"])[len(gens) // 2]
        p512 = next((r["prompt_tps"] for r in rs if r["test"] == "prompt_512" and r.get("prompt_tps")), None)
        p4k = next((r["prompt_tps"] for r in rs if r["test"] == "prompt_4k" and r.get("prompt_tps")), None)
        out.append({"model": TAG_TO_ID.get(model, model), "ollama_tag": model, "gpu": "rtx-3090", "quant": mid.get("quant"), "context": ctx,
                    "gen_tps": mid["gen_tps"], "prompt_tps_512": p512, "prompt_tps_4k": p4k, "first_token_s": mid.get("first_token_s"),
                    "gpu_mem_peak_gib": round(mid["gpu_mem_peak_mib"] / 1024, 2) if mid.get("gpu_mem_peak_mib") else None,
                    "all_on_gpu": mid.get("all_on_gpu"), "power_w": mid.get("power_w"),
                    "tokens_per_joule": round(mid["gen_tps"] / mid["power_w"], 3) if mid.get("power_w") else None,
                    "runtime": "Ollama " + str(mid.get("ollama", "?")), "driver": mid.get("driver"), "runs": len(gens), "date": mid["date"][:10],
                    "source": "LocalBit test machine (RTX 3090, Windows) - middle of %d runs" % len(gens),
                    **({"quality_pct": round(100 * quizzes[model]["right"] / quizzes[model]["n"]), "quality_by_cat": quizzes[model].get("by_cat"),
                        "quality_n": quizzes[model]["n"], "quality_date": quizzes[model]["date"][:10]} if model in quizzes else {})})
    OUT.write_text(json.dumps({"_about": "Measured on LocalBit's RTX 3090 (Windows, Ollama): middle of 3 runs per model and context, temperature 0, made-up prompts. gpu_mem_peak_gib is the whole card's peak use (the desktop adds about 0.5-1 GB). power_w is the card's average draw while generating. quality_pct is the share of LocalBit's 60 script-graded questions answered right (math, instructions, facts, code; 4K context, temperature 0, thinking off). License: CC BY 4.0 - credit LocalBit.",
                                                           "measured": out}, indent=1), encoding="utf-8")
    print("PUBLISH rows", len(out), "models", len({o["model"] for o in out}))


if __name__ == "__main__":
    main()
