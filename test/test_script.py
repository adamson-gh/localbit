"""LocalBit: the 3-minute test script against a made-up Ollama and a made-up LocalBit - it measures, shows what it would send,
sends nothing without a yes, sends only the listed fields with one, and the community publisher keeps only plausible rows.
python test/test_script.py"""
import json, os, subprocess, sys, tempfile, threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
posted = []; unloaded = []; STATE = {"other_loaded": False}
class O(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _j(self, o):
        b = json.dumps(o).encode(); self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        if self.path == "/api/tags": return self._j({"models": [{"name": "made-up:7b"}, {"name": "nomic-embed-text:latest"}, {"name": "broken:1b"}]})
        if self.path == "/api/version": return self._j({"version": "0.0-test"})
        if self.path == "/api/ps": return self._j({"models": [{"name": "made-up:7b", "size": 5 * 2**30, "size_vram": 5 * 2**30}] + ([{"name": "other:3b", "size": 3 * 2**30, "size_vram": 3 * 2**30}] if STATE["other_loaded"] else [])})
        self._j({})
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])) or b"{}")
        if self.path == "/api/show": return self._j({"details": {"quantization_level": "Q4_K_M"}, "capabilities": ["embedding"] if "embed" in body.get("model", "") else ["completion"]})
        if self.path == "/api/generate" and body.get("keep_alive") == 0: unloaded.append(body["model"]); STATE["other_loaded"] = False; return self._j({"done": True})
        if self.path == "/api/generate" and body.get("model") == "broken:1b":
            self.send_response(500); self.end_headers(); self.wfile.write(b'{"error":"model runner crashed"}'); return
        if self.path == "/api/generate": return self._j({"eval_count": 256, "eval_duration": int(4e9), "prompt_eval_count": 4000, "prompt_eval_duration": int(2e9)})
        if self.path == "/api/submit": posted.append(body); return self._j({"answer": "Thank you - recorded (made-up)."})
        self._j({})
srv = HTTPServer(("127.0.0.1", 0), O); threading.Thread(target=srv.serve_forever, daemon=True).start()
url = "http://127.0.0.1:%d" % srv.server_port
env = dict(os.environ, LOCALBIT_OLLAMA=url, LOCALBIT_SITE=url, LOCALBIT_RECIPE=str(ROOT / "data" / "recipe.json"), LOCALBIT_FAKE_GPU="Made-up GPU 9000|12|1")
script = str(ROOT / "bench" / "localbit_test.py")
ok = bad = 0
def check(name, cond, got=""):
    global ok, bad
    ok, bad = (ok + 1, bad) if cond else (ok, bad + 1)
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else "  got: %r" % (got,)))
r = subprocess.run([sys.executable, script, "--model", "made-up:7b", "--dry-run"], env=env, capture_output=True, text=True, timeout=120)
check("dry run: measures, shows what would be sent, sends nothing", r.returncode == 0 and '"gen_tps": 64.0' in r.stdout and "nothing sent" in r.stdout and not posted, (r.stdout[-400:], r.stderr[-300:]))
r = subprocess.run([sys.executable, script, "--model", "made-up:7b"], env=env, input="n\n", capture_output=True, text=True, timeout=120)
check("answering no: nothing is sent", r.returncode == 0 and "Not sent" in r.stdout and not posted, r.stdout[-300:])
r = subprocess.run([sys.executable, script, "--model", "made-up:7b"], env=env, input="y\n", capture_output=True, text=True, timeout=120)
check("answering yes: sent once, LocalBit's reply shown", len(posted) == 1 and "recorded" in r.stdout, (posted, r.stdout[-300:]))
p = posted[0] if posted else {}
check("only the listed fields are sent - no names, paths or addresses", set(p) <= {"recipe_version", "model", "quant", "hardware", "memory_gb", "cards", "runtime", "os", "results", "client"}
      and not any(x in json.dumps(p) for x in (os.path.expanduser("~"), os.environ.get("USERNAME", "@@"), os.environ.get("USER", "@@"), "127.0.0.1")), p)
