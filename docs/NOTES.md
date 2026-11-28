# LocalBit - how it works, the rules, the lessons

For whoever works on LocalBit next (a person or an AI session). Keep it short and current.

## Parts
- **Worker** (`src/worker.js`, `src/estimate.js`): the site, the JSON API and the MCP server, on Cloudflare Workers.
  Data is bundled at deploy: `data/models.json`, `data/gpus.json`, `data/measured.json`. Settings: `config/site.json` (one place).
- **Log** (Cloudflare D1, `schema.sql`): `calls` (what was asked), `reports` (answers said to be wrong), `errors` (failures).
  Never IP addresses, accounts or anything that identifies a person.
- **Node** (`bench/`): an RTX 3090 on Windows that measures models overnight. `bench/nightly.ps1` -> `bench/nightly.py`:
  measure (`run_3090.py`), quality check (`quiz.py`), publish (`publish.py`), back up the log (`backups/`), add new real
  questions to the replay (`build_replay.mjs`), run every test, deploy only if they pass, check the live site, write
  `bench/status.json`. The machine is shared with a home assistant: the run stops the moment someone uses it from a phone,
  and always reloads the assistant's model afterwards.

## Rules
- Answers say **estimated** (with a likely range) or **measured**, how current the data is, and link a page to cite.
- No IP addresses or personal data anywhere - logs, reports (emails, numbers and links stripped), commits.
- Commit messages: what changed and a `Why:` line; no personal names - the repository is public.
- Tests never write real data files (`data/`, `backups/`); they use temporary copies and made-up models.
- Only models in `bench/approved.txt` are ever downloaded; downloaded ones are removed after measuring.
- One change, one commit; deploy only after `npm test` passes.

## Lessons (from running a home assistant, applied here)
- **Replay real questions before every change.** `test/replay_cases.json` - real asks with the answer they got; a changed
  answer fails the tests. After a deliberate change: `node bench/build_replay.mjs --accept`.
- **Every complaint becomes a test.** `test/report_cases.json` - each report, open until reviewed; once fixed, add an
  `expect` and it is checked forever.
- **Log failures where they're seen.** The `errors` table and turned-away requests show on the owner's stats page;
  the nightly status shows in the home assistant's daily self-check. No phone alerts.
- **Back up what can't be recreated.** The D1 log is exported nightly to `backups/` (two weeks kept).
- **Runtime updates change speeds.** A measurement from a different Ollama version or driver is redone.
- **A run partly off the graphics card measures the wrong thing** - it is logged and left out of the published data.
- **Silent substitutions mislead.** When a name maps to another model or a Mac or multi-card setup is assumed, the answer says so.
- **Check the deploy copy.** Files copied between machines can lag - verify before deploying (tests run on the deploying machine).

## Contributions (0.4, Nov 26)
- `submissions` table (no IPs). Each result is compared with the estimate: ratio 0.35-2.2, on-card, known model and hardware -> status community, otherwise flagged with reasons.
- Nightly exports submissions to backups/submissions.json; bench/publish_community.py keeps community rows, median per model/card/context/quant -> data/community.json, bundled at deploy.
- bench/embed.mjs bundles bench/localbit_test.py into src/generated/test_script.js (run by build and test).
- /stats `formats` and `format_misses` show which formats agents use and ask for.

## Fresh-agent test (Nov 26)
- bench/agent_eval.py: a local model with no knowledge of LocalBit answers 14 realistic questions (typos, two cards, a Mac, an unknown model, sharing with and without a yes) two ways - connected (sees only tools/list) and browsing (only the site address and a read-page tool). submit_result and report_issue are answered by the test itself, never sent. User-agent "localbit-self-test", left out of visitor counts (/stats self_tests counts it). Results in bench/agent_eval.json (not committed).
- Grading checks the answer's numbers against LocalBit's own answer, fetched at run time (speed and memory within 10%, specs exact, top pick, which card is faster). Runs nightly after the live check for the assistant's model and any installed model in bench/config.json eval_models; results per model in bench/agent_eval.json.
- Contributor flow (Nov 26): /api/submit returns url (/run/<model>/on/<card>), whose page lists the pair's last 7 days of submissions from D1 (time, context, speed, accepted/held - nothing else). The script confirms typed or Windows-detected card names against /api/hardware.
- Nov 27: the home page's Ask by URL line has real example links (/check and /api/check for llama3.1:8b on an RTX 3060) - for agents on the website alone; Gemma 4 e4b "never got past the home page" (2/14). Measured in the next nightly fresh-agent run.
- Nov 27: nightly also runs the owner's other public tools' fresh-agent tests with the same model (bench/config.json other_evals: ../localsig/bench/agent_eval.py); results under status.json other_evals.
- Nov 27 (0.5.0, Glama's review 4.5/5): verb_noun names (compare_setups, get_node_log; old names still answer, unlisted); list_known query/limit/offset; receipts (random codes, migrations_2026-11-27_receipts.sql) and get_status. Reports have a status (received / fixed / closed) the owner sets in D1.
- (Nov 28) 0.5.1: gpu_pct (size_vram / size from Ollama's /api/ps) per context in the test and submissions; flagged reason names it. Migration migrations_2026-11-28_gpu_pct.sql.
- (Nov 28) publish.py holds back a measured Ollama tag with no LocalBit model of its own (deepseek-r1:14b: Qwen2.5 14B's design, but its quality score isn't Qwen's) and names it; LOCALBIT_MODELS="" in tests. The night before, its rows went out under the raw tag, the stats test failed and the deploy stopped.
