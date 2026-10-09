import path from 'node:path';
import type { ShellSession } from './session';
import { listDir, lookup } from './session';
import type { World } from './world';
import { isDenied, isRootOwned, resolvePath } from './world';

/** Result of running one segment of a command line. */
interface SegResult {
  out: string;
  status: number;
  delayMs?: number;
  close?: boolean;
}

export interface FastPathResult {
  output: string;
  delayMs: number;
  close: boolean;
}

type Handler = (args: string[], ctx: Ctx) => SegResult | undefined;
interface Ctx {
  world: World;
  s: ShellSession;
  /** Redirect target for stdout (`> file` / `>> file`), already parsed out of args. */
  redirect?: { path: string; append: boolean };
}

// ---------------------------------------------------------------------------
// Parsing

/** Split a line into `&&` / `||` / `;` segments, outside quotes. Returns undefined if it has a pipe,
 * subshell, backtick or heredoc: those go to the LLM whole. */
export function splitSegments(line: string): { seg: string; op: ';' | '&&' | '||' }[] | undefined {
  const out: { seg: string; op: ';' | '&&' | '||' }[] = [];
  let cur = '';
  let quote: string | null = null;
  let op: ';' | '&&' | '||' = ';';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '`' || (c === '$' && line[i + 1] === '(') || c === '<' || c === '(' || c === ')') return undefined;
    if (c === '&' && line[i + 1] === '&') { out.push({ seg: cur, op }); op = '&&'; cur = ''; i++; continue; }
    if (c === '|' && line[i + 1] === '|') { out.push({ seg: cur, op }); op = '||'; cur = ''; i++; continue; }
    if (c === '|' || c === '&') return undefined; // pipes and background jobs
    if (c === ';') { out.push({ seg: cur, op }); op = ';'; cur = ''; continue; }
    cur += c;
  }
  if (quote) return undefined;
  out.push({ seg: cur, op });
  return out.filter((x) => x.seg.trim() !== '' || out.length === 1);
}

/** Minimal shell word splitting with quotes and $VAR / ${VAR} expansion. */
export function tokenize(seg: string, env: Record<string, string>): string[] {
  const words: string[] = [];
  let cur = '';
  let inWord = false;
  let quote: string | null = null;
  const expand = (s: string, i: number): [string, number] => {
    const m = /^\$(\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*)|\?)/.exec(s.slice(i));
    if (!m) return ['$', i + 1];
    const name = m[2] ?? m[3];
    return [name ? env[name] ?? '' : '0', i + m[0].length];
  };
  for (let i = 0; i < seg.length; ) {
    const c = seg[i];
    if (quote === "'") {
      if (c === "'") quote = null; else cur += c;
      i++; continue;
    }
    if (quote === '"') {
      if (c === '"') { quote = null; i++; continue; }
      if (c === '$') { const [v, j] = expand(seg, i); cur += v; i = j; continue; }
      if (c === '\\' && i + 1 < seg.length) { cur += seg[i + 1]; i += 2; continue; }
      cur += c; i++; continue;
    }
    if (c === "'" || c === '"') { quote = c; inWord = true; i++; continue; }
    if (/\s/.test(c)) { if (inWord) { words.push(cur); cur = ''; inWord = false; } i++; continue; }
    if (c === '$') { const [v, j] = expand(seg, i); cur += v; inWord = true; i = j; continue; }
    if (c === '\\' && i + 1 < seg.length) { cur += seg[i + 1]; inWord = true; i += 2; continue; }
    cur += c; inWord = true; i++;
  }
  if (inWord) words.push(cur);
  return words;
}

function splitFlags(args: string[]): { flags: Set<string>; rest: string[] } {
  const flags = new Set<string>();
  const rest: string[] = [];
  for (const a of args) {
    if (a.startsWith('--')) flags.add(a);
    else if (a.startsWith('-') && a.length > 1) for (const ch of a.slice(1)) flags.add(ch);
    else rest.push(a);
  }
  return { flags, rest };
}

const ok = (out = ''): SegResult => ({ out, status: 0 });
const fail = (out: string, status = 1): SegResult => ({ out, status });
const nl = (s: string) => (s === '' || s.endsWith('\n') ? s : s + '\n');

// ---------------------------------------------------------------------------
// Commands

function hashSize(p: string): number {
  let h = 0;
  for (const ch of p) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return 200 + (h % 6000);
}

