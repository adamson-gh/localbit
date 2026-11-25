# LocalBit nightly (Windows task "LocalBit 3090 bench", 3:10 AM): measure up to 3 approved models, then publish the medians.
# Log: bench\nightly.log. Uses the home assistant's Python (has requests).
$ErrorActionPreference = 'Continue'
Set-Location 'C:\Projects\localbit'
$py = 'C:\Projects\ai\ai_assistant_v3\.venv\Scripts\python.exe'
$log = 'C:\Projects\localbit\bench\nightly.log'
"=== " + (Get-Date -Format s) | Out-File $log -Append -Encoding utf8
& $py bench\run_3090.py --max-models 3 *>> $log
& $py bench\publish.py *>> $log
# (Nov 25, David: "yes") new measurements go live on the site the same night; GitHub still waits for his own git push
$before = (git --no-optional-locks diff --quiet HEAD -- data/measured.json; $LASTEXITCODE)
if ($before -ne 0) {
  $env:CI = 'true'
  npx wrangler deploy *>> $log
  "deploy exit $LASTEXITCODE" | Out-File $log -Append -Encoding utf8
} else { "no new measurements - no deploy" | Out-File $log -Append -Encoding utf8 }
