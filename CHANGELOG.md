# Changelog

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
