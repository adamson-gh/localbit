# LocalBit

**Will this AI model run on my hardware?** LocalBit answers with the memory a local model needs (weights + context cache) and how fast it
should generate, for graphics cards and Apple computers - estimated from the model's design and the card's specs, and **measured** where
real results exist. Every answer says which.

## For AI agents
- **MCP** (Streamable HTTP): `https://localbit.adamson-cf.workers.dev/mcp` - listed in the [MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.adamson-gh/localbit`
  - `check_fit(model, hardware, context?, quant?, kv_cache?)` - fits / tight / doesn't fit, memory breakdown, tokens per second, what to change
  - `suggest_models(hardware, context?, min_tokens_per_s?)` - the largest known models that fit
  - `list_known(kind)` - models or hardware LocalBit has specs for
  - `report_issue(problem, ...)` - tell LocalBit an answer was wrong, with what you actually saw
- **JSON API**: `/api/check?model=llama%203.1%208b&hardware=rtx%203090&context=8192`, `/api/suggest?hardware=16%20GB`, `/api/models`, `/api/hardware`, `/api/measured`, `POST /api/report`
- Pages per model and card (`/run/llama-3.1-8b/on/rtx-4060`), `/llms.txt`, `/sitemap.xml`

## How the estimate works
- **Memory** = parameters x bits per weight (by quantization) + the attention cache (layers x KV heads x head size x 2 x context,
  smaller for sliding-window and hybrid layers) + ~0.3 GB + 1% runtime overhead. Discrete cards keep ~0.6 GB back for the desktop;
  Macs can give the GPU ~75% of unified memory.
- **Speed**: generating a token reads every active weight once, so tokens/s ~= efficiency x memory bandwidth / bytes per token.
  Efficiency is calibrated on measured runs (RTX 3090 + Qwen3.8 27B Q4_K_M on Ollama: 47.7 tok/s measured, 45.6 estimated).
  Mixture-of-experts models read only their active experts. A model that doesn't fit is estimated with the rest in system memory.

## What LocalBit records
Which tool was called, the model and hardware named, what they matched, and the calling app's self-reported name - to learn what
people and agents ask about. **No IP addresses, accounts or personal data.** The owner reads totals at `/stats` (key required).

## Data (open - CC BY 4.0)
- `data/models.json`, `data/gpus.json` - the model and hardware tables. Models marked `"verified": false` use their published
  configs and haven't been re-checked against GGUF metadata yet.
- `data/measured.json` - LocalBit's own measurements: an RTX 3090 (Windows, Ollama), each model at 4K / 16K / 32K context,
  3 runs, the middle one published - generation and prompt speed, time to first token, peak memory, power, tokens per joule,
  runtime and driver versions, date. `data/runs_3090.jsonl` holds every raw run.
- How it's measured: `bench/run_3090.py` (fixed made-up prompts, temperature 0, one model on the card at a time) and
  `bench/publish.py`. Runs nightly 3:10-5:00 AM on a machine shared with a home assistant, so it stops early when that's in use.

Use the data freely - credit "LocalBit" with a link here. Corrections welcome: open an issue, or call `report_issue`.

## Privacy
No IP addresses, cookies or accounts. Cloudflare's rate limiter (120 requests a minute per address) sees the address for a
moment; LocalBit never stores it. Report notes have emails, phone numbers and links removed.

## Run it
```
npm install
npm test                 # estimates, the Worker as agents call it, and the bench (against a made-up Ollama)
npx wrangler dev         # local server at http://127.0.0.1:8787
```
Deploy: `npx wrangler login`, `npx wrangler d1 create localbit` (paste the id into wrangler.toml),
`npx wrangler d1 execute localbit --remote --file=schema.sql`, `npx wrangler secret put STATS_KEY`, `npx wrangler deploy`.

## More
How it works, the rules and the lessons: `docs/NOTES.md`. What changed: `CHANGELOG.md`.

## License
Code: MIT (LICENSE). Data in `data/`: CC BY 4.0 (DATA_LICENSE.md).

## Contribute a measurement
Run `python bench/localbit_test.py` (or download it from `/test.py`) with Ollama and a model pulled. It measures with the same recipe as the node, prints what it would send (model, hardware name and memory, speeds, Ollama version, OS - nothing personal) and asks before sending. `--dry-run` never sends.
