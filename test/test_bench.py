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
approved_bak = (bench / "approved.txt").read_text(encoding="utf-8")
(bench / "approved.txt").write_text("made-up:7b\n", encoding="utf-8")
env = dict(os.environ, LOCALBIT_OLLAMA="http://127.0.0.1:%d" % srv.server_port, LOCALBIT_RUNS=str(tmp / "runs.jsonl"), LOCALBIT_PULLED=str(tmp / "pulled.json"), LOCALBIT_BUSY_LOG=str(tmp / "no-access.log"))
try:
    r = subprocess.run([sys.executable, str(bench / "run_3090.py"), "--now", "--max-models", "1"], env=env, capture_output=True, text=True, timeout=120)
finally:
    (bench / "approved.txt").write_text(approved_bak, encoding="utf-8")
ok = bad = 0
def check(name, cond, got=""):
    global ok, bad
    ok, bad = (ok + 1, bad) if cond else (ok, bad + 1)
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else "  got: %r" % (got,)))
rows = [json.loads(l) for l in (tmp / "runs.jsonl").read_text().splitlines()] if (tmp / "runs.jsonl").exists() else []
check("it measured: 3 contexts, prompt and generation tests, 3 generation runs each", len([x for x in rows if x["test"] == "gen"]) == 9 and len(rows) == 9 + 3 + 2, (len(rows), r.stderr[-300:]))
check("speeds worked out from Ollama's own timings", rows and rows[0].get("gen_tps") == 64.0 or any(x.get("gen_tps") == 64.0 for x in rows), rows[:1])
check("only numbers and versions are recorded", all(set(x) <= {"date", "gpu", "model", "ctx", "test", "run", "kv_cache", "quant", "params", "family", "ollama", "driver", "prompt_tokens",
      "gen_tokens", "prompt_tps", "gen_tps", "first_token_s", "load_s", "wall_s", "gpu_mem_peak_mib", "power_w", "all_on_gpu", "loaded_gib"} for x in rows), rows[:1])
check("nothing was downloaded (the model was already there)", not (tmp / "pulled.json").exists())
check("the assistant's model goes back on the card at the end, with its context size", any(c[1] == "/api/generate" and c[2].get("model") == "qwen3.8:27b" and c[2].get("keep_alive") == -1 and c[2]["options"]["num_ctx"] == 16384 for c in calls))
# publish - into the temp folder (tests never write the real data files)
penv = dict(os.environ, LOCALBIT_RUNS=str(tmp / "runs.jsonl"), LOCALBIT_MEASURED=str(tmp / "measured.json"))
p = subprocess.run([sys.executable, str(bench / "publish.py")], env=penv, capture_output=True, text=True, timeout=60)
pub = json.loads((tmp / "measured.json").read_text())["measured"] if (tmp / "measured.json").exists() else []
check("publish: one row per context, the middle of the runs", len(pub) == 3 and pub[0]["gen_tps"] == 64.0 and pub[0]["runs"] == 3, (pub[:1], p.stderr[-200:]))
check("the real data files are untouched", not (ROOT / "data" / "runs_3090.jsonl").exists() or "made-up" not in (ROOT / "data" / "runs_3090.jsonl").read_text())
srv.shutdown()
print("\n%d passed, %d failed" % (ok, bad)); sys.exit(1 if bad else 0)
