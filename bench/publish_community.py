"""LocalBit: community submissions (backups/submissions.json, exported nightly from the log) -> data/community.json, bundled into
the site at deploy. Only rows with status 'community' (plausible against the estimate); the middle value per model, card and
context; never who sent them. python bench/publish_community.py"""
import json, os, statistics
from collections import defaultdict
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
SRC = Path(os.environ.get("LOCALBIT_SUBMISSIONS", ROOT / "backups" / "submissions.json"))
OUT = Path(os.environ.get("LOCALBIT_COMMUNITY", ROOT / "data" / "community.json"))


def main():
    rows = json.loads(SRC.read_text(encoding="utf-8")) if SRC.exists() else []
    by = defaultdict(list)
    for r in rows:
        if r.get("status") == "community" and r.get("model_id") and r.get("gpu_id") and r.get("gen_tps"):
            by[(r["model_id"], r["gpu_id"], int(r["context"]), r.get("quant") or "")].append(r)
    out = []
    for (m, g, ctx, q), rs in sorted(by.items()):
        out.append({"model": m, "gpu": g, "context": ctx, "quant": q or None, "gen_tps": round(statistics.median(r["gen_tps"] for r in rs), 2),
                    "prompt_tps": round(statistics.median([r["prompt_tps"] for r in rs if r.get("prompt_tps")]), 1) if any(r.get("prompt_tps") for r in rs) else None,
                    "n": len(rs), "runtime": sorted(rs, key=lambda r: r["ts"])[-1].get("runtime"), "date": max(r["ts"] for r in rs)[:10]})
    OUT.write_text(json.dumps({"_about": "Community results (submitted with localbit_test.py, checked for plausibility, status community). Built nightly by bench/publish_community.py from the log. CC BY 4.0.",
                               "community": out}, indent=1), encoding="utf-8")
    print("COMMUNITY rows", len(out), "from", len(rows), "submissions")


if __name__ == "__main__":
    main()
