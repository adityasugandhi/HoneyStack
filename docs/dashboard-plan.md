# Dashboard plan: "HoneyStack Shield" admin page (workstream D)

**Agent quick start:** you're building workstream D. Read `AGENTS.md`, then this file top to bottom. You own `apps/dashboard/**` and `tests/dashboard.test.ts`. The only shared files you touch are a one-line registration in `apps/control/server.ts` and one glob in `tailwind.config.cjs` (§7). Don't edit anything else; ask the owner.

## 1. The idea

The demo's reveal screen is presented as a **security plugin installed on Acme Status**, the way Wordfence sits inside a WordPress admin. Same look as the trap site (dark slate, "Acme Status" header), with a **Plugins → HoneyStack Shield** page that shows:

- attackers trapped right now, and how long each has been fooled
- a live replay of everything they typed, with what the fake shell answered
- the **Guild analyst's report**: classification, summary, kill-chain stages, credentials targeted, each linked to the exact commands that prove it

**Pitch line for the reveal:** "Acme's site has HoneyStack Shield installed. The attacker thought they broke in. Here's what Shield saw."

## 2. Where it runs (decided)

| | |
|---|---|
| Served by | The **control server** (`:8080`), at `/admin/plugins/honeystack` |
| Not served by | The public trap. The trap is attacker-facing and by design holds no ClickHouse or Guild credentials (Implementation doc §3). An attacker who found an admin panel there would learn it's a honeypot. |
| How it looks like it's "on the website" | It reuses the trap's header, colors and fonts, and lives under an `/admin/...` path. During the demo, open it in a browser tab next to the attacker's terminal. |
| Access | Operator only: `CONTROL_TOKEN` login (§6). Admin routes also refuse anything that arrived through the Cloudflare tunnel. |

## 3. What already exists (use it, don't rebuild it)

| Need | Already built | Where |
|---|---|---|
| Session list (start, last seen, commands, HTTP events, time wasted, live flag, Guild session) | `listSessions({ sinceHours, limit }) → SessionSummary[]` | `apps/control/queries.ts` |
| One session's HTTP events + shell turns, merged and ordered | `getTimeline(sessionId) → TimelineItem[]` (`kind: 'event' \| 'turn'`) | `apps/control/queries.ts` |
| Who answered each command | `getServedByCounts(sessionId?)` → `{ fast_path, guild, llm, filter }` | `apps/control/queries.ts` |
| Last saved analyst report | `getLatestAnalysis(sessionId) → AnalysisRow \| null` (`result_json` is the validated report) | `apps/control/queries.ts` |
| Start an analysis / poll it | `POST /v1/analyze {session_id}` → `202 {id, guild_session_url}`; `GET /v1/analysis/:id` | `apps/control/guild.ts` (Bearer `CONTROL_TOKEN`) |
| Report schema | `classification`, `summary`, `playbook_stages[{stage, evidence_ids}]`, `evidence_event_ids`, `credentials_targeted`, `limitations` + `time_wasted_seconds`, `guild_session_url` | `agents/analysis.md` |
| "ClickHouse configured?" | `clickhouseConfigured()` | `apps/control/clickhouse.ts` |
| Dev data without ClickHouse | `fileEvidenceLoader(sessionId)` (fixture + `data/*.jsonl`) | `apps/control/guild.ts` |
| Look and feel | Tailwind build + markup | `apps/trap/public/index.html`, `apps/trap/styles.src.css`, `tailwind.config.cjs` |

