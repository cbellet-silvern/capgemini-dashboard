/**
 * SQLite access, server-side only.
 *
 * Uses Node's built-in `node:sqlite` — no native module to compile, no ORM. The
 * cost of that is that we write SQL by hand, so there is one hard rule in this
 * file and everywhere that calls it:
 *
 *   Every value that comes from a request, a search param, or a form goes in as
 *   a `?` placeholder. Never interpolated into the SQL string. Where a query
 *   needs a dynamic *identifier* (a sort column, say), it is resolved through an
 *   allow-list map — see `sortClause` below — never passed through.
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

export type SqlParam = string | number | bigint | null | Uint8Array;

const DB_PATH = path.join(process.cwd(), "data", "ledger.db");

// Dev hot-reload re-evaluates modules; without this we would leak a file handle
// on every save.
const globalForDb = globalThis as unknown as {
  __ledgerDb?: DatabaseSync;
  __ledgerDbId?: string;
};

/**
 * The inode of the file currently on disk.
 *
 * `npm run reset` deletes `ledger.db` and writes a new one. A cached connection
 * survives that — it keeps reading the *deleted* inode, so the app serves data
 * that no longer exists, with no error anywhere. That is a genuinely bad failure
 * mode in a demo: the pages render perfectly and every number is wrong.
 *
 * The inode is the right signal precisely because it changes when the file is
 * *replaced* and not when it is written to. Size or mtime would also trip on our
 * own writes, which would reopen the connection mid-transaction and strand an
 * open BEGIN on a handle nothing will commit.
 */
function inode(): number {
  return statSync(DB_PATH).ino;
}

/** Set while a transaction is open, so a reopen cannot strand it. */
let inTransaction = false;

export function getDb(): DatabaseSync {
  if (globalForDb.__ledgerDb && inTransaction) return globalForDb.__ledgerDb;

  if (!existsSync(DB_PATH)) {
    throw new Error(
      `No database at ${DB_PATH}.\n\n` +
        `Build the demo dataset first:\n\n    npm run seed\n\n` +
        `It is deterministic — the same data every time.`,
    );
  }

  const id = String(inode());
  if (globalForDb.__ledgerDb) {
    if (globalForDb.__ledgerDbId === id) return globalForDb.__ledgerDb;
    // Replaced underneath us — release the handle on the old inode and reopen.
    try {
      globalForDb.__ledgerDb.close();
    } catch {
      // Already gone; nothing to release.
    }
    globalForDb.__ledgerDb = undefined;
  }

  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA foreign_keys = ON");
  globalForDb.__ledgerDb = db;
  globalForDb.__ledgerDbId = id;
  return db;
}

/**
 * `node:sqlite` hands back null-prototype objects. React cannot serialise those
 * across the server/client boundary, so every row is copied into a plain object
 * on the way out. Do not remove this — the failure mode is an opaque
 * "Objects are not valid as a React child" at render time.
 */
function plain<T>(row: unknown): T {
  return { ...(row as object) } as T;
}

export function all<T>(sql: string, params: SqlParam[] = []): T[] {
  const rows = getDb()
    .prepare(sql)
    .all(...params);
  return rows.map((r) => plain<T>(r));
}

export function get<T>(sql: string, params: SqlParam[] = []): T | undefined {
  const row = getDb()
    .prepare(sql)
    .get(...params);
  return row === undefined ? undefined : plain<T>(row);
}

export function run(sql: string, params: SqlParam[] = []): void {
  getDb()
    .prepare(sql)
    .run(...params);
}

/** A single scalar, e.g. `scalar<number>('SELECT COUNT(*) c FROM x')`. */
export function scalar<T>(sql: string, params: SqlParam[] = []): T | undefined {
  const row = get<Record<string, unknown>>(sql, params);
  if (!row) return undefined;
  const first = Object.values(row)[0];
  return first as T;
}

/** Wraps `fn` in a transaction; rolls back on throw. */
export function tx<T>(fn: () => T): T {
  const db = getDb();
  db.exec("BEGIN");
  inTransaction = true;
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  } finally {
    // Cleared in `finally` so a throw cannot leave the reopen check disabled for
    // the rest of the process.
    inTransaction = false;
  }
}

/**
 * Builds an `IN (?, ?, ?)` fragment with a matching placeholder for each value.
 * Returns null for an empty list so callers can skip the clause entirely rather
 * than emit `IN ()`, which is a syntax error.
 */
export function inClause(values: readonly SqlParam[]): { sql: string; params: SqlParam[] } | null {
  if (values.length === 0) return null;
  return { sql: `(${values.map(() => "?").join(", ")})`, params: [...values] };
}

/**
 * Resolves a user-supplied sort key through an allow-list. Anything unknown
 * falls back to the default — a sort key is an identifier, so it can never be
 * parameterised and must never be concatenated straight from input.
 */
export function sortClause<K extends string>(
  requested: string | undefined,
  allowed: Record<K, string>,
  fallback: K,
): string {
  if (requested && Object.prototype.hasOwnProperty.call(allowed, requested)) {
    return allowed[requested as K];
  }
  return allowed[fallback];
}
