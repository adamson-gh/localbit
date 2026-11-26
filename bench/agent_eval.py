"""LocalBit: the fresh-agent test. A local model that knows nothing about LocalBit gets realistic questions and has to find its
own way, the way a newcomer agent would:
  connected - it sees only LocalBit's tool list (as any MCP client does after connecting) and calls the live tools;
  browsing  - it gets only the site's address and a tool that reads a page on that site.
submit_result and report_issue are never forwarded: the test answers them itself, so nothing is ever recorded. Requests carry
the user-agent "localbit-self-test", which LocalBit leaves out of its visitor counts. Results -> bench/agent_eval.json.
python bench/agent_eval.py [--model qwen3.8:27b] [--mode connected|browsing|both] [--only id,id]"""
import argparse, json, os, re, sys, time, urllib.parse, urllib.request
from datetime import datetime, timezone
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
SITE = os.environ.get("LOCALBIT_SITE") or json.loads((ROOT / "config" / "site.json").read_text(encoding="utf-8"))["site"]
OLLAMA = os.environ.get("LOCALBIT_OLLAMA", "http://127.0.0.1:11434")
OUT = Path(os.environ.get("LOCALBIT_EVAL_OUT", ROOT / "bench" / "agent_eval.json"))
UA = "localbit-self-test/1 (owner's fresh-agent test)"
NEVER_FORWARD = {"submit_result", "report_issue"}
SYSTEM = "You are a helpful assistant. You have tools; use them when they help, and don't guess numbers you can look up. Answer the user in a few sentences."

# (id, question, tools that count as the right choice (any one), must-call-not, the final answer must match)
TASKS = [
    ("fit", "Will Llama 3.1 8B run on my RTX 4060? How fast would it be?", {"check_fit", "compare"}, set(), r"token"),
    ("too_big", "Can I run Llama 3.1 70B on a graphics card with 8 GB?", {"check_fit"}, set(), r"\b(no|not|won't|doesn't|does not|can't|cannot|too)\b"),
    ("suggest", "I have an RTX 3090 with 24 GB. What's the best model I can run with a 16K context?", {"suggest_models"}, set(), r"\w"),
    ("compare", "Would Qwen3 32B be faster on an RTX 4090 or on an M4 Max?", {"compare", "check_fit"}, set(), r"4090|M4"),
    ("details", "How much memory and memory bandwidth does an RTX 4070 Ti have?", {"get_details", "list_known", "check_fit"}, set(), r"GB"),
    ("browse_names", "Which AMD graphics cards can you answer questions about?", {"list_known"}, set(), r"(?i)rx|radeon"),
    ("help_measure", "I have an RX 7900 XTX that nobody seems to have benchmarked for local models. How can I help measure it?", {"get_test_kit"}, {"submit_result"}, r"(?i)test\.py|/test|script"),
    ("share_yes", "I ran your 3-minute test: llama3.1:8b Q4_K_M on an NVIDIA GeForce RTX 4060 (8 GB), Ollama 0.40, Windows - 41 tokens/s at 4096 context and 38 at 16384, all on the GPU. Yes, please share these results.",
     {"submit_result"}, set(), r"\w"),
    ("share_no", "I measured 41 tokens/s for Llama 3.1 8B on my RTX 4060. Is that normal?", {"check_fit", "get_details", "compare"}, {"submit_result"}, r"\w"),
]


