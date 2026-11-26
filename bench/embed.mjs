// Builds src/generated/test_script.js from bench/localbit_test.py so the Worker can serve /test.py. Run by `npm test` and by
// wrangler's [build] step before every deploy, so the served script always matches the one in the repo.
import fs from "fs";
const src = fs.readFileSync(new URL("./localbit_test.py", import.meta.url), "utf8");
fs.writeFileSync(new URL("../src/generated/test_script.js", import.meta.url),
  "// generated from bench/localbit_test.py by bench/embed.mjs - do not edit\nexport default " + JSON.stringify(src) + ";\n");
console.log("embedded localbit_test.py (" + src.length + " chars)");