function lsLong(world: World, s: ShellSession, full: string, name: string): string {
  const info = lookup(world, s, full);
  const isDir = info.kind === 'dir';
  const owner = isRootOwned(world, full) ? 'root' : world.host.user;
  let perms = isDir ? 'drwxr-xr-x' : full.endsWith('.sh') ? '-rwxr-xr-x' : '-rw-r--r--';
  if (full === '/tmp') perms = 'drwxrwxrwt';
  const deniedPerms = isDenied(world, full) ? (isDir ? 'drwx------' : '-rw-------') : perms;
  const when = s.created.has(full) ? lsDate(new Date()) : world.mtime;
  const size = isDir ? 4096 : info.kind === 'file' && info.content !== undefined ? Buffer.byteLength(info.content) : hashSize(full);
  const links = isDir ? 2 : 1;
  return `${deniedPerms}    ${links} ${owner.padEnd(8)} ${owner.padEnd(8)} ${String(size).padStart(8)} ${when} ${name}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function lsDate(d: Date): string {
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2)} ${hh}:${mm}`;
}

const ls: Handler = (args, { world, s }) => {
  const { flags, rest } = splitFlags(args);
  const all = flags.has('a') || flags.has('A');
  const long = flags.has('l');
  const targets = rest.length ? rest : ['.'];
  const chunks: string[] = [];
  let status = 0;
  for (const t of targets) {
    const full = resolvePath(world, s.cwd, t);
    const info = lookup(world, s, full);
    if (info.kind === 'missing') {
      chunks.push(`ls: ${t}: No such file or directory\n`);
      status = 1;
      continue;
    }
    if (info.kind === 'file') {
      chunks.push(nl(long ? lsLong(world, s, full, t) : t));
      continue;
    }
    if (isDenied(world, full)) {
      chunks.push(`ls: can't open '${t}': Permission denied\n`);
      status = 1;
      continue;
    }
    if (info.implicit) return undefined; // contents unknown: let the LLM invent them
    let names = listDir(world, s, full) ?? [];
    if (!all) names = names.filter((n) => !n.startsWith('.'));
    if (all && flags.has('a')) names = ['.', '..', ...names];
    const header = targets.length > 1 ? `${t}:\n` : '';
    if (long) {
      const lines = names.map((n) => lsLong(world, s, n === '.' ? full : n === '..' ? path.posix.dirname(full) : path.posix.join(full, n), n));
      chunks.push(header + `total ${names.length * 4}\n` + lines.map((l) => l + '\n').join(''));
    } else {
      // stdout is a socket, not a TTY, so ls prints one name per line.
      chunks.push(header + names.map((n) => n + '\n').join(''));
    }
  }
  return { out: chunks.join(targets.length > 1 ? '\n' : ''), status };
};

const cat: Handler = (args, { world, s }) => {
  const { rest } = splitFlags(args);
  if (!rest.length) return undefined; // cat waiting on stdin: let the LLM decide
  let out = '';
  let status = 0;
  for (const t of rest) {
    const full = resolvePath(world, s.cwd, t);
    if (isDenied(world, full)) { out += `cat: can't open '${t}': Permission denied\n`; status = 1; continue; }
    const info = lookup(world, s, full);
    if (info.kind === 'missing') { out += `cat: can't open '${t}': No such file or directory\n`; status = 1; continue; }
    if (info.kind === 'dir') { out += `cat: read error: Is a directory\n`; status = 1; continue; }
    if (info.content === undefined) return undefined; // exists but undescribed: LLM, cached per session
    out += info.content;
  }
  return { out, status };
};

const cd: Handler = (args, { world, s }) => {
  const target = args[0] === undefined || args[0] === '~' ? world.host.home : args[0] === '-' ? s.env.OLDPWD ?? s.cwd : args[0];
  const full = resolvePath(world, s.cwd, target);
  const info = lookup(world, s, full);
  if (info.kind === 'missing') return fail(`bash: cd: ${args[0]}: No such file or directory\n`);
  if (info.kind === 'file') return fail(`bash: cd: ${args[0]}: Not a directory\n`);
  if (isDenied(world, full)) return fail(`bash: cd: ${args[0]}: Permission denied\n`);
  s.env.OLDPWD = s.cwd;
  s.cwd = full;
  s.env.PWD = full;
  return ok();
};

