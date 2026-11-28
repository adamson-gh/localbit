"""LocalBit bench against a made-up Ollama (no card, no downloads): it measures, writes rows, publishes medians, never downloads a
model that isn't approved, and puts the assistant's model back. python test/test_bench.py"""
import json, os, subprocess, sys, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
calls = []
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _j(self, o):
        b = json.dumps(o).encode(); self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        calls.append(("GET", self.path, None))
        if self.path == "/api/ps": return self._j({"models": [{"name": "made-up:7b", "size": 5 * 2**30, "size_vram": 5 * 2**30}]})
        if self.path == "/api/tags": return self._j({"models": [{"name": "made-up:7b"}]})
        if self.path == "/api/version": return self._j({"version": "0.0-test"})
        self._j({})
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])) or b"{}")
        calls.append(("POST", self.path, body))
        if self.path == "/api/show": return self._j({"details": {"quantization_level": "Q4_K_M", "parameter_size": "7B", "family": "madeup"}})
        if self.path == "/api/generate":
            if "prompt" not in body: return self._j({})
            return self._j({"prompt_eval_count": 500, "prompt_eval_duration": int(0.4e9), "eval_count": 256, "eval_duration": int(4e9), "load_duration": int(1e9)})
        self._j({})
srv = HTTPServer(("127.0.0.1", 0), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
tmp = Path(tempfile.mkdtemp())
bench = ROOT / "bench"
(tmp / "approved.txt").write_text("made-up:7b\n", encoding="utf-8")   # (Nov 26) a temp list - the real approved.txt is never touched
env = dict(os.environ, LOCALBIT_OLLAMA="http://127.0.0.1:%d" % srv.server_port, LOCALBIT_RUNS=str(tmp / "runs.jsonl"), LOCALBIT_PULLED=str(tmp / "pulled.json"), LOCALBIT_BUSY_LOG=str(tmp / "no-access.log"), LOCALBIT_APPROVED=str(tmp / "approved.txt"))
r = subprocess.run([sys.executable, str(bench / "run_3090.py"), "--now", "--max-models", "1"], env=env, capture_output=True, text=True, timeout=120)
ok = bad = 0
def check(name, cond, got=""):
    global ok, bad
    ok, bad = (ok + 1, bad) if cond else (ok, bad + 1)
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else "  got: %r" % (got,)))
rows = [json.loads(l) for l in (tmp / "runs.jsonl").read_text().splitlines()] if (tmp / "runs.jsonl").exists() else []
qz = [x for x in rows if x["test"] == "quiz"]
rows = [x for x in rows if x["test"] != "quiz"]
check("it measured: 3 contexts, prompt and generation tests, 3 generation runs each", len([x for x in rows if x["test"] == "gen"]) == 9 and len(rows) == 9 + 3 + 2, (len(rows), r.stderr[-300:]))
check("then the 60-question quality check: one row, right per group, missed ids, nothing else", len(qz) == 1 and qz[0]["n"] == 60 and set(qz[0]["by_cat"]) <= {"math", "instructions", "facts", "code"} and isinstance(qz[0]["missed"], list) and "response" not in qz[0], qz[:1])
check("speeds worked out from Ollama's own timings", rows and rows[0].get("gen_tps") == 64.0 or any(x.get("gen_tps") == 64.0 for x in rows), rows[:1])
check("only numbers and versions are recorded", all(set(x) <= {"date", "gpu", "model", "ctx", "test", "run", "kv_cache", "quant", "params", "family", "ollama", "driver", "prompt_tokens",
      "gen_tokens", "prompt_tps", "gen_tps", "first_token_s", "load_s", "wall_s", "gpu_mem_peak_mib", "power_w", "all_on_gpu", "loaded_gib"} for x in rows), rows[:1])
check("nothing was downloaded (the model was already there)", not (tmp / "pulled.json").exists())
check("the assistant's model goes back on the card at the end, with its context size", any(c[1] == "/api/generate" and c[2].get("model") == "qwen3.8:27b" and c[2].get("keep_alive") == -1 and c[2]["options"]["num_ctx"] == 16384 for c in calls))
# publish - into the temp folder (tests never write the real data files)
penv = dict(os.environ, LOCALBIT_RUNS=str(tmp / "runs.jsonl"), LOCALBIT_MEASURED=str(tmp / "measured.json"), LOCALBIT_MODELS="")
p = subprocess.run([sys.executable, str(bench / "publish.py")], env=penv, capture_output=True, text=True, timeout=60)
pub = json.loads((tmp / "measured.json").read_text())["measured"] if (tmp / "measured.json").exists() else []
check("publish: one row per context, the middle of the runs", len(pub) == 3 and pub[0]["gen_tps"] == 64.0 and pub[0]["runs"] == 3, (pub[:1], p.stderr[-200:]))
check("the made-up model sent empty answers: its quality check is held back, not published as 0%", all("quality_pct" not in x for x in pub) and "quality held back" in p.stdout, (pub[:1], p.stdout[-200:]))
check("the real data files are untouched", not (ROOT / "data" / "runs_3090.jsonl").exists() or "made-up" not in (ROOT / "data" / "runs_3090.jsonl").read_text())
# (Nov 28) a real check is published; a newer one with two or more whole groups at zero (the answers didn't come through) isn't
_q = json.loads([l for l in (tmp / "runs.jsonl").read_text().splitlines() if '"quiz"' in l][-1])
def _pub(**kw):
    q = dict(_q, **kw)
    with open(tmp / "runs.jsonl", "a") as _f:
        _f.write(json.dumps(q) + "\n")
    r = subprocess.run([sys.executable, str(bench / "publish.py")], env=penv, capture_output=True, text=True, timeout=60)
    return json.loads((tmp / "measured.json").read_text())["measured"], r.stdout
