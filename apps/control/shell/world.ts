import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface World {
  host: {
    hostname: string; user: string; uid: number; gid: number; home: string;
    shell: string; os: string; uname: string; ip: string; boot_cwd: string;
  };
  env: Record<string, string>;
  dirs: Record<string, string[]>;
  files: Record<string, string>;
  denied: string[];
  root_owned_writable_never: string[];
  sudo_l: string;
  sudo_backup_output: string;
  ps: string;
  network: {
    egress: string; dns: string; icmp?: string; resolv_timeout_ms: number; connect_timeout_ms: number;
    internal_hosts: Record<string, string>;
  };
  slow_commands: Record<string, number>;
  installed: string[];
  not_installed: string[];
  mtime: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const WORLD_PATH = process.env.WORLD_PATH || path.resolve(here, '../../../packages/shell/world.json');

export function loadWorld(file = WORLD_PATH): World {
  return JSON.parse(readFileSync(file, 'utf8')) as World;
}

/** Resolve `p` against `cwd` the way bash would, expanding a leading `~`. */
export function resolvePath(world: World, cwd: string, p: string): string {
  let target = p;
  if (target === '~' || target.startsWith('~/')) target = world.host.home + target.slice(1);
  const abs = target.startsWith('/') ? target : path.posix.join(cwd, target);
  const norm = path.posix.normalize(abs);
  return norm.length > 1 && norm.endsWith('/') ? norm.slice(0, -1) : norm;
}

/** `/home/node/x` -> `~/x`, for the prompt. */
export function displayPath(world: World, p: string): string {
  const home = world.host.home;
  if (p === home) return '~';
  if (p.startsWith(home + '/')) return '~' + p.slice(home.length);
  return p;
}

export function isDenied(world: World, p: string): boolean {
  return world.denied.some((d) => p === d || p.startsWith(d + '/'));
}

export function isRootOwned(world: World, p: string): boolean {
  if (p.startsWith(world.host.home) || p.startsWith('/tmp/')) return false;
  if (p === '/app' || (p.startsWith('/app/') && !p.startsWith('/app/scripts'))) return false;
  return true;
}
