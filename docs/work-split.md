# HoneyStack work split

The six workstreams below run in parallel once the team freezes [`contracts.md`](contracts.md) in the first 10 minutes. Each person codes against the contracts and the shared fixture, so nobody waits on anyone else until the checkpoints below.

**Using a coding agent?** Tell it which workstream you're on (e.g. "I'm working on the Akash hosting side"). [`AGENTS.md`](../AGENTS.md) points it to the matching brief and the files it may edit.

## Workstreams

| # | Workstream | Owner | Brief | Depends on | Done when |
|---|---|---|---|---|---|
| A | Trap app | | [a-trap.md](workstreams/a-trap.md) | C1 | `curl` injection + a local `nc` gets a shell prompt |
| B | Shell brain | | [b-shell-brain.md](workstreams/b-shell-brain.md) | C1, C2, C3 | A teammate can't tell it from bash for 20 commands |
| C | ClickHouse + ingest | | [c-clickhouse.md](workstreams/c-clickhouse.md) | C2 | Fixture rows queryable; live turns and events land |
| D | Dashboard | | [d-dashboard.md](workstreams/d-dashboard.md) | C2, C4 | A live session updates within 5 s; Analyze works |
| E | Guild agent | | [e-guild.md](workstreams/e-guild.md) | C2, C4 | A real Guild session returns validated JSON with evidence IDs |
| F | Akash + demo lead | | [f-akash.md](workstreams/f-akash.md) | A's image | The full attack works against the Akash URI |

F plays the attacker in rehearsal, so F shouldn't read `packages/shell/world.json`.

## Integration checkpoints

1. **Contracts frozen (T+10):** `contracts.md` agreed; C pushes the `server.ts` skeleton and the fixture by T+15; everyone pulls.
2. **Brain + data (T+45):** B's REPL writes real rows to ClickHouse via C; D and E switch from the fixture to C's queries.
3. **Local end to end (T+70):** A's trap + B/C's control server + a local `nc`; the full attack in [`llm-shell-demo.md`](llm-shell-demo.md) §1 works and lands in ClickHouse. A hands F the image.
4. **Akash (T+90):** F deploys A's image behind the tunnel; the attack runs from the attacker laptop against the Akash URI; E summarizes that live session.
5. **Rehearsal (T+100–120):** F attacks without having seen `world.json`. Every "wait, that's weird" moment goes to B. Record the backup run.
