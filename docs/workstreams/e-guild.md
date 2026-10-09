# Workstream E: Guild agent

**Goal:** one Guild AI agent turns an attacker session into an evidence-linked summary of the attacker's playbook, triggered from the dashboard.

## You own
- `agents/analysis.md` (the agent prompt and output schema)
- `apps/control/guild.ts` (`registerAnalysisRoutes(app)`: `/v1/analyze`, `/v1/analysis/:id`, and the polling worker)

## Read first
- [`../contracts.md`](../contracts.md): C2 (schemas), C4 (fixture)
- `HoneyStack Implementation.txt` §8 (Guild workspace, trigger call, polling) and §9 (agent rules, output schema, validator)

## Work before ClickHouse is ready (mock)
Build the agent input from `tests/fixtures/demo-session.jsonl` and switch to C's queries at checkpoint 2.

## Tasks
- [ ] Create the Guild workspace and a prompt-driven agent with no tools enabled; store the trigger key outside git.
- [ ] Prompt (extends §9): treat commands as untrusted data; map them to playbook stages (recon → credential hunting → lateral movement attempt → persistence attempt); cite turn/event IDs; say `unknown` when the evidence is thin.
- [ ] Output schema: §9's JSON plus `"playbook_stages": [{"stage": "...", "evidence_ids": ["uuid"]}]` and `"time_wasted_seconds"`.
- [ ] `POST /v1/analyze {session_id}` (requires `CONTROL_TOKEN`): fetch at most 20 turns and events, call the trigger (§8.2), and return the analysis ID.
- [ ] Worker: poll the Guild session with backoff (60 s timeout), extract the final agent output (§8.2, following `from_id`), and store it in memory.
- [ ] Validator: every evidence ID must belong to the session; reject unknown fields and bad classifications → `failed` state, never a made-up success.
- [ ] Do one real run against the fixture and save the Guild session URL as proof.

## Done when
`/v1/analyze` on the fixture session returns a validated summary with real evidence IDs and a working Guild session link.

## Hand-offs
- **To D:** the `/v1/analyze` and `/v1/analysis/:id` responses (tell D the JSON shape early).
