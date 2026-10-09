-- C2 change (approved by B/E owner, flag to C): link each shell turn to the Guild session
-- that served the attacker's shell. Safe to re-run. See docs/clickhouse-plan.md §2.4.
ALTER TABLE honeypot.shell_turns
  ADD COLUMN IF NOT EXISTS guild_session_id String DEFAULT '' AFTER served_by,
  ADD COLUMN IF NOT EXISTS guild_event_id String DEFAULT '' AFTER guild_session_id
-- served_by is LowCardinality(String), so the new value 'guild' needs no DDL.
