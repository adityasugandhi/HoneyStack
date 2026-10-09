-- §C2: one row per command typed into the fake shell. session_id links these
-- to the honeypot.events rows (recon, exploit) for the same attacker.
CREATE TABLE IF NOT EXISTS honeypot.shell_turns
(
  turn_id UUID,
  session_id UUID,
  seq UInt32,
  received_at DateTime64(3, 'UTC'),
  command String,
  output String,
  cwd String,
  served_by LowCardinality(String),    -- fast_path | llm | filter
  latency_ms UInt32,
  origin_label LowCardinality(String)  -- synthetic_fixture | live_demo
)
ENGINE = MergeTree
ORDER BY (session_id, seq, turn_id)
TTL toDateTime(received_at) + INTERVAL 7 DAY;
