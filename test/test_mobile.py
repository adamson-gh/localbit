"""LocalBit: every page at phone width (390 px) in a real browser - nothing wider than the screen, the menu fully on screen.
Needs Playwright with Edge or Chromium (skips if missing). python test/test_mobile.py"""
import subprocess, sys, tempfile
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print("SKIP no Playwright here\n\n0 passed, 0 failed"); sys.exit(0)
d = Path(tempfile.mkdtemp())
subprocess.run(["node", str(ROOT / "test" / "dump_pages.mjs"), str(d)], check=True, capture_output=True)
ok = bad = 0
def check(name, cond, got=""):
    global ok, bad
    ok, bad = (ok + 1, bad) if cond else (ok, bad + 1)
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else "  got: %s" % (got,)))
with sync_playwright() as p:
    b = None
    for kw in ({"channel": "msedge"}, {}):
        try:
            b = p.chromium.launch(**kw); break
        except Exception:
            continue
    if not b:
        print("SKIP no browser for Playwright\n\n0 passed, 0 failed"); sys.exit(0)
    pg = b.new_page(viewport={"width": 390, "height": 844})
    for f in sorted(d.glob("p*.html"), key=lambda x: int(x.stem[1:])):
        path = f.read_text(encoding="utf-8").split("\n", 1)[0][5:-4]
        pg.goto(f.as_uri())
        w = pg.evaluate("document.documentElement.scrollWidth")
        wide = pg.evaluate("""() => [...document.querySelectorAll('body *')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > innerWidth + 1 && getComputedStyle(e).overflowX === 'visible' && !e.closest('.scroll') })
                               .slice(0, 3).map(e => e.tagName + ':' + (e.textContent || '').trim().slice(0, 40))""")
        check("%s fits the phone screen" % path, w <= 391 and not wide, "%spx wide; %s" % (w, wide))
        if path == "/":
            nav = pg.evaluate("Math.max(...[...document.querySelectorAll('nav a')].map(a => a.getBoundingClientRect().right))")
            check("the menu is fully on screen", nav <= 390, nav)
    b.close()
print("\n%d passed, %d failed" % (ok, bad)); sys.exit(1 if bad else 0)