## 4. Screens (wireframe)

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ ▣ Acme Status · admin                                         ● all systems operational │
├──────────────┬───────────────────────────────────────────────────────────────────────────┤
│ Overview     │ 🛡 HoneyStack Shield   v1.0 · Active · Deception mode ON     last refresh 5s │
│ Services     │ ┌────────────┐┌────────────┐┌────────────┐┌────────────┐┌────────────┐     │
│ Settings     │ │ 2 attackers││ 41 commands││ 12m 08s    ││ 5 secrets  ││ 2 analyses │     │
│ Plugins      │ │ trapped 24h││ captured   ││ time wasted││ bait read  ││ by Guild   │     │
│  ▸ HoneyStack│ └────────────┘└────────────┘└────────────┘└────────────┘└────────────┘     │
│    Shield    │ Sessions                                                                   │
│              │ ● LIVE  8856ed52  Shell   started 20:55  12 cmds  ⏱ 00:47 ▲ ticking       │
│              │ ○ ended 803d6d79  Shell   started 20:53   6 cmds  ⏱ 00:34   [Analyzed]     │
│              ├───────────────────────────────────────────────────────────────────────────┤
│              │ Session 8856ed52                                   [ Analyze with Guild ]  │
│              │ Attack path: Recon ─▶ Token leak ─▶ Injection ─▶ Reverse shell ─▶ Post-ex  │
│              │ ┌──────────────── Terminal replay ───────────┐┌──── Analyst report ──────┐ │
│              │ │ node@acme-status-7f9c4:/app$ id    fast    ││ SUSPICIOUS SEQUENCE      │ │
│              │ │ uid=1000(node) gid=1000(node) ...          ││ "Exploited command       │ │
│              │ │ node@...:/app$ cat .env.production  fast   ││  injection, opened a     │ │
│              │ │ DATABASE_URL=postgres://...                ││  reverse shell, read..." │ │
│              │ │ node@...:/app$ netstat -tlnp   guild ↗     ││ Kill chain:              │ │
│              │ │ bash: netstat: command not found           ││ ① Initial access (3)     │ │
│              │ │ ...                                        ││ ② Recon (4)              │ │
│              │ └────────────────────────────────────────────┘│ ③ Credential hunting (1) │ │
│              │                                               │ ④ Priv-esc attempt (1)   │ │
│              │                                               │ Targeted: DATABASE_URL…  │ │
│              │                                               │ View in Guild ↗          │ │
│              │                                               └──────────────────────────┘ │
└──────────────┴───────────────────────────────────────────────────────────────────────────┘
```

### 4.1 Plugin header + KPI tiles
- "HoneyStack Shield", version, **Active** pill, "Deception mode ON".
- Tiles (last 24 h): attackers trapped (sessions that reached Injection or Shell), commands captured, total time wasted (sum), bait secrets read (count of turns whose command touches `.env`, `credentials`, `notes.txt`, `sudo -l`), analyses completed.

### 4.2 Sessions list
- One row per session from `listSessions`: live/ended dot, short ID, **furthest stage** (§5), start time, commands, time wasted.
- Live sessions show a time-wasted counter that ticks every second, client-side from `started_at`.
- An "Analyzed" badge when `getLatestAnalysis` has a `complete` row.
- Hide sessions that never got past browsing (stage 0–1) behind a "show noise" toggle.

### 4.3 Session detail
- **Attack path strip:** Recon → Token leak → Injection → Reverse shell → Post-exploitation, lit up as reached (§5).
- **Terminal replay:** each shell turn as `prompt + command`, then `output`, in `seq` order, in a monospace dark box.
  - Badge per turn: `fast`, `guild ↗` (links to the Guild session), `llm`, or `filter`.
  - HTTP events from the same timeline show as small grey lines between turns (e.g. `POST /api/admin/diagnostics · diag-injected`).
- **Analyst report card** (the main point of this workstream):
  - States: *none* (button "Analyze with Guild"), *running* (spinner + "Guild session ↗" link right away), *complete*, *failed* (error text + "Retry").
  - Complete:
    - classification badge (red for `suspicious_sequence`, grey for `unknown`, green for `benign_test`)
    - summary paragraph
    - **kill chain** as numbered steps in stage order, each with its evidence count
    - credentials targeted as chips, limitations in small text
    - time wasted
    - "View full Guild session ↗"
  - **Evidence linking:** clicking a kill-chain step highlights and scrolls to its turns/events in the replay. Evidence IDs are `turn_id` / `event_id`, so it's a direct match.

## 5. Stage rules (deterministic, no LLM)

Computed in `apps/dashboard/data.ts` from one session's timeline:

| Stage | Reached when |
|---|---|
| 0 Noise | only `/health`, `/favicon.ico`, `/robots.txt` |
| 1 Recon | any other HTTP event (`/`, 404s) |
| 2 Token leak | `/api/env` hit (`response_template = fake-env-values`) or another bait route |
| 3 Injection | `response_template = diag-injected` |
| 4 Reverse shell | `response_template = revshell-callback`, or any shell turn exists |
| 5 Post-exploitation | 3 or more shell turns |

Use the real `response_template` values from `packages/trap/response-map.json` and `apps/trap/server.mjs`, not these names if they differ.

## 6. Server side: `apps/dashboard/serve.ts`

Export `registerDashboard(app: FastifyInstance)`:

| Route | Returns | Backed by |
|---|---|---|
| `GET /admin/plugins/honeystack` | the page (`public/index.html`) | static |
| `GET /admin/assets/*` | `app.js`, `dashboard.css` | static, from `apps/dashboard/public/` |
| `POST /admin/login` / `POST /admin/logout` | sets / clears the session cookie | `CONTROL_TOKEN` |
| `GET /admin/api/overview` | KPI tile numbers | `listSessions` + `getServedByCounts` |
| `GET /admin/api/sessions?since=24` | `SessionSummary[]` + `stage` | `listSessions` + §5 |
| `GET /admin/api/sessions/:id` | `{ summary, stage, timeline, analysis }` | `getTimeline`, `getLatestAnalysis` (parse `result_json`) |
| `POST /admin/api/sessions/:id/analyze` | `{ job_id, guild_session_url }` | calls `startAnalysis()` from `guild.ts` directly (same process) |
| `GET /admin/api/analysis/:jobId` | job state + report | `getAnalysis()` from `guild.ts`, falling back to `getLatestAnalysis` |

**Auth**
- `POST /admin/login` takes the `CONTROL_TOKEN` in a form and sets an `HttpOnly; SameSite=Strict; Path=/admin` cookie, compared with `timingSafeEqual`.
- Every `/admin/api/*` route needs that cookie or `Authorization: Bearer <CONTROL_TOKEN>`.
- With no `CONTROL_TOKEN`: allowed in dev, refused when `NODE_ENV=production`, the same rule `guild.ts` uses.
- **Tunnel guard:** the Cloudflare quick tunnel forwards the whole `:8080`, so `/admin/*` returns 404 when the request has a `cf-connecting-ip` header, unless `ADMIN_ALLOW_REMOTE=1`.

**Data source switch (`apps/dashboard/data.ts`):** if `clickhouseConfigured()`, use `queries.ts`. Otherwise use a file adapter with the same function names. It groups `tests/fixtures/demo-session.jsonl` + `data/events.jsonl` + `data/shell_turns.jsonl` by `session_id`, so the page works on any laptop with no database. Mark fixture rows "synthetic fixture" in the UI.

## 7. Front end

- **No framework, no build step beyond Tailwind:** `apps/dashboard/public/index.html` + `app.js` (ES module) + Tailwind classes. `fetch` → render → `setInterval(refresh, 5000)` for the list and the open session, plus a 1 s tick for live counters.
- **Styling:** add `'./apps/dashboard/public/**/*.{html,js}'` to `content` in `tailwind.config.cjs`, and add a second build target `build:css:dashboard` → `apps/dashboard/public/dashboard.css`. Copy the trap's header markup so it looks like the same site.
- **Security, non-negotiable:** captured data is attacker-controlled. Render it with `textContent` / `createElement` only, never `innerHTML`, `insertAdjacentHTML` or template strings into HTML. That covers commands, outputs, payloads, and summaries the model wrote. Guild links must start with `https://app.guild.ai/`.
- **Polling:** list and session every 5 s; an analysis job every 2 s until `complete` or `failed`. Show "last refresh Ns ago" and a red banner if the API errors.
- **Optional polish:** auto-scroll the replay while the session is live; a short highlight on new turns; `prefers-reduced-motion` respected.

