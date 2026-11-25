-- LocalBit's log: what was asked, never who asked (no IP addresses, no accounts).
CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,            -- UTC time
  kind TEXT,                   -- mcp_init, mcp_list, mcp_call, api, page, home, llms_txt
  client TEXT,                 -- the MCP client's self-reported name and version
  ua TEXT,                     -- known agent name from the user agent, or its first 60 characters
  tool TEXT,
  model_q TEXT,                -- the model as asked (80 characters at most)
  hw_q TEXT,                   -- the hardware as asked
  model_id TEXT, gpu_id TEXT,  -- what LocalBit matched them to
  verdict TEXT, context INTEGER, quant TEXT
);
CREATE INDEX IF NOT EXISTS calls_ts ON calls (ts);

-- Reports that an answer was wrong or something is missing: what was seen, never who (no IPs; emails, numbers and links removed from notes).
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL, source TEXT, client TEXT,
  model_q TEXT, hw_q TEXT, model_id TEXT, gpu_id TEXT,
  problem TEXT, obs_tps REAL, obs_mem_gb REAL, context INTEGER, runtime TEXT, note TEXT
);
CREATE INDEX IF NOT EXISTS reports_ts ON reports (ts);

-- Failures inside LocalBit (Nov 25): where and what, never who.
CREATE TABLE IF NOT EXISTS errors (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, path TEXT, tool TEXT, message TEXT);
CREATE INDEX IF NOT EXISTS errors_ts ON errors (ts);
