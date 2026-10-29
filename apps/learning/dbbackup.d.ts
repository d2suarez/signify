// Types for dbbackup.js (plain CommonJS, loaded by server.js and restore-db.js).
type Rows = Record<string, unknown>[];
type BackupDb = { query(text: string, params?: unknown[]): Promise<Rows>; exec(sql: string): Promise<void>; tx<T>(fn: (t: { query(text: string, params?: unknown[]): Promise<Rows> }) => Promise<T>): Promise<T> };
type Snapshot = { format: string; dumpedAt: string; migrations: string[]; excluded: string[]; tables: Record<string, { columns: { name: string; type: string }[]; rows: (string | null)[][] }> };
type Log = { log: (...a: unknown[]) => void; error: (...a: unknown[]) => void; warn?: (...a: unknown[]) => void };
export const FORMAT: string;
export const EXCLUDED: string[];
export const KEEP_DAYS: number;
export function dump(db: BackupDb): Promise<Snapshot>;
export function counts(s: Snapshot): Record<string, number>;
export function pack(s: Snapshot): Buffer;
export function unpack(bytes: Buffer, key?: Buffer): Snapshot;
export function maybeBackup(db: BackupDb, opts?: { now?: number; log?: Log }): Promise<{ ok: boolean; name?: string; rows?: number; skipped?: string; error?: string }>;
export function start(db: BackupDb, log?: Log): NodeJS.Timeout | null;
export function migrate(db: BackupDb): Promise<void>;
export function restore(db: BackupDb, s: Snapshot, opts?: { log?: Log }): Promise<{ ok: true; counts: Record<string, number>; dumpedAt: string }>;
export function _resetForTests(): void;
