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
import json, os, platform, re, statistics, subprocess, sys, time, urllib.error, urllib.parse, urllib.request

SITE = os.environ.get("LOCALBIT_SITE", "https://localbit.adamson-cf.workers.dev")
OLLAMA = os.environ.get("LOCALBIT_OLLAMA", "http://127.0.0.1:11434")
VERSION = "3"


def interactive():
    """A real keyboard is attached. (Nov 26: on Windows the NUL device counts as a terminal to isatty(), so a hidden run waited on
    a question) on Windows only a real console has a console mode."""
    if not sys.stdin or not sys.stdin.isatty():
        return False
    if os.name == "nt":
        try:
            import ctypes
            k = ctypes.windll.kernel32; mode = ctypes.c_uint32()
            return bool(k.GetConsoleMode(k.GetStdHandle(-10), ctypes.byref(mode)))
        except Exception:
            return False
    return True


def ask_line(prompt, default=""):
    """input(), but no keyboard (or Ctrl+Z / end of input) gives the default instead of an error."""
    try:
        return input(prompt)
    except EOFError:
        return default


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
        a = ask("Number (or Enter to keep '%s'): " % hw["hardware"]).strip() if (ask is not input or interactive()) else ""
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
        return {"hardware": name, "memory_gb": float(mem), "cards": int(n), "via": "test settings"}
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=15).stdout.strip().splitlines()
        if out:
            names = [l.split(",")[0].strip() for l in out]; mem = round(float(out[0].split(",")[1]) / 1024, 1)
            return {"hardware": names[0], "memory_gb": mem, "cards": len(names), "via": "nvidia-smi"}
    except Exception:
        pass
    if platform.system() == "Darwin":
        try:
            chip = subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"], capture_output=True, text=True, timeout=10).stdout.strip()
            mem = int(subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True, timeout=10).stdout.strip()) / 2**30
            return {"hardware": "%s %d GB" % (chip, round(mem)), "memory_gb": round(mem), "cards": 1, "via": "macOS system info"}
        except Exception:
            pass
    try:
        out = subprocess.run(["rocm-smi", "--showproductname"], capture_output=True, text=True, timeout=15).stdout
        m = re.search(r"Card (?:series|SKU)\s*:\s*(.+)", out)
        if m:
            return {"hardware": m.group(1).strip(), "memory_gb": None, "cards": 1, "via": "rocm-smi"}
    except Exception:
        pass
    if platform.system() == "Windows":   # AMD and Intel cards on Windows: the name Windows shows in Device Manager (its memory figure isn't reliable)
        try:
            out = subprocess.run(["powershell", "-NoProfile", "-Command", "(Get-CimInstance Win32_VideoController).Name"], capture_output=True, text=True, timeout=20).stdout
            names = [l.strip() for l in out.splitlines() if l.strip() and not re.search(r"(?i)basic|virtual|remote|parsec|meta", l)]
            if names:
                return {"hardware": names[0], "memory_gb": None, "cards": 1, "unsure": True, "via": "Windows' device list"}
        except Exception:
            pass
    return {"hardware": ask_line("Graphics card or Mac (e.g. 'RTX 4060' or 'M2 Pro 32 GB'): ").strip(), "memory_gb": None, "cards": 1, "via": "typed"}


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


FILE_BYTES = {}   # model -> its size on disk (/api/tags), filled in main()


def gpu_share(ps, file_bytes=0):
    """Percent of the model in the card's memory from /api/ps. (Nov 28, owner's spill test: a model forced half onto the processor
    with num_gpu showed size == size_vram = 223 MB, "100% GPU", for a 6.1 GB model - Ollama's llama.cpp runner leaves the layers it
    keeps on the processor out of "size".) A loaded size under 60% of the file means the rest is outside the card: count against
    the file instead."""
    size, vram = ps.get("size") or 0, ps.get("size_vram") or 0
    denom = file_bytes if file_bytes and size < 0.6 * file_bytes else size
    return max(0, min(100, round(100.0 * vram / denom))) if denom else None


