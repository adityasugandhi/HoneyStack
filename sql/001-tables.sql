CREATE DATABASE IF NOT EXISTS honeypot;

CREATE TABLE IF NOT EXISTS honeypot.events
(
  event_id UUID,
  session_id UUID,
  observed_at DateTime64(3, 'UTC'),
  received_at DateTime64(3, 'UTC'),
  source LowCardinality(String),
  trap_instance_id String,
  method LowCardinality(String),
  route String,
  payload_text String,
  payload_bytes UInt32,
  response_template String,
  planned_status UInt16,
  origin_label LowCardinality(String)
)
ENGINE = MergeTree
ORDER BY (session_id, received_at, event_id)
TTL toDateTime(received_at) + INTERVAL 7 DAY;
