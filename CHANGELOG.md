# Changelog

## 0.5.0 - 2026-11-27
- Tool names follow verb_noun: compare -> compare_setups, node_log -> get_node_log (the old names still answer, unlisted).
- list_known takes query, limit and offset (filter and pages, with total and next_offset).
- submit_result and report_issue return a random receipt; new get_status(receipt) says accepted / held for review, or received / fixed / closed.

## 0.4.1 - 2026-11-26
- Added the RTX 4070 Ti (12 GB, 504 GB/s).
- A misspelled model name ("lama3.1 8b") now finds the known model - only when every number matches.
- `/api/list_known` works as an address (a newcomer agent guessed it).
- An unknown model's answer now opens by saying LocalBit doesn't know it (a small model took the size-only estimate as real).
- The home page shows how to ask by address, for agents that can only read pages.
- Phone layout: the menu wraps and long addresses break instead of pushing the page off screen; a phone-width browser test checks every page.
- Contributor experience: copy-paste commands for Mac/Linux (python3) and Windows; the result's page lists it immediately (link printed by the script); community count on the home and test pages; on Windows, AMD/Intel cards are detected and confirmed against LocalBit's card list.
- New title, "Local AI models, checked against your hardware"; shorter copy across pages; result pages titled "<model> on <card>" (the question form stays in page titles for search).
- Test page: one copyable line for the visitor's own system, short script address /t.py, "ask your AI assistant" option (agents run --dry-run, show the user, then submit_result).
- Suggest page (/suggest, linked in every footer): one box, no email; stored with reports as "suggestion", links and emails removed, bots caught by a hidden field.
- Owner stats: real questions counted apart from monitoring probes, crawlers and the owner's own test; unknown models/cards from real callers listed separately from size-only answers.
- A model family asked without a size ("Qwen 2.5 on an RTX 4070") gets every size at once and the largest that fits, instead of "ask again"; check_fit's output schema now lists the community basis.
- Test script (from the owner's own run): embedding models left out of the list; a model Ollama can't run gets a plain message, not a traceback; other loaded models are named and can be unloaded first (the node measures with nothing else loaded); the model is loaded before timing; the Windows line runs from the temp folder.
- Test script shows its work: numbered steps (hardware and how it was read, Ollama, getting ready, writing speed per context with a live bar as the model writes, reading speed), what each number means, a results summary, and after sharing how the result compares with LocalBit's estimate. Plain output when not in a terminal. Ends with a readable list of what would be sent (exact data with --json) and a closing block: what happened, the headline number, and where to go next.
- Fresh-agent test: 14 questions, graded against LocalBit's own numbers; runs nightly.

## 0.4.0 - 2026-11-26
- Contributions: a 3-minute test (`/test`, `/test.py`, `/recipe.json`) measures a model on your own machine with the node's recipe, shows exactly what it would send and asks first.
- New tools: `get_test_kit`, `submit_result` (checked against the estimate; plausible results published as community, others flagged), `get_details` (full specs plus node and community measurements).
- Answers use community results where the node hasn't measured, labelled unverified, and invite a test where nothing is measured yet.
- Stats show which formats agents use and look for.

## 0.3.0 - 2026-11-25
- Several cards ("2x RTX 3090") add up their memory; answers note the split across cards.
- A context past a model's published maximum is warned about first; Qwen past 32K notes long-context (YaRN) settings.
- Estimates carry a likely range (about ±15%, from how far estimates have been from the node's measurements).
- Every answer links a page to cite (`source_url`); tools declare their output (`outputSchema`).
- New tools: `compare` (two models or two setups) and `node_log` (latest readings); pages `/compare`, `/log`, RSS `/log.rss`.
- Unknown names get the closest known ones; Macs are recognised by chip; 21 more cards; `list_known` gives ids and sizes.
- A quality check: 60 script-graded questions (math, instructions, facts, code), shown as Quality.
- Reliability: an error log, turned-away requests counted, nightly backups, replay of real questions before deploying,
  runs partly off the graphics card left out, re-measuring after runtime updates.

## 0.2.0 - 2026-11-25
- `report_issue` and a report form; `/about` (operator, privacy, CC BY 4.0 data license); `/api/measured`; rate limits.
- Answers say how current the data is.

## 0.1.0 - 2026-11-25
- First release: `check_fit`, `suggest_models`, `list_known`; estimates from model design and card specs; the first RTX 3090 measurement.
