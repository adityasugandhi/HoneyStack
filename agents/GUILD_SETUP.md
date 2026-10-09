# Guild setup checklist

Two Guild agents, one workspace, two API triggers. About 15 minutes, all in the web app at [app.guild.ai](https://app.guild.ai).

| Agent | Job | Files |
|---|---|---|
| `honeystack-shell` | Plays bash for the attacker. One Guild session per reverse shell; each command the fast path can't answer becomes a follow-up message. | [`honeystack-shell/PROMPT.md`](honeystack-shell/PROMPT.md), [`honeystack-shell/guild.yaml`](honeystack-shell/guild.yaml) |
| `honeystack-analyst` | Summarizes a finished attacker session into playbook stages for the dashboard. | [`honeystack-analyst/PROMPT.md`](honeystack-analyst/PROMPT.md) |

Neither agent gets any tools or integrations. The control server is the only thing that talks to ClickHouse.

## 1. Workspace
- [ ] Sign in at app.guild.ai.
- [ ] **Workspaces** → **New Workspace** → name: `honeystack`.
- [ ] Open it and copy the owner name from the URL: `app.guild.ai/organizations/<OWNER>/workspaces/honeystack`. That's `GUILD_OWNER`.

## 2. Models (check only)
- [ ] **Access & setup** → **Models & providers**. If the account uses Guild's managed tokens, there's nothing to do.
- Only add your own Anthropic key here if your org admin agrees: the first credential switches the **whole account** to bring-your-own-key.

## 3. Create `honeystack-shell`
- [ ] **Agents** → **Your agents** → **Create Agent** → **Start with a prompt** (this makes a Native agent).
- [ ] **System Prompt** tab: replace everything with the contents of `agents/honeystack-shell/PROMPT.md`.
- [ ] **guild.yaml** tab: replace everything with the contents of `agents/honeystack-shell/guild.yaml` (model preference only, no tools).
- [ ] Name it `honeystack-shell`. Save, wait for validation, **Publish**.

## 4. Create `honeystack-analyst`
- [ ] Same steps, with `agents/honeystack-analyst/PROMPT.md`. Leave `guild.yaml` empty.
- [ ] Name it `honeystack-analyst`. Save, **Publish**.

## 5. Install both in the workspace
- [ ] Workspace → **Agents** → **Add Agent** → add `honeystack-shell`.
- [ ] Repeat for `honeystack-analyst`.

## 6. Two API triggers (keys are shown once)
- [ ] Workspace → **Triggers** → **Add Trigger** → **API** → agent `honeystack-shell` → name `shell-brain`. Copy the `<api_key_id>:<api_key_secret>` string.
- [ ] **Add Trigger** → **API** → agent `honeystack-analyst` → name `analyst`. Copy that string too.

## 7. Optional: spend cap
- [ ] Workspace **Settings** → **Spend budget**: set a monthly cap (e.g. $20) for the hackathon.

## 8. Hand the values to the control server
Put these in `HoneyStack/.env` yourself (it's gitignored; don't paste the keys into chat):

```
GUILD_OWNER=<OWNER from step 1>
GUILD_WORKSPACE=honeystack
GUILD_SHELL_TRIGGER_KEY=<key from the shell-brain trigger>
GUILD_TRIGGER_KEY=<key from the analyst trigger>
SHELL_BACKEND=guild
```

Then tell Claude "Guild is set up". It will run the live tests: a scripted shell session through `honeystack-shell`, and an analysis of the demo fixture through `honeystack-analyst`, each printing its Guild session link.

## Sanity check in the UI (optional, 1 minute)
In the workspace **Chat**, type `@honeystack-shell` and send:

```
<machine_description>{"host":{"hostname":"test","user":"node"}}</machine_description>
```

It should answer `READY`. Then send `<session_state>cwd: /app</session_state>\nwhoami` and it should answer `node`. If it explains itself or uses markdown instead, the prompt didn't save.
