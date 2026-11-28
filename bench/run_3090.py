"""LocalBit overnight measurements on this PC's RTX 3090 (run by the Windows task "LocalBit 3090 bench", 3:10 AM).

For each model in bench/approved.txt not measured yet (or measured over 30 days ago): download it if missing (only names in
approved.txt are ever downloaded), load it alone on the card, and time fixed made-up prompts at several context lengths - 3 runs
each, the middle one counts later (bench/publish.py). Records only numbers: speeds, memory, power, versions. Nothing personal.

The card is shared with a home assistant: the run stops at once - and puts the assistant's own model back - if the assistant
was used in the last 10 minutes, or it's past 5:00 AM.
  python bench/run_3090.py [--max-models 3] [--now]   (--now: ignore the time window, for a test run)"""
import json, os, re, statistics, subprocess, sys, threading, time
from datetime import datetime
from pathlib import Path
import requests

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
RUNS = Path(os.environ.get("LOCALBIT_RUNS", ROOT / "data" / "runs_3090.jsonl"))
PULLED = Path(os.environ.get("LOCALBIT_PULLED", HERE / "pulled.json"))           # models this script downloaded (so they can be removed later)
CONFIG = HERE / "config.json"
OLLAMA = os.environ.get("LOCALBIT_OLLAMA", "http://127.0.0.1:11434")
ASSISTANT_LOG = Path(os.environ.get("LOCALBIT_BUSY_LOG", r"C:\Projects\ai\ai_assistant_v3\logs\access.log"))
ASSISTANT_MODEL, ASSISTANT_CTX = os.environ.get("LOCALBIT_RESTORE_MODEL", "qwen3.8:27b"), 16384   # put back on the card afterwards
CONTEXTS = [4096, 16384, 32768]
GEN_PROMPT = ("Write a calm, detailed story of about four hundred words about a lighthouse keeper named Imra who repairs an old "
              "clockwork lamp during a winter storm. Describe each step of the repair.")
FILLER = ("The tide charts in the lower office list every harbour light along the coast, with notes on lens type, oil supply, "
          "and the hour each lamp was last cleaned. ")


def log(*a):
    print(datetime.now().strftime("%H:%M:%S"), *a, flush=True)


def cfg():
    try:
        return json.loads(CONFIG.read_text(encoding="utf-8"))
    except Exception:
        return {}


def assistant_busy(minutes=10):
    """The home assistant was used recently by a person (a /chat or /voice from the phone - Tailscale, home Wi-Fi or outside -
    in its access log) - the card is in use. Requests from the machine itself ("local": its own tests and nightly jobs) don't count."""
    try:
        tail = ASSISTANT_LOG.read_text(encoding="utf-8", errors="ignore").splitlines()[-400:]
    except OSError:
        return False
    now = datetime.now()
    for line in reversed(tail):
        m = re.match(r"(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d) (\S+)\s+POST\s+/(chat|voice)\b", line)
        if m and m[6] != "local":
            t = now.replace(month=int(m[1]), day=int(m[2]), hour=int(m[3]), minute=int(m[4]), second=int(m[5]))
            return (now - t).total_seconds() < minutes * 60
    return False


def should_stop(now_mode):
    if assistant_busy():
        log("the assistant is in use - stopping")
        return True
    if not now_mode and not (3 <= datetime.now().hour < 5):
        log("outside 3-5 AM - stopping")
        return True
    return False


class GpuWatch:
    """nvidia-smi every half second while a test runs: peak memory used (MiB) and average power (W)."""
    def __init__(self):
        self.mem, self.pow, self.on = [], [], False

    def _loop(self):
        while self.on:
            try:
                out = subprocess.run(["nvidia-smi", "--query-gpu=memory.used,power.draw", "--format=csv,noheader,nounits"],
                                     capture_output=True, text=True, timeout=5).stdout.strip().splitlines()[0]
                m, p = [float(x) for x in out.split(",")]
                self.mem.append(m); self.pow.append(p)
            except Exception:
                pass
            time.sleep(0.5)

    def __enter__(self):
        self.on = True
        self.t = threading.Thread(target=self._loop, daemon=True); self.t.start()
        return self

    def __exit__(self, *a):
        self.on = False; self.t.join(2)

    def result(self):
        return (max(self.mem) if self.mem else None), (round(statistics.mean(self.pow), 1) if self.pow else None)


