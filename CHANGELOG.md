# Changelog

## 0.4.1 - 2026-11-26
- Added the RTX 4070 Ti (12 GB, 504 GB/s).
- A misspelled model name ("lama3.1 8b") now finds the known model - only when every number matches.
- `/api/list_known` works as an address (a newcomer agent guessed it).
- An unknown model's answer now opens by saying LocalBit doesn't know it (a small model took the size-only estimate as real).
- The home page shows how to ask by address, for agents that can only read pages.
- Phone layout: the menu wraps and long addresses break instead of pushing the page off screen; a phone-width browser test checks every page.
- Contributor experience: copy-paste commands for Mac/Linux (python3) and Windows; the result's page lists it immediately (link printed by the script); community count on the home and test pages; on Windows, AMD/Intel cards are detected and confirmed against LocalBit's card list.
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
