"""LocalBit nightly (Windows task "LocalBit 3090 bench", 3:10 AM, via bench/nightly.ps1). Nov 25 - lessons from running a home assistant: a daily
self-check, backups, replay before deploy, and failures written where they're seen. Steps, each failing on its own:
  1 measure (bench/run_3090.py)  2 publish  3 back up LocalBit's log from Cloudflare (D1 export + the asks/reports as JSON)
  4 add new real questions/reports to the replay  5 run every test  6 deploy - only if tests pass and the data changed
  7 check the live site answers  8 write bench/status.json (read by the home assistant's self-check - no alerts)
  python bench/nightly.py [--now] [--skip-bench]"""
import json, os, re, subprocess, sys, time
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
LOG = HERE / "nightly.log"
STATUS = Path(os.environ.get("LOCALBIT_STATUS", HERE / "status.json"))
BACKUPS = ROOT / "backups"
SITE = json.loads((ROOT / "config" / "site.json").read_text(encoding="utf-8"))["site"]
PY = sys.executable
KEEP = 14


def say(*a):
    line = datetime.now().strftime("%H:%M:%S") + " " + " ".join(str(x) for x in a)
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def run(cmd, timeout=7200, shell=False):
    r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=timeout, shell=shell,
                       env=dict(os.environ, CI="true"))
    with open(LOG, "a", encoding="utf-8") as f:
        f.write((r.stdout or "")[-6000:] + (r.stderr or "")[-3000:])
    return r


def npx(args, timeout=600):
    return run("npx " + args, timeout=timeout, shell=True)


def main():
    now_mode, skip = "--now" in sys.argv, "--skip-bench" in sys.argv
    st = {"started": datetime.now().isoformat(timespec="seconds"), "problems": []}
    say("=== nightly")
    before = (ROOT / "data" / "measured.json").read_text(encoding="utf-8") if (ROOT / "data" / "measured.json").exists() else ""
    log_start = LOG.stat().st_size if LOG.exists() else 0
    # 1-2 measure and publish
    if not skip:
        r = run([PY, "bench/run_3090.py", "--max-models", "3"] + (["--now"] if now_mode else []))
        st["bench_exit"] = r.returncode
        if r.returncode:
            st["problems"].append("the measuring run crashed")
    tonight = LOG.read_bytes()[log_start:].decode("utf-8", errors="ignore") if LOG.exists() else ""   # (Nov 26) slice bytes - the log has multi-byte characters
    st["measured_lines"] = len(re.findall(r" gen \d ", tonight))
    st["quiz"] = re.findall(r"(\S+) quiz (\d+) / (\d+)", tonight)
    st["stopped_for_assistant"] = "in use - stopping" in tonight
    fails = re.findall(r"(\S+) .*failed:", tonight) + re.findall(r"download failed", tonight)
    if fails:
        st["problems"].append("%d model step(s) failed" % len(fails))
    if "partly off the graphics card" in tonight:
        st["problems"].append("a run landed partly off the graphics card (left out of the published data)")
    r = run([PY, "bench/publish.py"])
    if r.returncode:
        st["problems"].append("publish failed")
    changed = (ROOT / "data" / "measured.json").read_text(encoding="utf-8") != before
    st["data_changed"] = changed
    # 3 backup
    BACKUPS.mkdir(exist_ok=True)
    day = datetime.now().strftime("%Y%m%d")
    r = npx("wrangler d1 export localbit --remote --output=backups/d1_%s.sql" % day)
    st["backup_ok"] = r.returncode == 0 and (BACKUPS / ("d1_%s.sql" % day)).exists()
    if not st["backup_ok"]:
        st["problems"].append("the log backup from Cloudflare failed")
    for name, sql in (("asks", "SELECT DISTINCT model_q, hw_q, context, quant FROM calls WHERE kind IN ('mcp_call','api','check_page','compare_page') AND model_q IS NOT NULL AND hw_q IS NOT NULL"),
                      ("reports", "SELECT ts, problem, model_q, hw_q, context, obs_tps, obs_mem_gb, runtime, note FROM reports")):
        r = npx('wrangler d1 execute localbit --remote --json --command "%s"' % sql)
        try:
            rows = json.loads(r.stdout[r.stdout.index("["):])[0]["results"]
            (BACKUPS / (name + ".json")).write_text(json.dumps(rows, indent=1), encoding="utf-8")
        except Exception:
            st["problems"].append("couldn't export the %s" % name)
    olds = sorted(BACKUPS.glob("d1_*.sql"))[:-KEEP]
    for f in olds:   # keep two weeks; older ones go to _to_delete (nothing is deleted)
        (ROOT / "_to_delete" / "backups").mkdir(parents=True, exist_ok=True)
        f.replace(ROOT / "_to_delete" / "backups" / f.name)
    # 4 replay cases
    r = run(["node", "bench/build_replay.mjs"])
    m = re.search(r"REPLAY cases (\d+) \(\+(\d+)\).*reports (\d+) \(\+(\d+), open (\d+)\)", r.stdout or "")
    if m:
        st["replay_cases"], st["replay_new"], st["reports"], st["reports_new"], st["reports_open"] = map(int, m.groups())
    # 5 tests
    r = run("npm test", timeout=900, shell=True)
    st["tests_ok"] = r.returncode == 0
    if not st["tests_ok"]:
        st["problems"].append("tests failed - not deployed: " + "; ".join(l.strip() for l in (r.stdout or "").splitlines() if l.startswith("FAIL"))[:300])
    # 6 deploy
    st["deployed"] = False
    if st["tests_ok"] and changed:
        for attempt in (1, 2):
            r = npx("wrangler deploy")
            if r.returncode == 0:
                st["deployed"] = True
                break
            time.sleep(60)
        if not st["deployed"]:
            st["problems"].append("deploy failed twice")
    # 7 live check
    st["site_ok"] = site_ok()
    if not st["site_ok"]:
        st["problems"].append("the live site didn't answer properly")
    st["finished"] = datetime.now().isoformat(timespec="seconds")
    STATUS.write_text(json.dumps(st, indent=1), encoding="utf-8")
    say("nightly done:", "ok" if not st["problems"] else "; ".join(st["problems"]))


def site_ok(site=None):
    import urllib.request
    site = site or SITE
    try:
        req = urllib.request.Request(site + "/mcp", data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}).encode(),
                                     headers={"content-type": "application/json", "accept": "application/json, text/event-stream", "user-agent": "localbit-nightly-check"})
        tools = json.loads(urllib.request.urlopen(req, timeout=20).read())["result"]["tools"]
        ans = json.loads(urllib.request.urlopen(urllib.request.Request(site + "/api/check?model=llama%203.1%208b&hardware=rtx%204060",
                                                                       headers={"user-agent": "localbit-nightly-check"}), timeout=20).read())
        return len(tools) >= 4 and ans.get("verdict") in ("fits", "tight", "does_not_fit")
    except Exception:
        return False


if __name__ == "__main__":
    main()