def on_card(model):
    """True/False whether the loaded copy sits fully in the card's memory; None when Ollama doesn't say."""
    try:
        m = next((m for m in http(OLLAMA + "/api/ps", timeout=10).get("models", []) if m.get("name") == model), None)
    except Exception:
        return None
    if not m:
        return None
    pct = gpu_share(m, FILE_BYTES.get(model, 0))
    return None if pct is None else pct >= 99


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
    print("    Also loaded in Ollama, sharing the card's memory: %s." % names)
    if ask is input and not interactive():
        print("    (Not unloading them - numbers may come out low.)"); return
    if (ask_line if ask is input else ask)("    Unload them for a fair test? They load again the next time you use them. [Y/n] ").strip().lower() in ("", "y", "yes"):
        for m in others:
            unload(m["name"])
        print("    Unloaded %s" % ("✓" if FANCY else "ok"))


def stopped(what, why):
    """(Nov 26, owner's phi4 run ended flush-left with no way on) a failure ends like a finished run: what happened, then next steps."""
    print("\n    " + yellow(what))
    print("\n " + dim(LINE * 72))
    print(" " + bold("Stopped - nothing was sent."))
    print(" " + why)
    print("\n " + bold("Next"))
    print("    %s %-22s %s" % (DOT, "Test another model", "run the same line again and pick a different one"))
    print("    %s %-22s %s" % (DOT, "Still stuck?", "%s/suggest - tell LocalBit what happened" % SITE))
    print()


def main():
    try:
        return run()
    except urllib.error.HTTPError as e:   # (Nov 26) a model Ollama can't run: say so plainly, no traceback
        stopped("Ollama couldn't run this model (error %d)." % e.code, "It may not be a text model, or Ollama's runner crashed on it - it happens with some models on some Ollama versions.")
        return 1
    except urllib.error.URLError:
        stopped("Lost contact with Ollama at %s." % OLLAMA, "Is Ollama still running? Start it and try again.")
        return 1
    except RuntimeError as e:
        stopped("Ollama reported a problem with this model: %s" % str(e)[:160], "Try a different model.")
        return 1
    except KeyboardInterrupt:
        stopped("You stopped the test.", "No problem - run it again any time.")
        return 1


# ---------- what the person sees (Nov 26, owner: "Add some transparency. Show what it's doing. Give the user an experience.") ----------
TTY = sys.stdout.isatty() and not os.environ.get("NO_COLOR")
if TTY and os.name == "nt":   # let Windows consoles show colours
    try:
        import ctypes
        k = ctypes.windll.kernel32; h = k.GetStdHandle(-11); mode = ctypes.c_uint32()
        if k.GetConsoleMode(h, ctypes.byref(mode)):
            k.SetConsoleMode(h, mode.value | 4)
    except Exception:
        pass


def _can(s):
    try:
        s.encode(sys.stdout.encoding or "ascii"); return True
    except (UnicodeEncodeError, LookupError):
        return False


FANCY = TTY and _can("▕█░✓·─")
OK, DOT, LINE, FULL, EMPTY = ("✓", "·", "─", "█", "░") if FANCY else ("ok", "-", "-", "#", ".")


def c(code, s):
    return "\033[%sm%s\033[0m" % (code, s) if TTY else s


bold, dim, green, yellow = (lambda s: c("1", s)), (lambda s: c("2", s)), (lambda s: c("32", s)), (lambda s: c("33", s))


def step(n, title, value="", note=""):
    print("\n %s  %s %s%s" % (bold(str(n)), bold("%-15s" % title), value, ("   " + dim(note)) if note else ""), flush=True)


def say(s="", note=""):
    print("    " + s + (("   " + dim(note)) if note else ""), flush=True)


def gb(n):
    return "%.1f GB" % (n / 2**30)


