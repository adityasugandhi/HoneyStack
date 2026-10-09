import path from 'node:path';
import type { World } from './world';

export interface ShellSession {
  id: string;
  triggerEventId?: string;
  callback?: { ip: string; port: number };
  openedAt: number;
  lastSeenAt: number;
  cwd: string;
  env: Record<string, string>;
  /** Files and dirs the attacker created this session (path -> content; dirs map to null). */
  created: Map<string, string | null>;
  /** Paths the attacker deleted this session. */
  removed: Set<string>;
  history: string[];
  /** LLM answers to read-only commands, keyed by `${cwd}\0${command}`, so repeats stay identical. */
  llmCache: Map<string, string>;
  llmCalls: number;
  seq: number;
}

const SESSION_IDLE_MS = 30 * 60 * 1000;

export class SessionStore {
  private sessions = new Map<string, ShellSession>();

  constructor(private world: World) {}

  get(id: string): ShellSession | undefined {
    return this.sessions.get(id);
  }

  getOrCreate(id: string): ShellSession {
    let s = this.sessions.get(id);
    if (!s) {
      const now = Date.now();
      s = {
        id,
        openedAt: now,
        lastSeenAt: now,
        cwd: this.world.host.boot_cwd,
        env: { ...this.world.env },
        created: new Map(),
        removed: new Set(),
        history: [],
        llmCache: new Map(),
        llmCalls: 0,
        seq: 0,
      };
      this.sessions.set(id, s);
    }
    s.lastSeenAt = Date.now();
    this.sweep();
    return s;
  }

  private sweep() {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const [id, s] of this.sessions) if (s.lastSeenAt < cutoff) this.sessions.delete(id);
  }
}

/** The world as this session sees it: base world plus the attacker's own changes. */
export function listDir(world: World, s: ShellSession, dir: string): string[] | undefined {
  const base = world.dirs[dir];
  const createdHere = [...s.created.keys()].filter((p) => path.posix.dirname(p) === dir);
  if (!base && !s.created.has(dir)) return undefined;
  if (s.created.has(dir) && s.created.get(dir) !== null) return undefined; // it's a file
  const names = new Set([...(base ?? []), ...createdHere.map((p) => path.posix.basename(p))]);
  for (const r of s.removed) if (path.posix.dirname(r) === dir) names.delete(path.posix.basename(r));
  return [...names].sort();
}

export type Lookup =
  | { kind: 'dir'; implicit?: boolean }
  | { kind: 'file'; content: string | undefined }
  | { kind: 'missing' };

export function lookup(world: World, s: ShellSession, p: string): Lookup {
  if (s.removed.has(p)) return { kind: 'missing' };
  if (s.created.has(p)) {
    const c = s.created.get(p);
    return c === null ? { kind: 'dir' } : { kind: 'file', content: c };
  }
  if (world.dirs[p]) return { kind: 'dir' };
  if (p in world.files) return { kind: 'file', content: world.files[p] };
  // Listed in its parent directory but with no content defined: a real file the LLM may describe.
  const parentDir = path.posix.dirname(p);
  const name = path.posix.basename(p);
  const parent = world.dirs[parentDir];
  if (parent?.includes(name)) {
    // Undescribed entries without an extension (node_modules/next, /usr/lib, ...) are directories
    // whose contents the LLM fills in; bin dirs and /etc hold extensionless files.
    const binLike = /\/s?bin$/.test(parentDir) || parentDir === '/etc';
    if (!name.includes('.') && !binLike) return { kind: 'dir', implicit: true };
    if (name === '.aws' || name === '.npm' || name === '.next' || name === '.bin') return { kind: 'dir', implicit: true };
    return { kind: 'file', content: undefined };
  }
  return { kind: 'missing' };
}