def unload_all():
    try:
        for m in requests.get(OLLAMA + "/api/ps", timeout=10).json().get("models", []):
            requests.post(OLLAMA + "/api/generate", json={"model": m["name"], "keep_alive": 0}, timeout=60)
    except Exception as e:
        log("unload:", type(e).__name__)
    time.sleep(3)


def restore_assistant():
    unload_all()
    try:
        requests.post(OLLAMA + "/api/generate", json={"model": ASSISTANT_MODEL, "keep_alive": -1, "options": {"num_ctx": ASSISTANT_CTX}}, timeout=300)
        log("the assistant's model is back on the card")
    except Exception as e:
        log("the assistant's model not reloaded:", type(e).__name__)


def have(name):
    try:
        return any(m["name"] == name for m in requests.get(OLLAMA + "/api/tags", timeout=10).json().get("models", []))
    except Exception:
        return False


def pull(name):
    log("downloading", name)
    r = subprocess.run(["ollama", "pull", name], capture_output=True, text=True, timeout=7200)
    if r.returncode == 0:
        p = json.loads(PULLED.read_text(encoding="utf-8")) if PULLED.exists() else []
        if name not in p:
            p.append(name); PULLED.write_text(json.dumps(p, indent=1), encoding="utf-8")
        return True
    log("download failed:", r.stderr.strip()[-200:])
    return False


def versions():
    v = {}
    try:
        v["ollama"] = requests.get(OLLAMA + "/api/version", timeout=10).json().get("version")
    except Exception:
        pass
    try:
        v["driver"] = subprocess.run(["nvidia-smi", "--query-gpu=driver_version,name", "--format=csv,noheader"], capture_output=True, text=True, timeout=10).stdout.strip()
    except Exception:
        pass
    return v


def gen(model, prompt, ctx, predict):
    body = {"model": model, "prompt": prompt, "stream": False, "keep_alive": "10m",
            "options": {"num_ctx": ctx, "num_predict": predict, "temperature": 0, "seed": 7}}
    if THINKS.get(model):   # thinking off for models that think; others refuse the "think" field
        body["think"] = False
    with GpuWatch() as w:
        t0 = time.time()
        r = requests.post(OLLAMA + "/api/generate", json=body, timeout=1800).json()
        wall = time.time() - t0
    if r.get("error"):
        return {"error": str(r["error"])[:160]}
    mem, power = w.result()
    ns = 1e9
    out = {"prompt_tokens": r.get("prompt_eval_count"), "gen_tokens": r.get("eval_count"),
           "prompt_tps": round(r["prompt_eval_count"] / (r["prompt_eval_duration"] / ns), 1) if r.get("prompt_eval_duration") else None,
           "gen_tps": round(r["eval_count"] / (r["eval_duration"] / ns), 2) if r.get("eval_duration") else None,
           "first_token_s": round((r.get("load_duration", 0) + r.get("prompt_eval_duration", 0)) / ns, 2),
           "load_s": round(r.get("load_duration", 0) / ns, 2), "wall_s": round(wall, 1), "gpu_mem_peak_mib": mem, "power_w": power}
    try:
        ps = next((m for m in requests.get(OLLAMA + "/api/ps", timeout=10).json().get("models", []) if m["name"] == model), None)
        if ps:
            out["all_on_gpu"] = ps.get("size_vram", 0) >= ps.get("size", 1)
            out["loaded_gib"] = round(ps.get("size", 0) / 2**30, 2)
    except Exception:
        pass
    return out


THINKS = {}
try:
    sys.path.insert(0, str(HERE)); import quiz as _QZ; QUIZ_VERSION = _QZ.VERSION
except Exception:
    QUIZ_VERSION = 1


