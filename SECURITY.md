# Security Policy

HoneyStack is a **honeypot and deception tool**. The fake "Hivewell" site is *designed* to look exploitable. Please read this before reporting anything.

## The fake vulnerabilities are intentional

These are **decoys**, entirely synthetic, and are **not** real security issues — please do not report them:

- The hard-coded admin token in the page source and `/api/env` (e.g. `hw_admin_…`, `DATABASE_URL=…`). Every credential, hostname, and IP shown to an attacker is fake (`*.invalid` / `*.internal`, `203.0.113.0/24`, AWS's documented example keys).
- The "command injection" on `/api/admin/diagnostics` and the `/api/login`, `/api/exec` bait routes. The trap **never executes** attacker input — it returns scripted responses and records the attempt.
- The "reverse shell." The callback is a real TCP connection, but the shell is an LLM playing bash inside a synthetic world; it only dials IPs in `CALLBACK_ALLOWLIST`.

By design (see [`AGENTS.md`](AGENTS.md)): no attacker input is ever executed, all attacker-facing data is synthetic, captured text is treated as untrusted everywhere (escaped in the UI, parameterized in SQL), and no real credentials live in git, images, or the Akash SDL.

## What *is* in scope

Report a real vulnerability in the **defender-side** code or operations, for example:

- Auth bypass or token handling on the control server (`/v1/events/batch`, `/v1/shell/*`, `/v1/analyze`) or the dashboard (`/admin/*`).
- A way to make the trap execute input, reach the real environment, or leak a real secret.
- SQL injection or unescaped attacker text reaching the dashboard or ClickHouse.
- Real credentials committed to the repository, a built image, or CI logs.

## Reporting

Please report privately via **GitHub's "Report a vulnerability"** (Security → Advisories) on this repository, rather than opening a public issue or PR. Include steps to reproduce and the affected component. As a hackathon project there is no SLA, but we'll respond as soon as we can.

## Supported versions

This is an event/hackathon project; only the latest `main` is maintained.
