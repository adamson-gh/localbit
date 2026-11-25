# LocalBit nightly (Windows task "LocalBit 3090 bench", 3:10 AM): measure up to 3 approved models, then publish the medians.
# Log: bench\nightly.log. Uses the home assistant's Python (has requests).
$ErrorActionPreference = 'Continue'
Set-Location 'C:\Projects\localbit'
$py = 'C:\Projects\ai\ai_assistant_v3\.venv\Scripts\python.exe'
$log = 'C:\Projects\localbit\bench\nightly.log'
"=== " + (Get-Date -Format s) | Out-File $log -Append -Encoding utf8
& $py bench\run_3090.py --max-models 3 *>> $log
& $py bench\publish.py *>> $log