def gen_live(model, prompt, ctx, predict, thinks, label):
    """One timed run, streamed so the person watches it write: a bar fills as tokens arrive; the speed is Ollama's own timing."""
    body = {"model": model, "prompt": prompt, "stream": True, "keep_alive": "10m",
            "options": {"num_ctx": ctx, "num_predict": predict, "temperature": 0, "seed": 7}}
    if thinks:
        body["think"] = False
    req = urllib.request.Request(OLLAMA + "/api/generate", json.dumps(body).encode(), {"content-type": "application/json", "user-agent": "localbit-test/" + VERSION})
    n, t0, final, width = 0, time.time(), {}, 24
    with urllib.request.urlopen(req, timeout=900) as r:
        for line in r:
            if not line.strip():
                continue
            j = json.loads(line.decode())
            if j.get("error"):
                raise RuntimeError(j["error"])
            if j.get("response") or j.get("thinking"):
                n += 1
                if TTY and n % 4 == 0:
                    el = max(time.time() - t0, 1e-3); fill = min(width, int(width * n / max(predict, 1)))
                    print("\r    %s  %s%s  %3d tokens  %5.1f tokens/s " % (label, FULL * fill, EMPTY * (width - fill), n, n / el), end="", flush=True)
            if j.get("done") or "eval_count" in j:
                final = j
    tps = final["eval_count"] / (final["eval_duration"] / 1e9) if final.get("eval_duration") else None
    bar = FULL * width
    line = "    %s  %s  %3d tokens  %s" % (label, bar if FANCY else "", final.get("eval_count") or n, bold("%5.1f tokens/s" % tps) if tps else "no timing")
    print(("\r" if TTY else "") + line + " " * 4, flush=True)
    return tps, final


