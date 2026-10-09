-- [C2 ADDITION: needs team sign-off] Persist Guild analyses so a control-server
-- restart before the reveal doesn't lose the summary. One row per state change;
-- latest per job wins. result_json holds only validated output, never raw text.
CREATE TABLE IF NOT EXISTS honeypot.analyses
(
  job_id              UUID,
  session_id          UUID,
  state               LowCardinality(String),   -- running | complete | failed
  guild_session_id    String,
  guild_session_url   String,
  classification      LowCardinality(String),   -- '' until complete
  result_json         String,
  error               String,
  time_wasted_seconds UInt32,
  evidence_count      UInt32,
  created_at          DateTime64(3, 'UTC'),
  finished_at         Nullable(DateTime64(3, 'UTC')),
  updated_at          DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (session_id, job_id)
TTL toDateTime(created_at) + INTERVAL 7 DAY;
