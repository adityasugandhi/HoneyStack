// Types for workstream C's plain-JS ingest module, so TypeScript callers can import it.
import type { Server } from 'node:http';

export function insertEvents(rows: object[]): Promise<void>;
export function insertShellTurn(row: object): Promise<void>;
export function listSessions(limit?: number): Promise<Record<string, unknown>[]>;
export function getTimeline(sessionId: string, limit?: number): Promise<Record<string, unknown>[]>;
export function getTurns(sessionId: string, limit?: number): Promise<Record<string, unknown>[]>;
export function getTimeWastedMs(sessionId: string): Promise<number>;
export function countByServedBy(sessionId: string): Promise<Record<string, unknown>[]>;
export function pingDatabase(): Promise<string>;
export function closeClient(): Promise<void>;
export function createIngestServer(env?: NodeJS.ProcessEnv, opts?: { insert?: (rows: object[]) => Promise<void> }): Server;