pub2, _ = _pub(right=40, by_cat={"math": 9, "facts": 12, "code": 9, "instructions": 10}, date=_q["date"][:10] + "T23:00:00")
check("a real quality check goes out with the speeds", pub2 and pub2[0].get("quality_pct") == 67 and pub2[0].get("quality_n") == 60, pub2[:1])
pub3, out3 = _pub(right=11, by_cat={"math": 0, "facts": 2, "code": 9, "instructions": 0}, date=_q["date"][:10] + "T23:59:59")
check("a newer one with two groups at zero is held back and named", all("quality_pct" not in x for x in pub3) and "quality held back" in out3, (pub3[:1], out3[-200:]))
# who counts as "in use": a person on the phone, not the machine's own scripts
import importlib.util as _u
from datetime import datetime as _dt
os.environ["LOCALBIT_BUSY_LOG"] = str(tmp / "access.log")
os.environ["LOCALBIT_MODELS"] = ""   # (Nov 28) publish.py holds back models LocalBit doesn't know - these made-up ones aren't in data/models.json
spec = _u.spec_from_file_location("rb", bench / "run_3090.py"); rb = _u.module_from_spec(spec); spec.loader.exec_module(rb)
now = _dt.now().strftime("%m-%d %H:%M:%S")
(tmp / "access.log").write_text(now + " local     POST /chat                     200 900ms\n", encoding="utf-8")
check("the machine's own requests (local) don't stop the run", not rb.assistant_busy())
(tmp / "access.log").write_text(now + " tailscale POST /voice                    200 900ms\n" + now + " local     POST /chat                     200 900ms\n", encoding="utf-8")
check("a request from the phone does", rb.assistant_busy())
sys.path.insert(0, str(bench)); import quiz as QZ
check("the quiz: 60 questions, 15 per group", len(QZ.Q) == 60 and all(sum(1 for q in QZ.Q if q["cat"] == c) == 15 for c in ("math", "instructions", "facts", "code")))
ix = {q["id"]: q for q in QZ.Q}
check("grading (version 2): right answers pass, wrong ones fail", QZ.VERSION == 2 and QZ.grade(ix["m01"], "The final price is $48.") and not QZ.grade(ix["m01"], "50")
      and QZ.grade(ix["f01"], "Tungsten") and QZ.grade(ix["f04"], "Gabriel García Márquez") and QZ.grade(ix["i03"], "[2, 3, 5, 7, 11]") and not QZ.grade(ix["i13"], "No, 91 = 7 x 13")
      and QZ.grade(ix["c08"], "b10") and len(QZ.Q1) == 60)
