# Workstream C: ClickHouse + ingest (control server owner)

**Goal:** every HTTP event and every shell turn lands in ClickHouse, and the control server skeleton that everyone else plugs into exists from minute 10.

## You own
- `sql/` (migrations)
- `apps/control/server.ts` (the thin router; see contracts)
- `apps/control/ingest.ts` (`/v1/events/batch`, the ClickHouse client, `insertShellTurn()`, saved queries)
- `tests/fixtures/demo-session.jsonl`
- `package.json` scripts `dev:control` and `db:migrate`

## Read first
- [`../contracts.md`](../contracts.md): the layout, C2 (schemas), C4 (fixture)
- `HoneyStack Implementation.txt` §6 (event contract) and §7 (ClickHouse table, client, queries, limits)

## Kickoff duties (first 15 minutes; others are waiting on these)
- [ ] Create `apps/control/server.ts` with the framework chosen in contracts.md and all four `register*Routes` imports, plus a stub file for each so it compiles.
- [ ] Write `tests/fixtures/demo-session.jsonl` (C4): about 15 shell turns + matching HTTP events that follow `llm-shell-demo.md` §1. Push it.

## Tasks
- [ ] Create the ClickHouse Cloud service and the `honeypot` database; write `sql/001-tables.sql` (§7) and `sql/002-shell.sql` (C2).
- [ ] Two DB users: insert-only for the control server, read-only for the dashboard.
- [ ] `db:migrate` script that applies `sql/*.sql` in order.
- [ ] `POST /v1/events/batch`: check `INGEST_TOKEN`; validate with zod; limit to 100 events or 256 KiB; respond `400`/`401`/`503` per §7.2; the server sets `received_at` and `source`.
- [ ] Export `insertShellTurn(row)` for B.
- [ ] Script to load `demo-session.jsonl` into ClickHouse.
- [ ] Saved queries (parameterized; never put request text into SQL) for D and E: session list, timeline per session, turns per session, time wasted per session (`max(received_at) - min(received_at)`), count by `served_by`.

## Done when
The fixture rows are queryable, B's live turns land, and the trap's events land. Counts use distinct IDs.

## Hand-offs
- **To D and E:** the query functions and a read-only user (by checkpoint 2).
- **To B:** `insertShellTurn()`.
- **To F:** confirm the control server listens on port 8080, so F can point the tunnel at it.
