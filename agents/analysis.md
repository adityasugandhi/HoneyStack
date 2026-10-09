# Guild analysis agent

One Guild **Native agent** (`honeystack-analyst`) turns an attacker session into an evidence-linked summary of the attacker's playbook. The control server starts it through a Guild **API trigger** and validates its JSON reply before the dashboard shows it.

- Prompt: [`honeystack-analyst/PROMPT.md`](honeystack-analyst/PROMPT.md) (the whole agent; no tools, no `guild.yaml`)
- Caller: [`apps/control/guild.ts`](../apps/control/guild.ts) (`POST /v1/analyze`, `GET /v1/analysis/:id`)

## How a run works

1. The dashboard calls `POST /v1/analyze {"session_id": "<uuid>"}` with the operator token.
2. `guild.ts` loads up to 20 HTTP events + 40 shell turns for the session, wraps them in `<evidence>` marked as untrusted, and starts a Guild session: `POST https://api.guild.ai/v1/workspaces/{owner}/{workspace}/sessions` with `{"session_type": "api_trigger", "agent_input": {"text": "..."}}` and Basic auth from the trigger key.
3. It polls `GET /v1/sessions/{id}/events?types=runtime_done,runtime_error` until the agent's reply arrives (`content.text`). A Native agent's task can stay `WAITING` after it replies, so the reply event is the completion signal, not `DONE`.
4. The reply is parsed and validated: strict schema, allowed labels only, and **every cited evidence ID must belong to the run**. Anything else becomes `state: "failed"` with the reason; it is never shown as a success.
5. `GET /v1/analysis/:id` returns `{state, guild_session_url, time_wasted_seconds, result}`. `time_wasted_seconds` is computed from timestamps, not by the model.

## Output schema

```json
{
  "classification": "suspicious_sequence | benign_test | unknown",
  "summary": "string",
  "playbook_stages": [{ "stage": "recon", "evidence_ids": ["<id>"] }],
  "evidence_event_ids": ["<id>"],
  "credentials_targeted": ["DATABASE_URL"],
  "limitations": ["Remote identity is unverified."]
}
```

Stages: `initial_access`, `recon`, `credential_hunting`, `privilege_escalation_attempt`, `lateral_movement_attempt`, `persistence_attempt`, `exfiltration_attempt`, `tool_download_attempt`.

## One-time setup

See [`GUILD_SETUP.md`](GUILD_SETUP.md) (covers both Guild agents). Then test against the fixture:

```
npm run dev:shell                 # control server on :8080 (shell + analysis routes)
npm run analyze                   # analyzes tests/fixtures/demo-session.jsonl
```

Expect `"state": "complete"`, a `suspicious_sequence` classification, and a `guild_session_url`. Save that URL as proof for the demo.

## Swapping in ClickHouse

Until workstream C's queries exist, evidence comes from `tests/fixtures/demo-session.jsonl` plus the shell brain's local `data/shell_turns.jsonl`. C plugs in ClickHouse with:

```ts
import { setEvidenceLoader } from './guild';
setEvidenceLoader(async (sessionId) => ({ turns: await getShellTurns(sessionId), events: await getEvents(sessionId) }));
```
