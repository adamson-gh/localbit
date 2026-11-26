// LocalBit: every page as HTML, for the phone-width layout test (test/test_mobile.py). node test/dump_pages.mjs <dir>
import fs from "fs";
import worker from "../src/worker.js";
const dir = process.argv[2];
const paths = ["/", "/measured", "/log", "/compare", "/test", "/docs", "/privacy", "/about", "/check?model=llama%203.1%208b&hardware=rtx%204060",
  "/check?model=zephyrion%2040b&hardware=rtx%204090", "/compare?a_model=qwen3%2032b&a_hardware=rtx%204090&b_hardware=m4%20max", "/run/llama-3.1-8b/on/rtx-4060", "/nope"];
let i = 0;
for (const p of paths) {
  const r = await worker.fetch(new Request("https://localbit.example.workers.dev" + p), {}, { waitUntil() {} });
  fs.writeFileSync(`${dir}/p${i++}.html`, `<!-- ${p} -->\n` + await r.text());
}
console.log(paths.length);
