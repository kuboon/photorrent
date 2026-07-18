/**
 * Runtime-agnostic persistence core: the `files` table schema plus a factory
 * that builds an `@remix-run/data-table` database over any libSQL {@link Client}.
 *
 * This module has NO native or Deno dependencies (the libSQL `Client` is a
 * type-only import, and the data-table adapter is pure JS), so it imports
 * cleanly on both Deno and Cloudflare Workers. The concrete client is provided
 * by the runtime: `db.ts` (Deno, native `@libsql/client`) or the Worker
 * (`@libsql/client/web`).
 */

import {
  column as c,
  createDatabase,
  type Database,
  sql,
  table,
} from "@remix-run/data-table";
import { createTursoDatabaseAdapter } from "@kuboon/remix-data-table-sqlite-turso";
import type { Client } from "@libsql/client";

/** The file index table. `id` is the composite `${roomId}/${fileId}` primary
 * key (the same content hash can appear in more than one room); `file_id` is
 * the bare content hash returned to clients. */
export const files = table({
  name: "files",
  columns: {
    id: c.varchar(255),
    room: c.varchar(255),
    file_id: c.varchar(255),
    filename: c.varchar(255),
    size: c.integer(),
    mime: c.varchar(255),
    width: c.integer(),
    height: c.integer(),
    uploader: c.varchar(255),
    uploader_name: c.varchar(255),
    created_at: c.integer(),
  },
});

const CREATE_FILES = sql`CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  room TEXT NOT NULL,
  file_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  size INTEGER NOT NULL,
  mime TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  uploader TEXT NOT NULL,
  uploader_name TEXT,
  created_at INTEGER NOT NULL
)`;
// Additive migration for databases created before `uploader_name` existed.
// Fresh DBs already have the column (from CREATE above), so this throws
// "duplicate column name" there — which we swallow.
const ADD_UPLOADER_NAME = sql`ALTER TABLE files ADD COLUMN uploader_name TEXT`;
const CREATE_ROOM_IDX =
  sql`CREATE INDEX IF NOT EXISTS files_room ON files (room)`;

/** A libSQL client plus the data-table DB built on it, with lazy migration. */
export interface Deps {
  client: Client;
  db: Database;
  ensureSchema(): Promise<void>;
}

const schemaEnsured = new WeakMap<Client, Promise<void>>();

/** Build {@link Deps} for a specific client (tests pass `:memory:`, the Worker
 * passes a `@libsql/client/web` client). */
export function makeDeps(client: Client): Deps {
  const db = createDatabase(createTursoDatabaseAdapter(client));
  return {
    client,
    db,
    ensureSchema() {
      let p = schemaEnsured.get(client);
      if (!p) {
        p = (async () => {
          await db.exec(CREATE_FILES);
          try {
            await db.exec(ADD_UPLOADER_NAME);
          } catch {
            // Column already present (fresh DB) — nothing to migrate.
          }
          await db.exec(CREATE_ROOM_IDX);
        })();
        schemaEnsured.set(client, p);
      }
      return p;
    },
  };
}