# nightly: the live-site check, re-measuring after a runtime update, and leaving out runs partly off the card
class SiteH(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _j(self, o):
        b = json.dumps(o).encode(); self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers(); self.wfile.write(b)
    def do_POST(self): self.rfile.read(int(self.headers["content-length"])); self._j({"result": {"tools": [{}, {}, {}, {}, {}, {}]}})
    def do_GET(self): self._j({"verdict": "fits"})
site = HTTPServer(("127.0.0.1", 0), SiteH); threading.Thread(target=site.serve_forever, daemon=True).start()
import nightly as NG
check("nightly: the live-site check passes when the site answers", NG.site_ok("http://127.0.0.1:%d" % site.server_port))
check("...and fails when it doesn't", not NG.site_ok("http://127.0.0.1:9"))
site.shutdown()
os.environ["LOCALBIT_RUNS"] = str(tmp / "ver_runs.jsonl")
(tmp / "ver_runs.jsonl").write_text(json.dumps({"date": "2099-01-01T03:00:00", "model": "made-up:7b", "test": "gen", "gen_tps": 50, "ollama": "0.40", "driver": "600"}) + "\n", encoding="utf-8")
spec2 = _u.spec_from_file_location("rb2", bench / "run_3090.py"); rb2 = _u.module_from_spec(spec2); spec2.loader.exec_module(rb2)
check("same runtime: the measurement still counts", rb2.done_recently("made-up:7b", days=1e6, ver={"ollama": "0.40", "driver": "600"}))
check("Ollama or driver updated: re-measure", not rb2.done_recently("made-up:7b", days=1e6, ver={"ollama": "0.41", "driver": "600"}))
part = [dict(date="2026-11-25T03:00:00", gpu="rtx-3090", model="made-up:7b", ctx=4096, test="gen", run=i, gen_tps=50 + i, all_on_gpu=(i != 2)) for i in range(3)]
(tmp / "part.jsonl").write_text("".join(json.dumps(x) + "\n" for x in part), encoding="utf-8")
pp = subprocess.run([sys.executable, str(bench / "publish.py")], env=dict(os.environ, LOCALBIT_RUNS=str(tmp / "part.jsonl"), LOCALBIT_MEASURED=str(tmp / "part_out.json")), capture_output=True, text=True, timeout=60)
po = json.loads((tmp / "part_out.json").read_text())["measured"]
check("a run partly off the graphics card is left out of what's published", po and po[0]["runs"] == 2, (po, pp.stderr[-200:]))
(tmp / "fail_runs.jsonl").write_text("", encoding="utf-8")
os.environ["LOCALBIT_RUNS"] = str(tmp / "fail_runs.jsonl")
spec3 = _u.spec_from_file_location("rb3", bench / "run_3090.py"); rb3 = _u.module_from_spec(spec3); spec3.loader.exec_module(rb3)
rb3.note_failure("made-up:7b", "made-up crash"); check("one failure: tried again next night", rb3.recent_failures("made-up:7b") == 1)
rb3.note_failure("made-up:7b", "made-up crash"); check("two failures in a week: skipped", rb3.recent_failures("made-up:7b") == 2)
srv.shutdown()
# (Nov 28) a measured Ollama tag LocalBit has no model for is held back and named; a known alias is published under its model
_tm = tmp / "models_t.json"; _tm.write_text(json.dumps({"models": [{"id": "made-up:7b", "aliases": []}, {"id": "other-14b", "aliases": ["unknown:14b"]}]}), encoding="utf-8")
_rr = tmp / "held_runs.jsonl"
_rr.write_text("".join(json.dumps({"date": "2099-01-01T03:00:00", "model": m, "ctx": 4096, "test": "gen", "gen_tps": 50 + k, "all_on_gpu": True}) + "\n"
                       for m in ("made-up:7b", "unknown:14b") for k in (0, 1, 2)), encoding="utf-8")
_hp = subprocess.run([sys.executable, str(bench / "publish.py")], env=dict(os.environ, LOCALBIT_RUNS=str(_rr), LOCALBIT_MEASURED=str(tmp / "held_out.json"), LOCALBIT_MODELS=str(_tm)), capture_output=True, text=True)
_ho = json.loads((tmp / "held_out.json").read_text(encoding="utf-8"))["measured"]
check("publish: a model LocalBit knows goes out; one known only as another model's alias is held back and named (its quality isn't that model's)", [x["model"] for x in _ho] == ["made-up:7b"] and "held back" in _hp.stdout and "unknown:14b" in _hp.stdout, (_ho, _hp.stdout))
# (Nov 28: qwen3:30b scored 11/60 - its answers sat behind a think block) the answer after <think>...</think> is graded; a reply cut off
# inside the block is asked once more with room; the row counts think blocks and empty answers. Made-up replies, no Ollama.
import quiz as _QZ
class _R:
    def __init__(self, j): self._j = j
    def json(self): return self._j
def _fake_post(url, json=None, timeout=None):
    q = next(x for x in _QZ.Q if x["prompt"] == json["prompt"])
    if json["options"]["num_predict"] < 1000:
        return _R({"response": "<think>let me work this out step by step and"})
    return _R({"response": "<think>done</think>\n" + str(q["answer"])})
_saved = (rb.requests.post, rb.RUNS, rb.should_stop, rb.unload_all, rb.model_meta)
rb.requests.post, rb.RUNS, rb.should_stop, rb.unload_all, rb.model_meta = _fake_post, tmp / "think_runs.jsonl", (lambda now: False), (lambda: None), (lambda m: {})
try:
    _row, _st = rb.quiz("made-up-thinker:7b", {})
finally:
    rb.requests.post, rb.RUNS, rb.should_stop, rb.unload_all, rb.model_meta = _saved
check("a think block is skipped and a cut-off one asked again: the answers are graded", _row and _row["by_cat"].get("math") == sum(1 for q in _QZ.Q if q["cat"] == "math" and q["kind"] == "num") and _row["think_tags"] == 60, _row and {k: _row[k] for k in ("by_cat", "think_tags", "empty")})
check("a check with two groups at zero doesn't count as done - it's re-run", (lambda f: (f.write_text(json.dumps({"date": _dt.now().isoformat(timespec="seconds"), "model": "z:1b", "test": "quiz", "n": 60, "quiz_version": rb.QUIZ_VERSION, "by_cat": {"math": 0, "facts": 2, "code": 9, "instructions": 0}}) + "\n"), setattr(rb, "RUNS", f), not rb.done_recently("z:1b", test="quiz"))[-1])(tmp / "zero_runs.jsonl"))
print("\n%d passed, %d failed" % (ok, bad)); sys.exit(1 if bad else 0)