function writeFile(world: World, s: ShellSession, target: string, content: string, append: boolean, cmd: string): SegResult {
  const full = resolvePath(world, s.cwd, target);
  const parent = lookup(world, s, path.posix.dirname(full));
  if (parent.kind !== 'dir') return fail(`bash: ${target}: No such file or directory\n`);
  if (isDenied(world, full) || isRootOwned(world, full)) return fail(`bash: ${target}: Permission denied\n`);
  const existing = lookup(world, s, full);
  if (existing.kind === 'dir') return fail(`bash: ${target}: Is a directory\n`);
  const prev = existing.kind === 'file' ? existing.content ?? '' : '';
  s.created.set(full, append ? prev + content : content);
  s.removed.delete(full);
  void cmd;
  return ok();
}

const echo: Handler = (args, ctx) => {
  let a = args;
  let newline = true;
  if (a[0] === '-n') { newline = false; a = a.slice(1); }
  const text = a.join(' ') + (newline ? '\n' : '');
  if (ctx.redirect) return writeFile(ctx.world, ctx.s, ctx.redirect.path, text, ctx.redirect.append, 'echo');
  return ok(text);
};

const touch: Handler = (args, { world, s }) => {
  for (const t of splitFlags(args).rest) {
    const full = resolvePath(world, s.cwd, t);
    if (lookup(world, s, full).kind !== 'missing') continue;
    const r = writeFile(world, s, t, '', false, 'touch');
    if (r.status) return fail(`touch: ${t}: Permission denied\n`);
  }
  return ok();
};

const mkdir: Handler = (args, { world, s }) => {
  const { flags, rest } = splitFlags(args);
  for (const t of rest) {
    const full = resolvePath(world, s.cwd, t);
    if (lookup(world, s, full).kind !== 'missing') {
      if (flags.has('p')) continue;
      return fail(`mkdir: can't create directory '${t}': File exists\n`);
    }
    const parent = lookup(world, s, path.posix.dirname(full));
    if (parent.kind !== 'dir' && !flags.has('p')) return fail(`mkdir: can't create directory '${t}': No such file or directory\n`);
    if (isDenied(world, full) || isRootOwned(world, full)) return fail(`mkdir: can't create directory '${t}': Permission denied\n`);
    s.created.set(full, null);
    s.removed.delete(full);
  }
  return ok();
};

const rm: Handler = (args, { world, s }) => {
  const { flags, rest } = splitFlags(args);
  for (const t of rest) {
    const full = resolvePath(world, s.cwd, t);
    const info = lookup(world, s, full);
    if (info.kind === 'missing') { if (!flags.has('f')) return fail(`rm: can't remove '${t}': No such file or directory\n`); continue; }
    if (info.kind === 'dir' && !flags.has('r') && !flags.has('R')) return fail(`rm: '${t}' is a directory\n`);
    if (isDenied(world, full) || isRootOwned(world, full)) return fail(`rm: can't remove '${t}': Permission denied\n`);
    if (s.created.has(full)) s.created.delete(full); else s.removed.add(full);
  }
  return ok();
};

const exportCmd: Handler = (args, { s }) => {
  for (const a of args) {
    const eq = a.indexOf('=');
    if (eq > 0) s.env[a.slice(0, eq)] = a.slice(eq + 1);
  }
  return ok();
};

const unset: Handler = (args, { s }) => {
  for (const a of args) delete s.env[a];
  return ok();
};

