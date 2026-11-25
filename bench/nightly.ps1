# LocalBit nightly (Windows task "LocalBit 3090 bench", 3:10 AM): bench/nightly.py does the steps, writes bench\nightly.log itself
# and bench\status.json, which the home assistant's self-check reads. Uses the home assistant's Python (has requests).
Set-Location 'C:\Projects\localbit'
& 'C:\Projects\ai\ai_assistant_v3\.venv\Scripts\python.exe' bench\nightly.py