check("results: both recipe contexts, prompt speed at 16K, on-card flag", [x["context"] for x in p.get("results", [])] == [4096, 16384] and p["results"][1].get("prompt_tps") == 2000.0 and p["results"][0].get("all_on_gpu") is True, p.get("results"))
r = subprocess.run([sys.executable, script, "--dry-run"], env=env, input="1\n", capture_output=True, text=True, timeout=120)
check("the model list leaves out embedding models (they can't be measured)", "nomic-embed-text" not in r.stdout and "made-up:7b" in r.stdout and "broken:1b" in r.stdout, r.stdout[:300])
r = subprocess.run([sys.executable, script, "--model", "broken:1b", "--dry-run"], env=env, capture_output=True, text=True, timeout=120)
check("a model Ollama can't run: a plain sentence, no traceback", r.returncode == 1 and "couldn't run this model (error 500)" in r.stdout and "Traceback" not in r.stdout + r.stderr, (r.stdout[-300:], r.stderr[-300:]))
STATE["other_loaded"] = True

r = subprocess.run([sys.executable, script, "--model", "made-up:7b", "--dry-run"], env=env, capture_output=True, text=True, timeout=120)
check("another loaded model is named; without a terminal nothing is unloaded unasked", "Also loaded in Ollama, sharing the card's memory: other:3b (3.0 GB)" in r.stdout and "Not unloading" in r.stdout and not unloaded, r.stdout[:400])
import importlib.util as _iu
_sp = _iu.spec_from_file_location("lbt2", script); lbt2 = _iu.module_from_spec(_sp); _sp.loader.exec_module(lbt2)
lbt2.OLLAMA = url
lbt2.free_card("made-up:7b", ask=lambda q: "")
check("asked and answered yes (Enter): the other model is unloaded", unloaded == ["other:3b"], unloaded)
srv.shutdown()
# the community publisher: only plausible rows, middle value, count
tmp = Path(tempfile.mkdtemp())
subs = [dict(ts="2026-11-26T10:00:00Z", model_id="llama-3.1-8b", gpu_id="rtx-4060", context=4096, quant="Q4_K_M", gen_tps=v, status=s, runtime="Ollama 0.40") for v, s in ((40, "community"), (42, "community"), (41, "community"), (400, "flagged"))]
(tmp / "subs.json").write_text(json.dumps(subs), encoding="utf-8")
r = subprocess.run([sys.executable, str(ROOT / "bench" / "publish_community.py")], env=dict(os.environ, LOCALBIT_SUBMISSIONS=str(tmp / "subs.json"), LOCALBIT_COMMUNITY=str(tmp / "c.json")), capture_output=True, text=True, timeout=60)
c = json.loads((tmp / "c.json").read_text())["community"] if (tmp / "c.json").exists() else []
check("community data: flagged rows left out, the middle of the plausible ones, how many", len(c) == 1 and c[0]["gen_tps"] == 41 and c[0]["n"] == 3, (c, r.stderr[-200:]))
# confirming the card against LocalBit's list (Windows AMD/Intel and typed names)
import importlib.util
sp = importlib.util.spec_from_file_location("lbt", script); lbt = importlib.util.module_from_spec(sp); sp.loader.exec_module(lbt)
known = [{"name": "AMD Radeon RX 7900 XTX", "vram_gb": 24}, {"name": "AMD Radeon RX 7900 XT", "vram_gb": 20}, {"name": "NVIDIA GeForce RTX 4060", "vram_gb": 8, "aliases": ["4060"]}]
h = lbt.settle({"hardware": "AMD Radeon RX 7900 XTX", "memory_gb": None, "cards": 1, "unsure": True}, known, ask=lambda q: "")
check("Windows' card name matching LocalBit's exactly: taken, with its memory", h == {"hardware": "AMD Radeon RX 7900 XTX", "memory_gb": 24, "cards": 1}, h)
h = lbt.settle({"hardware": "7900", "memory_gb": None, "cards": 1}, known, ask=lambda q: "2")
check("a vague typed name: pick from LocalBit's matching cards", h["hardware"] == "AMD Radeon RX 7900 XT" and h["memory_gb"] == 20, h)
h = lbt.settle({"hardware": "Arc B580", "memory_gb": None, "cards": 1}, known, ask=lambda q: "")
check("no match: keeps what was typed", h["hardware"] == "Arc B580", h)
h = lbt.settle({"hardware": "NVIDIA GeForce RTX 4060", "memory_gb": 8, "cards": 1}, None, ask=lambda q: 1 / 0)
check("nvidia-smi or a Mac (name and memory known): no question, no lookup", h["hardware"] == "NVIDIA GeForce RTX 4060")
print("\n%d passed, %d failed" % (ok, bad)); sys.exit(1 if bad else 0)