const env: Handler = (args, { s }) => {
  if (args.length) return undefined; // `env FOO=1 cmd`: LLM
  return ok(Object.entries(s.env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
};

const printenv: Handler = (args, { s }) => {
  if (!args.length) return env([], { s } as Ctx);
  const v = s.env[args[0]];
  return v === undefined ? fail('') : ok(v + '\n');
};

const id: Handler = (args, { world }) => {
  const { uid, gid, user } = world.host;
  const { flags } = splitFlags(args);
  if (flags.has('u')) return ok(flags.has('n') ? `${user}\n` : `${uid}\n`);
  if (flags.has('g')) return ok(flags.has('n') ? `${user}\n` : `${gid}\n`);
  return ok(`uid=${uid}(${user}) gid=${gid}(${user}) groups=${gid}(${user})\n`);
};

const uname: Handler = (args, { world }) => {
  const parts = world.host.uname.split(' ');
  const { flags } = splitFlags(args);
  if (flags.has('a')) return ok(world.host.uname + '\n');
  if (!flags.size || flags.has('s')) return ok('Linux\n');
  if (flags.has('r')) return ok(parts[2] + '\n');
  if (flags.has('n')) return ok(world.host.hostname + '\n');
  if (flags.has('m')) return ok('x86_64\n');
  return ok(world.host.uname + '\n');
};

const history: Handler = (_args, { s }) =>
  ok(s.history.map((h, i) => `${String(i + 1).padStart(5)}  ${h}`).join('\n') + '\n');

const which: Handler = (args, { world }) => {
  let out = '';
  let status = 0;
  for (const a of args) {
    if (world.installed.includes(a)) out += (['node', 'npm', 'npx', 'yarn'].includes(a) ? '/usr/local/bin/' : '/usr/bin/') + a + '\n';
    else status = 1;
  }
  return { out, status };
};

const sudo: Handler = (args, { world }) => {
  if (args[0] === '-l') return ok(world.sudo_l);
  const cmd = args.filter((a) => !a.startsWith('-')).join(' ');
  if (cmd === '/usr/local/bin/backup.sh' || cmd.startsWith('/usr/local/bin/backup.sh ')) {
    return { out: world.sudo_backup_output, status: 1, delayMs: world.slow_commands['sudo /usr/local/bin/backup.sh'] ?? 20000 };
  }
  return fail('sudo: a terminal is required to read the password; either use the -S option to read from standard input or configure an askpass helper\nsudo: a password is required\n');
};

const su: Handler = () => ({ out: 'su: must be suid to work properly\n', status: 1, delayMs: 300 });

const hostOf = (s: string) => s.replace(/^[a-z]+:\/\//, '').replace(/[/:].*$/, '').replace(/^.*@/, '');
const isIp = (h: string) => /^\d+\.\d+\.\d+\.\d+$/.test(h);

const curl: Handler = (args, { world }) => {
  const { flags, rest } = splitFlags(args);
  const silent = flags.has('s') && !flags.has('S');
  const r = curlResult(rest, world);
  return r && silent ? { ...r, out: '' } : r;
};

function curlResult(rest: string[], world: World): SegResult | undefined {
  const url = rest.find((a) => a.includes('.') || a.includes('://'));
  if (!url) return fail("curl: try 'curl --help' for more information\n", 2);
  const host = hostOf(url);
  if (host === 'localhost' || host === '127.0.0.1') return undefined; // the app itself: LLM can fake it
  if (isIp(host) || world.network.internal_hosts[host]) {
    const ip = isIp(host) ? host : world.network.internal_hosts[host];
    void ip;
    return { out: `curl: (28) Failed to connect to ${host} port 80 after ${world.network.connect_timeout_ms} ms: Timeout was reached\n`, status: 28, delayMs: world.network.connect_timeout_ms };
  }
  return { out: `curl: (6) Could not resolve host: ${host}\n`, status: 6, delayMs: world.network.resolv_timeout_ms };
}

const wget: Handler = (args, { world }) => {
  const url = splitFlags(args).rest.find((a) => a.includes('.') || a.includes('://'));
  if (!url) return fail('BusyBox v1.36.1 (2024-06-12 11:52:11 UTC) multi-call binary.\n\nUsage: wget [-cqS] [--spider] [-O FILE] [-o LOGFILE] [--header STR]\n', 1);
  const host = hostOf(url);
  if (isIp(host) || world.network.internal_hosts[host]) {
    return { out: `Connecting to ${host} (${isIp(host) ? host : world.network.internal_hosts[host]}:80)\nwget: can't connect to remote host (${isIp(host) ? host : world.network.internal_hosts[host]}): Operation timed out\n`, status: 1, delayMs: world.network.connect_timeout_ms };
  }
  return { out: `wget: bad address '${host}'\n`, status: 1, delayMs: world.network.resolv_timeout_ms };
};

const ping: Handler = (args, { world }) => {
  const target = splitFlags(args).rest.find((a) => !/^\d+$/.test(a));
  if (!target) return fail('BusyBox v1.36.1 (2024-06-12 11:52:11 UTC) multi-call binary.\n\nUsage: ping [OPTIONS] HOST\n');
  const ip = isIp(target) ? target : world.network.internal_hosts[target];
  if (!ip) return { out: `ping: bad address '${target}'\n`, status: 1, delayMs: world.network.resolv_timeout_ms };
  return {
    out: `PING ${target} (${ip}): 56 data bytes\n\n--- ${target} ping statistics ---\n4 packets transmitted, 0 packets received, 100% packet loss\n`,
    status: 1,
    delayMs: 4000,
  };
};

const psql: Handler = (_args, { world }) => ({
  out: `psql: error: connection to server at "db.acme.invalid" (${world.network.internal_hosts['db.acme.invalid']}), port 5432 failed: Connection timed out\n\tIs the server running on that host and accepting TCP/IP connections?\n`,
  status: 2,
  delayMs: world.slow_commands.psql ?? 20000,
});

const apk: Handler = (args) =>
  args[0] === 'add' || args[0] === 'update' || args[0] === 'upgrade' || args[0] === 'del'
    ? fail('ERROR: Unable to lock database: Permission denied\nERROR: Failed to open apk database: Permission denied\n', 99)
    : undefined;

const COMMANDS: Record<string, Handler> = {
  ls, ll: (a, c) => ls(['-la', ...a], c), dir: ls,
  cat, cd, echo, touch, mkdir, rm, export: exportCmd, unset, env, printenv,
  id, uname, history, which, sudo, su,
  pwd: (_a, { s }) => ok(s.cwd + '\n'),
  whoami: (_a, { world }) => ok(world.host.user + '\n'),
  hostname: (_a, { world }) => ok(world.host.hostname + '\n'),
  clear: () => ok('\x1b[H\x1b[2J'),
  true: () => ok(),
  false: () => fail(''),
  ps: (_a, { world }) => ok(world.ps),
  curl, wget, ping, psql, pg_dump: psql, apk,
  exit: () => ({ out: 'exit\n', status: 0, close: true }),
  logout: () => ({ out: 'logout\n', status: 0, close: true }),
};

/** Commands whose only effect is on session state; replayed after the LLM answers a line. */
const STATEFUL = new Set(['cd', 'export', 'unset', 'touch', 'mkdir', 'rm', 'echo']);

function runSegment(world: World, s: ShellSession, seg: string, quiet = false): SegResult | undefined {
  let words = tokenize(seg, s.env);
  // Leading VAR=value assignments.
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
    if (words.length === 1) return exportCmd(words, { world, s });
    words = words.slice(1);
  }
  if (!words.length) return ok();
  // Output redirection (only `> file` / `>> file` / `2>/dev/null` forms).
  let redirect: Ctx['redirect'];
  const cleaned: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === '2>/dev/null' || w === '2>&1') continue;
    if (w === '>' || w === '>>') { redirect = { path: words[i + 1] ?? '', append: w === '>>' }; i++; continue; }
    if (/^>>?[^>]/.test(w)) { redirect = { path: w.replace(/^>>?/, ''), append: w.startsWith('>>') }; continue; }
    cleaned.push(w);
  }
  const [cmd, ...args] = cleaned;
  if (quiet && !STATEFUL.has(cmd)) return ok();
  if (redirect && cmd !== 'echo') return undefined;
  if (world.not_installed.includes(cmd)) return fail(`bash: ${cmd}: command not found\n`, 127);
  const handler = COMMANDS[cmd];
  if (!handler) return undefined;
  return handler(args, { world, s, redirect });
}

