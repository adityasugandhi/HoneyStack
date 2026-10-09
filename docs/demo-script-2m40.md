# HoneyStack 2:40 Demo Script

**Target runtime:** 2 minutes 40 seconds  
**Format:** Hivewell Status page and attacker terminal first, followed by the HoneyStack Shield dashboard  
**Core message:** Everything the attacker sees is synthetic, but everything they do becomes defense intelligence.

## Before going on stage

- Open the Hivewell Status page and the attacker terminal side by side.
- Start the netcat listener before the timer begins, and confirm its public IP is in the trap's `CALLBACK_ALLOWLIST` — otherwise the reverse-shell callback is blocked (logged as `revshell-blocked`) and never dials.
- **Pre-flight check:** the control server's `/health` returns `{"clickhouse":true}`, and the Akash trap's bait routes return `200` (not `503`). A `503` means the trap can't reach the control server — wire `CONTROL_URL` / `INGEST_TOKEN` in the SDL before going live.
- Put the longer `curl` commands in terminal history so they can be recalled with the up arrow.
- Open HoneyStack Shield in another tab with the session list ready. Don't restart the control server after recording — live analyses are in memory until the `analyses` table ships.
- Have a completed Guild analysis available as a fallback in case live analysis takes longer than expected.

## 0:00–0:38 — Hook

**Screen:** Hivewell Status page beside the attacker terminal.

**Presenter:**

> Most honeypots tell you somebody knocked. HoneyStack lets the attacker walk in—and quietly replaces the building around them.
>
> This is the admin portal for Hivewell Status. An attacker finds a leaked admin token, discovers a vulnerable diagnostics tool, and uses it to launch a reverse shell. Their terminal connects, and they believe they own our server.
>
> But nothing they type is ever executed. We place them inside a completely synthetic machine, keep them exploring, and record every move they make. Let’s watch it happen.

## 0:38–1:18 — Attack demo

**Screen action:** Request `/api/env` and reveal the synthetic admin token.

**Presenter:**

> The attacker checks the environment endpoint and finds an exposed admin token.

**Screen action:** Send `8.8.8.8; id` through the diagnostics tool.

> They use that token on the diagnostics endpoint and inject `id`. The response says `uid=1000(node)`. To the attacker, that confirms remote code execution.

**Screen action:** Fire the prepared reverse-shell payload. Show the netcat listener receiving the connection and prompt.

> Now they launch a reverse shell. Watch the listener: connection received, followed by a believable bash prompt. This is a real TCP callback, which makes the compromise feel genuine.

**Screen action:** Quickly run:

```bash
whoami
cat .env.production
cat ~/.aws/credentials
```

> They begin hunting for credentials. Every secret and every file they see is synthetic, but the fake machine remains consistent. Meanwhile, HoneyStack captures every command and response.

## 1:18–1:48 — Dashboard reveal

**Screen:** Switch to HoneyStack Shield. Open the live session and terminal replay.

**Presenter:**

> Hivewell’s site has HoneyStack Shield installed. The attacker thought they broke in—here’s what Shield saw.
>
> We can watch the complete attack path, replay their terminal command by command, see how each response was generated, and measure how long we kept them occupied.

**Screen action:** Click **Analyze with Guild**, then select a kill-chain stage so its evidence is highlighted.

> With one click, Guild turns the raw session into an evidence-linked attack report: initial access, command injection, credential hunting, and every command that proves it.

## 1:48–2:29 — Sponsor technology

**Screen:** Keep the dashboard or project architecture visible.

**Presenter:**

> Akash hosts our public-facing trap, giving the attacker a real network endpoint and allowing the reverse-shell callback to originate from the deployed environment. The trap remains isolated and contains no real credentials.
>
> ClickHouse is our telemetry backbone. It stores the HTTP events, shell commands, outputs, timing, and response sources, then powers the live replay and time-wasted metrics you see here.
>
> Guild provides the intelligence layer. A Guild-powered shell agent can handle unfamiliar commands while remaining inside the synthetic world, and a separate analyst agent converts the completed session into an evidence-backed attacker playbook.

## 2:29–2:40 — Closing

**Presenter:**

> HoneyStack turns an attempted breach into defense intelligence. Every byte the attacker saw was invented—but every move they made became real evidence.

## Condensed stage cues

1. Show Hivewell Status and deliver the hook.
2. Reveal the token from `/api/env`.
3. Inject `8.8.8.8; id` through diagnostics.
4. Launch the prepared reverse-shell payload.
5. Run `whoami`, `cat .env.production`, and `cat ~/.aws/credentials`.
6. Switch to HoneyStack Shield and open the live session.
7. Show the attack path, terminal replay, response-source badges, and time-wasted counter.
8. Run Guild analysis and highlight the evidence for one kill-chain stage.
9. Explain Akash, ClickHouse, and Guild.
10. Deliver the closing line.