def model_meta(model):
    try:
        j = requests.post(OLLAMA + "/api/show", json={"model": model}, timeout=30).json()
        THINKS[model] = "thinking" in (j.get("capabilities") or [])
        d = j.get("details", {})
        return {"quant": d.get("quantization_level"), "params": d.get("parameter_size"), "family": d.get("family")}
    except Exception:
        return {}


def done_recently(model, days=30, test="gen", ver=None):
    """A real result for this model (speed: test "gen"; quality: test "quiz") in the last `days` days. (Nov 25 - a lesson from running a home assistant:
    runtime updates change speeds) a speed result from a different Ollama version or graphics driver doesn't count - re-measure."""
    if not RUNS.exists():
        return False
    for line in RUNS.read_text(encoding="utf-8").splitlines()[::-1]:
        try:
            r = json.loads(line)
        except ValueError:
            continue
        if r.get("model") == model and r.get("test") == test and (r.get("gen_tps") if test == "gen" else r.get("n")):
            if test == "quiz" and r.get("quiz_version", 1) != QUIZ_VERSION:   # (Nov 26) a new version of the check is re-run
                continue
            if test == "quiz" and sum(1 for v in (r.get("by_cat") or {}).values() if v == 0) >= 2:   # (Nov 28) answers didn't come through - re-run
                continue
            if ver and test == "gen" and (r.get("ollama") != ver.get("ollama") or r.get("driver") != ver.get("driver")):
                return False
            return (time.time() - datetime.fromisoformat(r["date"]).timestamp()) < days * 86400
    return False


def note_failure(model, err):
    """(Nov 26: phi4 crashed Ollama's runner - 0xc0000409) a failed model is noted; after two failures in a week it's skipped."""
    with open(RUNS, "a", encoding="utf-8") as f:
        f.write(json.dumps({"date": datetime.now().isoformat(timespec="seconds"), "gpu": "rtx-3090", "model": model, "test": "error", "error": str(err)[:200]}) + "\n")


def recent_failures(model, days=7):
    if not RUNS.exists():
        return 0
    n = 0
    for line in RUNS.read_text(encoding="utf-8").splitlines():
        try:
            r = json.loads(line)
        except ValueError:
            continue
        if r.get("model") == model and r.get("test") == "error" and time.time() - datetime.fromisoformat(r["date"]).timestamp() < days * 86400:
            n += 1
    return n


def quiz(model, ver):
    """(Nov 25, owner: "is quality not something we can measure? ... Yes, swap") the 60-question check (bench/quiz.py), 4K context,
    temperature 0, thinking off. One row: right per group, the ids missed. Returns (row or None, stopped)."""
    sys.path.insert(0, str(HERE))
    import quiz as QZ
    meta = model_meta(model)
    unload_all()
    got, missed = {}, []
    diag = {"empty": 0, "think_tags": 0}
    t0 = time.time()
    for q in QZ.Q:
        if should_stop(NOW):
            return None, True
        body = {"model": model, "prompt": q["prompt"], "stream": False, "keep_alive": "10m",
                "options": {"num_ctx": 4096, "num_predict": 200, "temperature": 0, "seed": 7}}
        if THINKS.get(model):
            body["think"] = False
        try:
            r = requests.post(OLLAMA + "/api/generate", json=body, timeout=600).json()
        except Exception as e:
            log(model, "quiz", q["id"], "failed:", type(e).__name__); return None, False
        if r.get("error"):
            log(model, "quiz failed:", str(r["error"])[:120]); return None, False
        # (Nov 28: qwen3:30b 11/60, math and instructions 0) a model that thinks anyway puts <think>...</think> before its answer, or
        # runs out of room inside it - the answer is what follows the block; empty answers and think blocks are counted in the row
        txt = r.get("response", "") or ""
        if "<think>" in txt:
            diag["think_tags"] += 1
            txt = re.sub(r"(?s)<think>.*?(?:</think>|$)", "", txt).strip()
            if not txt:   # it ran out of room while thinking: once more with room for the thinking and the answer
                try:
                    r2 = requests.post(OLLAMA + "/api/generate", json=dict(body, options=dict(body["options"], num_predict=2048)), timeout=900).json()
                    txt = re.sub(r"(?s)<think>.*?(?:</think>|$)", "", r2.get("response", "") or "").strip()
                except Exception as e:
                    log(model, "quiz", q["id"], "retry failed:", type(e).__name__)
        if not txt.strip():
            diag["empty"] += 1
        ok = QZ.grade(q, txt)
        got[q["cat"]] = got.get(q["cat"], 0) + (1 if ok else 0)
        if not ok:
            missed.append(q["id"])
    n = len(QZ.Q)
    row = {"date": datetime.now().isoformat(timespec="seconds"), "gpu": "rtx-3090", "model": model, "test": "quiz", "n": n,
           "right": n - len(missed), "by_cat": got, "missed": missed, "quiz_version": QZ.VERSION, "secs": round(time.time() - t0), **diag, **meta, **ver}
    with open(RUNS, "a", encoding="utf-8") as f:
        f.write(json.dumps(row) + "\n")
    log(model, "quiz", row["right"], "/", n, got)
    return row, False