/** Answer `line` without the LLM, or return undefined if any part of it needs the LLM. */
export function tryFastPath(world: World, s: ShellSession, line: string): FastPathResult | undefined {
  const segs = splitSegments(line);
  if (!segs) return undefined;
  // Dry run on a scratch copy first, so a half-handled line never mutates real state.
  const scratch: ShellSession = { ...s, env: { ...s.env }, created: new Map(s.created), removed: new Set(s.removed) };
  let out = '';
  let delayMs = 0;
  let status = 0;
  let close = false;
  for (const { seg, op } of segs) {
    if ((op === '&&' && status !== 0) || (op === '||' && status === 0)) continue;
    const r = runSegment(world, scratch, seg);
    if (!r) return undefined;
    out += r.out;
    status = r.status;
    delayMs += r.delayMs ?? 0;
    if (r.close) { close = true; break; }
  }
  Object.assign(s, { cwd: scratch.cwd, env: scratch.env, created: scratch.created, removed: scratch.removed });
  return { output: out, delayMs, close };
}

/** After the LLM answers a compound line, apply the state changes its simple parts imply. */
export function applySideEffects(world: World, s: ShellSession, line: string): void {
  const segs = line.split(/&&|\|\||;/);
  for (const seg of segs) {
    if (seg.includes('|')) continue;
    try { runSegment(world, s, seg, true); } catch { /* best effort */ }
  }
}
