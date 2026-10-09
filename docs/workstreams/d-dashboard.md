# Workstream D: Dashboard

**Goal:** the "reveal" screen of the demo. It replays every command the attacker typed, shows how long they've been fooled, and triggers the Guild summary.

## You own
- `apps/dashboard/` (including `serve.ts`, which exports `registerDashboard(app)`)

## Read first
- [`../contracts.md`](../contracts.md): C2 (schemas), C4 (fixture)
- `HoneyStack Implementation.txt` §7.2 (dashboard rules, private interfaces)
- [`../llm-shell-demo.md`](../llm-shell-demo.md) §4: the demo script (your screen is beat 4)

## Work before ClickHouse is ready (mock)
Read `tests/fixtures/demo-session.jsonl` directly behind the same function names C's queries will have, then swap in C's queries at checkpoint 2.

## Tasks
- [ ] Private: require `CONTROL_TOKEN`; don't expose it through the tunnel (F only exposes `/v1/shell/*` and `/v1/events/batch`).
- [ ] Session list: start time, number of commands, time wasted, live/ended.
- [ ] Terminal replay pane: looks like a terminal, with prompt + command + output in order. Tag each turn `fast_path` / `llm` / `filter` (small badge).
- [ ] HTTP timeline for the same session: recon → login → diagnostics → callback.
- [ ] Big "time wasted" counter that ticks while the session is live.
- [ ] Analyze button → `POST /v1/analyze` → poll `/v1/analysis/:id` → show classification, playbook stages, evidence IDs (linked to the turns), and the Guild session URL.
- [ ] Escape all captured text. Refresh every 5 s and show the last-refresh time. Label fixture data as "synthetic fixture".

## Done when
During a live run, new commands appear within 5 s, the counter ticks, and Analyze shows a real Guild summary.

## Hand-offs
- **From C:** query functions (checkpoint 2).
- **From E:** `/v1/analyze` (you can stub it to return a canned summary until then).