def measure(model, ver):
    meta = model_meta(model)
    rows = []
    for ctx in CONTEXTS:
        unload_all()
        for test, prompt, predict in (("prompt_512", FILLER * 14 + "\nSummarise the notes above in one sentence.", 16),
                                      ("prompt_4k", FILLER * 110 + "\nSummarise the notes above in one sentence.", 16),
                                      ("gen", GEN_PROMPT, 256)):
            if test == "prompt_4k" and ctx < 8192:
                continue
            for run in range(3 if test == "gen" else 1):
                if should_stop(NOW):
                    return rows, True
                r = gen(model, prompt, ctx, predict)
                if r.get("error"):
                    log(model, ctx, test, "failed:", r["error"])
                    note_failure(model, r["error"])
                    return rows, False
                row = {"date": datetime.now().isoformat(timespec="seconds"), "gpu": "rtx-3090", "model": model, "ctx": ctx, "test": test,
                       "run": run + 1, "kv_cache": os.environ.get("OLLAMA_KV_CACHE_TYPE") or "q8_0 (system)", **meta, **ver, **r}
                rows.append(row)
                with open(RUNS, "a", encoding="utf-8") as f:
                    f.write(json.dumps(row) + "\n")
                log(model, ctx, test, run + 1, "gen", r.get("gen_tps"), "prompt", r.get("prompt_tps"), "on gpu", r.get("all_on_gpu"))
                if r.get("all_on_gpu") is False:
                    log(model, ctx, "WARNING partly off the graphics card - this run won't be published")
    return rows, False


NOW = "--now" in sys.argv


def main():
    maxm = int(sys.argv[sys.argv.index("--max-models") + 1]) if "--max-models" in sys.argv else 3
    approved = [l.strip() for l in Path(os.environ.get("LOCALBIT_APPROVED", HERE / "approved.txt")).read_text(encoding="utf-8").splitlines() if l.strip() and not l.startswith("#")]
    ver = versions()
    todo = [m for m in approved if not (done_recently(m, ver=ver) and done_recently(m, test="quiz"))]
    for m in [m for m in todo if recent_failures(m) >= 2]:
        log(m, "skipped - failed twice this week (see the error rows)")
    todo = [m for m in todo if recent_failures(m) < 2][:maxm]
    if not todo:
        log("nothing to measure"); return
    if should_stop(NOW):
        return
    try:
        for m in todo:
            if not have(m) and not pull(m):
                continue
            if should_stop(NOW):
                break
            if not done_recently(m, ver=ver):
                _, stopped = measure(m, ver)
                if stopped:
                    break
            if not done_recently(m, test="quiz"):
                _, stopped = quiz(m, ver)
                if stopped:
                    break
            # (Nov 26, owner: "keep installed") models the fresh-agent test uses (config eval_models) stay
            if cfg().get("remove_after") and m not in cfg().get("eval_models", []) and m in (json.loads(PULLED.read_text(encoding="utf-8")) if PULLED.exists() else []):
                subprocess.run(["ollama", "rm", m], capture_output=True, timeout=300)
                log("removed", m, "(downloaded for the test)")
    finally:
        restore_assistant()


if __name__ == "__main__":
    main()
