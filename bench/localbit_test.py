#!/usr/bin/env python3
"""LocalBit's 3-minute test - measure a local AI model on YOUR machine, the same way LocalBit's own RTX 3090 node does, and
(only if you say yes) share the numbers so everyone gets real results for your hardware.

    python3 t.py                      pick a model you already have in Ollama (Windows: py t.py)
    python3 t.py --model llama3.1:8b  test that one
    python3 t.py --dry-run            measure and show what would be sent, send nothing

What it does: talks to your local Ollama (http://127.0.0.1:11434) only, runs the published recipe (localbit .../recipe.json),
reads your graphics card's or Mac's name and memory size. Before anything leaves your computer it prints exactly what would be
sent and asks. It never sends names, usernames, file paths, IP addresses, hostnames or serial numbers. Python 3.8+, nothing to
install. Source: https://github.com/adamson-gh/localbit (MIT)."""
import json, os, platform, re, statistics, subprocess, sys, time, urllib.error, urllib.request

SITE = os.environ.get("LOCALBIT_SITE", "https://localbit.adamson-cf.workers.dev")
OLLAMA = os.environ.get("LOCALBIT_OLLAMA", "http://127.0.0.1:11434")
VERSION = "1"


def http(url, body=None, timeout=900):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers={"content-type": "application/json", "user-agent": "localbit-test/" + VERSION})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def recipe():
    local = os.environ.get("LOCALBIT_RECIPE")
    if local:
        return json.load(open(local, encoding="utf-8"))
    return http(SITE + "/recipe.json", timeout=30)


def squash(s):
    return re.sub(r"[^a-z0-9]", "", re.sub(r"(?i)\b(nvidia|geforce|amd|radeon|intel|apple|graphics)\b", "", s.lower()))


def candidates(name, known):
    """LocalBit's own names that match what was detected or typed: exact first, then every word of it found in the name."""
    sq = squash(name)
    exact = [k for k in known if squash(k["name"]) == sq or any(squash(a) == sq for a in k.get("aliases", []))]
    if exact:
        return exact[:1]
    words = [w for w in re.findall(r"[a-z]+|\d+", name.lower()) if w not in ("nvidia", "geforce", "amd", "radeon", "intel", "apple", "graphics", "gb")]
    return [k for k in known if words and all(w in squash(k["name"]) for w in words)][:8]


def settle(hw, known=None, ask=input):
    """When the name came from typing or Windows (not nvidia-smi or a Mac), confirm it against LocalBit's card list, so a typo
    doesn't turn a good result into a flagged one. Offline or no match: keep what was given."""
    if not hw.get("unsure") and hw.get("memory_gb"):
        return hw
    try:
        known = known if known is not None else http(SITE + "/api/hardware", timeout=20).get("hardware", [])
    except Exception:
        return hw
    c = candidates(hw["hardware"], known)
    if len(c) == 1:
        pick = c[0]
    elif c:
        print("Which of these is it?")
        for i, k in enumerate(c, 1):
            print("%2d. %s (%s GB)" % (i, k["name"], k.get("vram_gb")))
        a = ask("Number (or Enter to keep '%s'): " % hw["hardware"]).strip() if (ask is not input or sys.stdin.isatty()) else ""
        pick = c[int(a) - 1] if a.isdigit() and 1 <= int(a) <= len(c) else None
    else:
        pick = None
    if pick:
        hw = dict(hw, hardware=pick["name"], memory_gb=hw.get("memory_gb") or pick.get("vram_gb"))
    hw.pop("unsure", None)
    return hw


def hardware():
    """The card or Mac name and memory only - read from nvidia-smi / rocm-smi / macOS system info. Nothing else."""
    if os.environ.get("LOCALBIT_FAKE_GPU"):
        name, mem, n = os.environ["LOCALBIT_FAKE_GPU"].split("|")
        return {"hardware": name, "memory_gb": float(mem), "cards": int(n)}
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=15).stdout.strip().splitlines()
        if out:
            names = [l.split(",")[0].strip() for l in out]; mem = round(float(out[0].split(",")[1]) / 1024, 1)
            return {"hardware": names[0], "memory_gb": mem, "cards": len(names)}
    except Exception:
        pass
    if platform.system() == "Darwin":
        try:
            chip = subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"], capture_output=True, text=True, timeout=10).stdout.strip()
            mem = int(subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True, timeout=10).stdout.strip()) / 2**30
            return {"hardware": "%s %d GB" % (chip, round(mem)), "memory_gb": round(mem), "cards": 1}
        except Exception:
            pass
    try:
        out = subprocess.run(["rocm-smi", "--showproductname"], capture_output=True, text=True, timeout=15).stdout
        m = re.search(r"Card (?:series|SKU)\s*:\s*(.+)", out)
        if m:
            return {"hardware": m.group(1).strip(), "memory_gb": None, "cards": 1}
    except Exception:
        pass
    if platform.system() == "Windows":   # AMD and Intel cards on Windows: the name Windows shows in Device Manager (its memory figure isn't reliable)
        try:
            out = subprocess.run(["powershell", "-NoProfile", "-Command", "(Get-CimInstance Win32_VideoController).Name"], capture_output=True, text=True, timeout=20).stdout
            names = [l.strip() for l in out.splitlines() if l.strip() and not re.search(r"(?i)basic|virtual|remote|parsec|meta", l)]
            if names:
                return {"hardware": names[0], "memory_gb": None, "cards": 1, "unsure": True}
        except Exception:
            pass
    return {"hardware": input("Graphics card or Mac (e.g. 'RTX 4060' or 'M2 Pro 32 GB'): ").strip(), "memory_gb": None, "cards": 1}