def post(url, body, headers=None, timeout=60):
    req = urllib.request.Request(url, json.dumps(body).encode(), {"content-type": "application/json", "user-agent": UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def mcp(method, params=None, i=[0]):
    i[0] += 1
    return post(SITE + "/mcp", {"jsonrpc": "2.0", "id": i[0], "method": method, "params": params or {}}, {"accept": "application/json, text/event-stream"})


def read_page(url):
    u = urllib.parse.urljoin(SITE + "/", url or "/")
    if urllib.parse.urlparse(u).netloc != urllib.parse.urlparse(SITE).netloc:
        return "Only pages on %s can be read in this test." % SITE
    try:
        with urllib.request.urlopen(urllib.request.Request(u, headers={"user-agent": UA}), timeout=30) as r:
            t = r.read().decode("utf-8", "ignore")
    except Exception as e:
        return "Could not read %s: %s" % (u, e)
    t = re.sub(r"(?s)<(script|style)\b.*?</\1>", " ", t)
    t = re.sub(r'<a [^>]*href="([^"]+)"[^>]*>(.*?)</a>', r"\2 [\1]", t)
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", t)).strip()[:6000]


BROWSE_TOOL = [{"type": "function", "function": {"name": "read_page", "description": "Read a web page and return its text (links shown as [url]).",
                "parameters": {"type": "object", "required": ["url"], "properties": {"url": {"type": "string", "description": "Full address or a path on the site."}}}}}]


def chat(model, messages, tools):
    r = post(OLLAMA + "/api/chat", {"model": model, "messages": messages, "tools": tools, "stream": False, "options": {"num_ctx": 16384, "num_predict": 1500, "temperature": 0}}, timeout=600)
    return r.get("message") or {}


def run_task(model, mode, tools, task):
    tid, q, want, forbid, must = task
    msgs = [{"role": "system", "content": SYSTEM},
            {"role": "user", "content": q if mode == "connected" else q + "\n\n(A site that may help: %s)" % SITE}]
    calls, t0 = [], time.time()
    for _ in range(8):
        m = chat(model, msgs, tools)
        msgs.append({k: v for k, v in m.items() if k in ("role", "content", "tool_calls")})
        tcs = m.get("tool_calls") or []
        if not tcs:
            break
        for tc in tcs:
            f = tc.get("function") or {}
            name, args = f.get("name", ""), f.get("arguments") or {}
            if isinstance(args, str):
                try: args = json.loads(args)
                except ValueError: args = {"_raw": args}
            calls.append({"tool": name, "args": args})
            if mode == "browsing":
                out = read_page(args.get("url", ""))
            elif name in NEVER_FORWARD:
                out = "Recorded - thank you. (This is a test run: nothing was actually sent.)"
            else:
                try:
                    res = mcp("tools/call", {"name": name, "arguments": args})
                    out = res["result"]["content"][0]["text"] if "result" in res else "Error: " + json.dumps(res.get("error"))[:300]
                except Exception as e:
                    out = "Error: %s" % e
            msgs.append({"role": "tool", "content": out, "tool_name": name})
    final = (msgs[-1].get("content") or "") if msgs[-1].get("role") == "assistant" else ""
    final = re.sub(r"(?s)<think>.*?</think>", "", final).strip()
    used = {c["tool"] for c in calls}
    why = []
    if mode == "connected":
        if not used & want: why.append("expected %s, used %s" % ("/".join(sorted(want)), ", ".join(c["tool"] for c in calls) or "no tool"))
        if used & forbid: why.append("called %s without being asked to share" % "/".join(sorted(used & forbid)))
        if tid == "share_yes" and "submit_result" in used:
            a = next(c["args"] for c in calls if c["tool"] == "submit_result")
            if not (a.get("model") and a.get("hardware") and isinstance(a.get("results"), list) and len(a["results"]) >= 2): why.append("submit_result missing model, hardware or both results")
    elif calls and not any(re.search(r"/mcp|/api/|llms\.txt|/run/|/check|/test|/measured", json.dumps(c["args"])) for c in calls):
        why.append("never got past the home page")
    if not final: why.append("no final answer")
    elif not re.search(must, final, re.I): why.append("final answer missing what was asked")
    return {"id": tid, "mode": mode, "pass": not why, "why": why, "calls": calls[:10], "answer": final[:600], "seconds": round(time.time() - t0)}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=os.environ.get("LOCALBIT_EVAL_MODEL", "qwen3.8:27b"))
    ap.add_argument("--mode", default="both", choices=["connected", "browsing", "both"])
    ap.add_argument("--only", default="")
    a = ap.parse_args(argv)
    tasks = [t for t in TASKS if not a.only or t[0] in a.only.split(",")]
    mcp("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "localbit-self-test", "version": "1"}})
    listed = mcp("tools/list")["result"]["tools"]
    mcp_tools = [{"type": "function", "function": {"name": t["name"], "description": t.get("description", ""), "parameters": t.get("inputSchema") or {"type": "object", "properties": {}}}} for t in listed]
    results = []
    for mode in (["connected", "browsing"] if a.mode == "both" else [a.mode]):
        for t in tasks:
            r = run_task(a.model, mode, mcp_tools if mode == "connected" else BROWSE_TOOL, t)
            results.append(r)
            print("EVAL %s %-13s %s %s" % (mode, r["id"], "PASS" if r["pass"] else "FAIL", "; ".join(r["why"])), flush=True)
    summary = {m: "%d/%d" % (sum(r["pass"] for r in results if r["mode"] == m), sum(1 for r in results if r["mode"] == m)) for m in {r["mode"] for r in results}}
    OUT.write_text(json.dumps({"date": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"), "model": a.model, "tools_seen": len(listed), "summary": summary, "results": results}, indent=1), encoding="utf-8")
    print("EVAL SUMMARY", json.dumps(summary))


if __name__ == "__main__":
    main()