## 8. Files

| File | What |
|---|---|
| `apps/dashboard/serve.ts` | `registerDashboard(app)`: routes, auth, tunnel guard, static files |
| `apps/dashboard/data.ts` | data source switch, file adapter, stage rules, overview numbers |
| `apps/dashboard/public/index.html` | admin chrome + plugin page skeleton |
| `apps/dashboard/public/app.js` | fetch, render, polling, analyze flow, evidence highlighting |
| `apps/dashboard/public/dashboard.css` | Tailwind output (generated, committed like the trap's) |
| `tests/dashboard.test.ts` | stage rules, file adapter, auth + tunnel guard, "no innerHTML" check |
| `apps/control/server.ts` (1 line, owner C) | `registerDashboard(app)` |
| `tailwind.config.cjs` + `package.json` (shared) | content glob + `build:css:dashboard` script |

## 9. Order of work (about 3 hours)

1. [ ] **(20 min)** `serve.ts` with the page route, static assets, `/admin/api/sessions` from the file adapter; register it in `server.ts`. Check the page loads at `http://127.0.0.1:8080/admin/plugins/honeystack` with the fixture session listed.
2. [ ] **(30 min)** Admin chrome + plugin header + sessions list, styled like the trap. Live counter ticking.
3. [ ] **(40 min)** Session detail: attack-path strip + terminal replay with badges + HTTP event lines.
4. [ ] **(45 min)** Analyst report card: all four states, kill chain, chips, Guild link, evidence highlighting. Test against a real Guild run.
5. [ ] **(20 min)** Auth: login form, cookie, Bearer, tunnel guard, production refusal.
6. [ ] **(15 min)** Switch to ClickHouse (`clickhouseConfigured()`), check with real sessions.
7. [ ] **(15 min)** KPI tiles, "show noise" toggle, error banner, last-refresh.
8. [ ] **(15 min)** Tests + the full rehearsal in §10.

## 10. Verification

- **Dev, no database:** `CLICKHOUSE_URL= npm run dev:control`, open `/admin/plugins/honeystack`. The fixture session shows with stage "Reverse shell" and its full replay.
- **Live:** start the trap + control server, run the attack from `docs/architecture.md` §2. The session appears within 5 s as LIVE, commands stream into the replay, and the counter ticks.
- **Analyze:** click Analyze. The card shows running with a Guild link, then complete with the kill chain. Clicking "Credential hunting" highlights `cat .env.production`. Restart the control server: the report is still there (from `honeypot.analyses`).
- **XSS check:** type `<img src=x onerror=alert(1)>` and `</pre><script>alert(1)</script>` in the attacker shell. They show as plain text, and no alert fires.
- **Auth:** `/admin/api/sessions` without the cookie returns 401 in production. Any `/admin/*` request with a `cf-connecting-ip` header returns 404.
- `npm test` and `npm run typecheck` pass.

## 11. Demo choreography (for the rehearsal)

Split screen: attacker terminal on the left, Shield on the right.
1. While the attacker works, the session appears as LIVE and the counter ticks. Nobody on stage touches the dashboard.
2. After `exit`, click **Analyze with Guild**. Read the summary aloud, then click the kill-chain steps to show the evidence.
3. End on the time-wasted number and the line "every byte they saw was invented."

## 12. Open questions

- Auto-run the analysis when a session ends, instead of the button? It's easy to add in `serve.ts`, but the button is more dramatic on stage.
- Should the plugin chrome mimic a real CMS (WordPress-style sidebar) or stay with the custom Acme admin look? This plan uses the Acme look so it matches the trap.