def gen(model, prompt, ctx, predict, thinks):
    body = {"model": model, "prompt": prompt, "stream": False, "keep_alive": "10m",
            "options": {"num_ctx": ctx, "num_predict": predict, "temperature": 0, "seed": 7}}
    if thinks:
        body["think"] = False
    r = http(OLLAMA + "/api/generate", body)
    if r.get("error"):
        raise RuntimeError(r["error"])
    return r


def text_models(tags):
    """(Nov 26, owner's own run: an embedding model in the list failed with a 400) only models that write text can be measured."""
    out = []
    for t in tags:
        try:
            caps = http(OLLAMA + "/api/show", {"model": t}, timeout=30).get("capabilities")
        except Exception:
            caps = None
        if caps is not None and "completion" not in caps:
            continue
        if caps is None and re.search(r"(?i)embed", t):
            continue
        out.append(t)
    return out


def unload(name, wait=20):
    """Ask Ollama to unload a model and wait until it's really gone (the request returns before the old copy stops - Nov 26:
    a test reused a processor copy in that gap)."""
    try:
        http(OLLAMA + "/api/generate", {"model": name, "keep_alive": 0}, timeout=60)
    except Exception:
        return
    end = time.time() + wait
    while time.time() < end:
        try:
            if not any(m.get("name") == name for m in http(OLLAMA + "/api/ps", timeout=10).get("models", [])):
                return
        except Exception:
            return
        time.sleep(0.5)


def on_card(model):
    """True/False whether the loaded copy sits fully in the card's memory; None when Ollama doesn't say."""
    try:
        m = next((m for m in http(OLLAMA + "/api/ps", timeout=10).get("models", []) if m.get("name") == model), None)
    except Exception:
        return None
    return None if not m else m.get("size_vram", 0) >= m.get("size", 1)


def free_card(model, ask=input):
    """(Nov 26, owner's own run: a model already loaded shared the card and the first context ran at a sixth of its speed) the node
    measures with nothing else loaded - offer to unload the others (they reload the next time they're used)."""
    try:
        others = [m for m in http(OLLAMA + "/api/ps", timeout=10).get("models", []) if m.get("name") != model]
    except Exception:
        return
    if not others:
        return
    names = ", ".join("%s (%.1f GB)" % (m["name"], m.get("size", 0) / 2**30) for m in others)
    print("Also loaded in Ollama, sharing the card's memory: %s." % names)
    if not sys.stdin.isatty() and ask is input:
        print("(Not unloading them - numbers may come out low.)\n"); return
    if ask("Unload them for a fair test? They load again the next time you use them. [Y/n] ").strip().lower() in ("", "y", "yes"):
        for m in others:
            unload(m["name"])
        print("Unloaded.\n")


def main():
    try:
        return run()
    except urllib.error.HTTPError as e:   # (Nov 26) a model Ollama can't run: say so plainly, no traceback
        print("\nOllama couldn't run this model (error %d). It may not be a text model, or it crashed - try another one. Nothing was sent." % e.code)
        return 1
    except urllib.error.URLError:
        print("\nLost contact with Ollama at %s - is it still running? Nothing was sent." % OLLAMA)
        return 1
    except RuntimeError as e:
        print("\nOllama reported a problem with this model: %s. Try another one. Nothing was sent." % str(e)[:200])
        return 1
    except KeyboardInterrupt:
        print("\nStopped. Nothing was sent.")
        return 1