def run():
    args = sys.argv[1:]
    dry = "--dry-run" in args
    model = args[args.index("--model") + 1] if "--model" in args else None
    t_start = time.time()
    print("\n " + bold("LocalBit") + "  " + "measure your hardware")
    print(" " + dim("Same recipe as LocalBit's RTX 3090 node. Talks only to your own Ollama; nothing is sent unless you say yes at the end."))
    print(" " + dim(LINE * 72))
    hw = hardware()
    if not os.environ.get("LOCALBIT_FAKE_GPU"):
        hw = settle(hw)
    step(1, "Your hardware", "%s%s%s" % (hw["hardware"], (" %s %s GB" % (DOT, ("%g" % hw["memory_gb"]))) if hw.get("memory_gb") else "", (" x%d" % hw["cards"]) if hw.get("cards", 1) > 1 else ""),
         "read with %s" % hw.get("via", "?"))
    try:
        tag_rows = http(OLLAMA + "/api/tags", timeout=10).get("models", [])
    except Exception:
        print("\nCouldn't reach Ollama at %s - is it running?" % OLLAMA); return 2
    sizes = {m["name"]: m.get("size", 0) for m in tag_rows}
    FILE_BYTES.update(sizes)
    tags = [m["name"] for m in tag_rows]
    try:
        ver = http(OLLAMA + "/api/version", timeout=10).get("version")
    except Exception:
        ver = None
    if not tags:
        print("\nOllama has no models yet - pull one first, e.g. 'ollama pull llama3.1:8b'."); return 2
    texts = text_models(tags)
    step(2, "Ollama", "version %s %s %d text model%s" % (ver or "?", DOT, len(texts), "" if len(texts) == 1 else "s"),
         ("%d embedding model%s left out - they can't write text" % (len(tags) - len(texts), "" if len(tags) - len(texts) == 1 else "s")) if len(tags) > len(texts) else "")
    if not model:
        if not texts:
            print("\nNone of your Ollama models write text (embedding models can't be measured) - pull one first, e.g. 'ollama pull llama3.1:8b'."); return 2
        for i, t in enumerate(texts, 1):
            say("%2d. %-28s %s" % (i, t, dim(gb(sizes.get(t, 0)) if sizes.get(t) else "")))
        pick = ask_line("    Which model to test (number)? ").strip()
        model = texts[int(pick) - 1] if pick.isdigit() and 0 < int(pick) <= len(texts) else texts[0]
    if model not in tags:
        print("\n%s isn't in Ollama on this machine." % model); return 2
    R = recipe()
    show = http(OLLAMA + "/api/show", {"model": model}, timeout=30)
    thinks = "thinking" in (show.get("capabilities") or [])
    det = show.get("details") or {}
    quant = det.get("quantization_level")
    G = next(t for t in R["tests"] if t["name"] == "gen")
    P = next(t for t in R["tests"] if t["name"] == "prompt_4k")
    step(3, "Getting ready", "%s %s %s%s" % (model, DOT, det.get("parameter_size") or "", (" %s %s" % (DOT, quant)) if quant else ""),
         "%d contexts x %d runs of %d tokens, plus one long document" % (len(R["contexts"]), G["runs"], G["num_predict"]))
    free_card(model)
    # (Nov 26 diagnostic: the model was already loaded by another program on the processor only, and a test at the same context
    # reused that copy - 25 instead of 150 tokens/s) start from a fresh load, as the node does; it reloads on its own when next used
    unload(model)
    say("Starting from a fresh copy of the model, so every run is measured the same way", OK)
    results, n = [], 4
    for ctx in R["contexts"]:
        step(n, "Writing speed", "%s-token context" % format(ctx, ","), "how many tokens a second it writes - the speed you feel in a chat" if ctx == R["contexts"][0] else "a longer conversation's worth of room"); n += 1
        t0 = time.time()
        gen(model, "Hi", ctx, 1, thinks)   # load the model at this context first, so loading isn't measured
        where = on_card(model)
        if where is False:   # still the processor copy (or it doesn't fit): reload once and look again
            unload(model); gen(model, "Hi", ctx, 1, thinks); where = on_card(model)
        say("Loaded in %.1f s %s %s" % (time.time() - t0, DOT, green("fully in the card's memory " + OK) if where else
                                       (yellow("partly in system memory - slower, and the real speed for this setup") if where is False else "placement not reported")))
        speeds = []
        for i in range(G["runs"]):
            tps, _ = gen_live(model, G["prompt"], ctx, G["num_predict"], thinks, "run %d" % (i + 1))
            if tps:
                speeds.append(tps)
        row = {"context": ctx, "gen_tps": round(statistics.median(speeds), 2) if speeds else None}
        if speeds:
            say("Middle of %d runs: %s %s about %d words a second" % (len(speeds), bold("%.1f tokens/s" % row["gen_tps"]), DOT, round(row["gen_tps"] * 0.75)),
                "people read about 4" if ctx == R["contexts"][0] else "")
        if ctx in P.get("contexts", []):
            step(n, "Reading speed", "a %s-word document" % format(int(round(P["repeat"] * len(P["prompt_repeat"].split()), -2)), ","),
                 "how fast it takes in what you give it - long files, chat history"); n += 1
            r = gen(model, P["prompt_repeat"] * P["repeat"] + P["suffix"], ctx, P["num_predict"], thinks)
            if r.get("prompt_eval_duration"):
                row["prompt_tps"] = round(r["prompt_eval_count"] / (r["prompt_eval_duration"] / 1e9), 1)
                say("%s %s waits %.1f s before the first word" % (bold("%s tokens/s" % format(int(row["prompt_tps"]), ",")), DOT, r["prompt_eval_count"] / row["prompt_tps"]))
        try:
            ps = next((m for m in http(OLLAMA + "/api/ps", timeout=10).get("models", []) if m["name"] == model), None)
            if ps:
                # (Nov 28, a builder on r/ollama: "Does a result also record how much of the model ran on GPU versus CPU?") the share,
                # not just yes/no - it explains a slow result on a model that only just fits. Apple Silicon shares one memory: always 100.
                pct = gpu_share(ps, FILE_BYTES.get(model, 0))
                row["loaded_gb"] = round(ps.get("size", 0) / 2**30, 2)
                if pct is not None:
                    row["gpu_pct"] = pct
                    row["all_on_gpu"] = pct >= 99
        except Exception:
            pass
        results.append(row)
    took = time.time() - t_start
    print("\n " + dim(LINE * 72))
    print(" " + bold("Your results") + "  " + dim("%s on %s %s took %d min %02d s" % (model, hw["hardware"], DOT, took // 60, took % 60)))
    for r in results:
        say("%-16s %s%s%s" % ("%s context" % format(r["context"], ","), bold("%.1f tokens/s" % r["gen_tps"]) if r.get("gen_tps") else "-",
                              ("   reading %s tokens/s" % format(int(r["prompt_tps"]), ",")) if r.get("prompt_tps") else "",
                              "" if r.get("all_on_gpu") in (True, None) else yellow("   %s on the graphics card, the rest in system memory" % (
                                  "%d%%" % r["gpu_pct"] if r.get("gpu_pct") is not None else "partly"))))
    sub = {"recipe_version": R.get("recipe_version"), "model": model, "quant": quant, "hardware": hw["hardware"], "memory_gb": hw["memory_gb"],
           "cards": hw["cards"], "runtime": "Ollama " + str(ver or "?"), "os": platform.system(), "results": results, "client": "localbit-test/" + VERSION}
    # (Nov 26, owner: "it leaves me at the bottom with numbers on the screen ... can we finish it better?") a readable list of
    # everything that would be sent (the exact data with --json or --dry-run), then a closing block with where to go next
    res = " · ".join("%s: %.1f tokens/s%s" % (format(r["context"], ","), r["gen_tps"] or 0, (", reading %s" % format(int(r["prompt_tps"]), ",")) if r.get("prompt_tps") else "") for r in results)
    print("\n " + bold("What would be sent - all of it:"))
    for k, v in (("model", "%s%s" % (model, (" %s %s" % (DOT, quant)) if quant else "")),
                 ("hardware", "%s%s %s %d card%s" % (hw["hardware"], (" %s %g GB" % (DOT, hw["memory_gb"])) if hw.get("memory_gb") else "", DOT, hw["cards"], "" if hw["cards"] == 1 else "s")),
                 ("software", "Ollama %s %s %s" % (ver or "?", DOT, platform.system())), ("results", res),
                 ("also", "how much of it was on the graphics card, how much was loaded, recipe version %s" % R.get("recipe_version"))):
        say("%-10s %s" % (k, v))
    say(dim("Never names, usernames, file paths, IP addresses or serial numbers.") + ("" if (dry or "--json" in args) else dim("  (add --json to see the exact data)")))
    if dry or "--json" in args:
        print()
        print("\n".join("    " + l for l in json.dumps(sub, indent=1).splitlines()))
    page = "%s/check?model=%s&hardware=%s" % (SITE, urllib.parse.quote(model), urllib.parse.quote(hw["hardware"]))
    first = results[0] if results else {}
    headline = "%s on %s: %s tokens/s - about %d words a second." % (model, hw["hardware"], ("%.1f" % first["gen_tps"]) if first.get("gen_tps") else "?", round((first.get("gen_tps") or 0) * 0.75))

    def close(done, nexts):
        print("\n " + dim(LINE * 72))
        print(" " + bold(done))
        print(" " + headline)
        print("\n " + bold("Next"))
        for a, b in nexts:
            say("%s %-22s %s" % (DOT, a, b))
        print()

    if dry:
        close("Done - dry run, nothing was sent.", [("See LocalBit's answer", page), ("Test another model", "py t.py" if os.name == "nt" else "python3 t.py"),
                                                   ("Share for real", "run it again without --dry-run")])
        return 0
    if ask_line("\n Share these numbers with LocalBit? They become public, anonymous open data. [y/N] ").strip().lower() not in ("y", "yes"):
        close("Done - nothing was sent. Thanks for testing!", [("See LocalBit's answer", page), ("Test another model", "py t.py" if os.name == "nt" else "python3 t.py"),
                                           ("Changed your mind?", "run it again and answer y")])
        return 0
    try:
        ans = http(SITE + "/api/submit", sub, timeout=30)
    except Exception as e:
        print(" Couldn't send (%s) - nothing was shared." % type(e).__name__)
        close("Done - nothing was sent (couldn't reach LocalBit).", [("Try again later", "py t.py" if os.name == "nt" else "python3 t.py")])
        return 1
    print("\n " + ans.get("answer", json.dumps(ans)))
    for r in ans.get("rows") or []:   # how the result compares with what LocalBit predicted
        if r.get("est_tps") and r.get("gen_tps"):
            d = 100 * (r["gen_tps"] - r["est_tps"]) / r["est_tps"]
            say("%s context: you measured %.1f, LocalBit estimated %.1f %s %s" % (format(r["context"], ","), r["gen_tps"], r["est_tps"], DOT,
                "spot on" if abs(d) < 5 else ("%d%% %s than estimated" % (abs(d), "faster" if d > 0 else "slower"))))
    nexts = [("Your result", ans["url"])] if ans.get("url") else [("See LocalBit's answer", page)]
    nexts += [("Share it", "post the link - it helps the next person with your hardware decide to test"), ("Test another model", "py t.py" if os.name == "nt" else "python3 t.py")]
    close("Done - thank you. Your numbers are in." if ans.get("status") == "community" else "Done - sent, and held for a quick review before it's published.", nexts)
    return 0


if __name__ == "__main__":
    sys.exit(main())
