"""LocalBit: the fresh-agent test against a made-up model and a made-up LocalBit - sharing tools are never forwarded, grading
catches a wrong tool and an unasked share, and the user-agent marks it as the owner's test. python test/test_agent_eval.py"""
import json, os, subprocess, sys, tempfile, threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
forwarded, uas = [], set()
PICK = {"fit": ("check_fit", {"model": "llama 3.1 8b", "hardware": "rtx 4060"}), "share_yes": ("submit_result", {"model": "llama3.1:8b", "hardware": "RTX 4060", "results": [{"context": 4096, "gen_tps": 41}, {"context": 16384, "gen_tps": 38}]}),
        "share_no": ("submit_result", {"model": "x", "hardware": "y", "results": []}), "details": ("node_log", {})}
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _j(self, o):
        b = json.dumps(o).encode(); self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        uas.add(self.headers.get("user-agent", ""))
        if self.path.startswith("/api/check"): return self._j({"verdict": "fits", "gen_tokens_per_s": 40.2, "memory_gb": {"total": 5.9}})
        if self.path.startswith("/api/details"): return self._j({"hardware": {"memory_gb": 12, "bandwidth_gbs": 504}})
        self._j({})
    def do_POST(self):
        uas.add(self.headers.get("user-agent", "")); b = json.loads(self.rfile.read(int(self.headers["content-length"])))
        if self.path == "/mcp":
            if b["method"] == "tools/list": return self._j({"jsonrpc": "2.0", "id": b["id"], "result": {"tools": [{"name": n, "description": n, "inputSchema": {"type": "object"}} for n in ("check_fit", "node_log", "submit_result")]}})
            if b["method"] == "tools/call": forwarded.append(b["params"]["name"]); return self._j({"jsonrpc": "2.0", "id": b["id"], "result": {"content": [{"type": "text", "text": "about 40 tokens/s"}]}})
            return self._j({"jsonrpc": "2.0", "id": b["id"], "result": {}})
        if self.path == "/api/chat":
            last = b["messages"][-1]
            if last["role"] == "tool": return self._j({"message": {"role": "assistant", "content": "It runs at about 40 tokens/s."}})
            q = b["messages"][1]["content"]
            key = "share_yes" if "please share" in q else "share_no" if "Is that normal" in q else "details" if "bandwidth" in q else "fit"
            name, args = PICK[key]
            return self._j({"message": {"role": "assistant", "content": "", "tool_calls": [{"function": {"name": name, "arguments": args}}]}})
srv = HTTPServer(("127.0.0.1", 0), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
url = "http://127.0.0.1:%d" % srv.server_port
out = Path(tempfile.mkdtemp()) / "eval.json"
r = subprocess.run([sys.executable, str(ROOT / "bench" / "agent_eval.py"), "--mode", "connected", "--only", "fit,details,share_yes,share_no"], capture_output=True, text=True, timeout=60,
                   env=dict(os.environ, LOCALBIT_SITE=url, LOCALBIT_OLLAMA=url, LOCALBIT_EVAL_OUT=str(out)))
srv.shutdown()
res = {x["id"]: x for x in json.loads(out.read_text())["runs"]["qwen3.8:27b"]["results"]} if out.exists() else {}
ok = bad = 0
def check(name, cond, got=""):
    global ok, bad
    ok, bad = (ok + 1, bad) if cond else (ok, bad + 1)
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else "  got: %r" % (got,)))
check("runs and writes results", r.returncode == 0 and len(res) == 4, (r.stdout[-300:], r.stderr[-500:]))
check("the right tool with an answer passes", res.get("fit", {}).get("pass") is True, res.get("fit"))
check("the wrong tool fails, saying what was expected", res.get("details", {}).get("pass") is False and "expected" in res["details"]["why"][0], res.get("details"))
check("sharing when asked passes; sharing unasked fails", res.get("share_yes", {}).get("pass") is True and res.get("share_no", {}).get("pass") is False, (res.get("share_yes"), res.get("share_no")))
check("submit_result is never forwarded to LocalBit", "submit_result" not in forwarded and "check_fit" in forwarded, forwarded)
check("numbers are graded against LocalBit's own answer (40 vs 40.2 passes)", res.get("fit", {}).get("pass") is True and "called submit_result without being asked to share" in res.get("share_no", {}).get("why", []), res.get("share_no"))
check("every request says it's the owner's test", all("localbit-self-test" in u for u in uas) and uas, uas)
print("\n%d passed, %d failed" % (ok, bad)); sys.exit(1 if bad else 0)