def run():
    args = sys.argv[1:]
    dry = "--dry-run" in args
    model = args[args.index("--model") + 1] if "--model" in args else None
    try:
        tags = [m["name"] for m in http(OLLAMA + "/api/tags", timeout=10).get("models", [])]
    except Exception:
        print("Couldn't reach Ollama at %s - is it running?" % OLLAMA); return 2
    if not tags:
        print("Ollama has no models yet - pull one first, e.g. 'ollama pull llama3.1:8b'."); return 2
    if not model:
        tags = text_models(tags)
        if not tags:
            print("None of your Ollama models write text (embedding models can't be measured) - pull one first, e.g. 'ollama pull llama3.1:8b'."); return 2
        for i, t in enumerate(tags, 1):
            print("%2d. %s" % (i, t))
        pick = input("Which model to test (number)? ").strip()
        model = tags[int(pick) - 1] if pick.isdigit() and 0 < int(pick) <= len(tags) else tags[0]
    if model not in tags and model not in [m["name"] for m in http(OLLAMA + "/api/tags", timeout=10).get("models", [])]:
        print("%s isn't in Ollama on this machine." % model); return 2
    R = recipe()
    show = http(OLLAMA + "/api/show", {"model": model}, timeout=30)
    thinks = "thinking" in (show.get("capabilities") or [])
    quant = (show.get("details") or {}).get("quantization_level")
    hw = hardware()
    if not os.environ.get("LOCALBIT_FAKE_GPU"):
        hw = settle(hw)
    try:
        ver = http(OLLAMA + "/api/version", timeout=10).get("version")
    except Exception:
        ver = None
    free_card(model)
    # (Nov 26 diagnostic: the model was already loaded by another program on the processor only, and a test at the same context
    # reused that copy - 25 instead of 150 tokens/s) start from a fresh load, as the node does; it reloads on its own when next used
    unload(model)
    print("\nTesting %s on %s - about 3 minutes. Close other heavy programs for a fair result.\n" % (model, hw["hardware"]))
    G = next(t for t in R["tests"] if t["name"] == "gen")
    P = next(t for t in R["tests"] if t["name"] == "prompt_4k")
    results = []
    for ctx in R["contexts"]:
        speeds = []
        gen(model, "Hi", ctx, 1, thinks)   # load the model at this context first, so loading isn't measured
        if on_card(model) is False:   # still the processor copy (or it doesn't fit): reload once and look again
            unload(model); gen(model, "Hi", ctx, 1, thinks)
            if on_card(model) is False:
                print("  (at %d context the model doesn't fit fully in the card's memory - this is the real speed for your hardware)" % ctx)
        for i in range(G["runs"]):
            r = gen(model, G["prompt"], ctx, G["num_predict"], thinks)
            if r.get("eval_duration"):
                speeds.append(r["eval_count"] / (r["eval_duration"] / 1e9))
            print("  context %d, run %d: %.1f tokens/s" % (ctx, i + 1, speeds[-1] if speeds else 0))
        row = {"context": ctx, "gen_tps": round(statistics.median(speeds), 2) if speeds else None}
        if ctx in P.get("contexts", []):
            r = gen(model, P["prompt_repeat"] * P["repeat"] + P["suffix"], ctx, P["num_predict"], thinks)
            if r.get("prompt_eval_duration"):
                row["prompt_tps"] = round(r["prompt_eval_count"] / (r["prompt_eval_duration"] / 1e9), 1)
        try:
            ps = next((m for m in http(OLLAMA + "/api/ps", timeout=10).get("models", []) if m["name"] == model), None)
            if ps:
                row["all_on_gpu"] = ps.get("size_vram", 0) >= ps.get("size", 1)
                row["loaded_gb"] = round(ps.get("size", 0) / 2**30, 2)
        except Exception:
            pass
        results.append(row)
    sub = {"recipe_version": R.get("recipe_version"), "model": model, "quant": quant, "hardware": hw["hardware"], "memory_gb": hw["memory_gb"],
           "cards": hw["cards"], "runtime": "Ollama " + str(ver or "?"), "os": platform.system(), "results": results, "client": "localbit-test/" + VERSION}
    print("\nThis is everything that would be sent to LocalBit:\n")
    print(json.dumps(sub, indent=1))
    if dry:
        print("\n(--dry-run: nothing sent.)"); return 0
    if input("\nShare these numbers with LocalBit? They become public, anonymous open data. [y/N] ").strip().lower() not in ("y", "yes"):
        print("Not sent. Thanks for testing!"); return 0
    try:
        ans = http(SITE + "/api/submit", sub, timeout=30)
        print("\n" + ans.get("answer", json.dumps(ans)))
        if ans.get("url"):
            print("\nYour result: %s\n(Share it if you like - it helps the next person with your hardware decide to test too.)" % ans["url"])
    except Exception as e:
        print("Couldn't send (%s) - nothing was shared." % type(e).__name__); return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
