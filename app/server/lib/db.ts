/**
 * Persistence wiring: a libSQL (Turso) client plus the `@remix-run/data-table`
 * database built on it. Everything is created lazily on first use so importing
 * this module (e.g. in tests, or during SSR) has no side effects and reads no
 * env until a query actually runs.
 *
 * Client selection (by env):
 *   - `TURSO_DATABASE_URL` (+ `TURSO_AUTH_TOKEN`) → remote Turso (production).
 *   - else `TURSO_LOCAL_URL` (default `file:./.data/photorrent.db`) → local
 *     libSQL for dev; tests pass `:memory:`.
 *
 * On Cloudflare Workers the same schema is used, but the client must come from
 * `@libsql/client/web` (edge, fetch-based) instead of the native client here —
 * that swap lands with the Durable Object port.
 */

import { type Client, createClient } from "@libsql/client";
import {
  column as c,
  createDatabase,
  type Database,
  sql,
  table,
} from "@remix-run/data-table";
import { createTursoDatabaseAdapter } from "@kuboon/remix-data-table-sqlite-turso";

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
  created_at INTEGER NOT NULL
)`;
const CREATE_ROOM_IDX =
  sql`CREATE INDEX IF NOT EXISTS files_room ON files (room)`;

/** A libSQL client plus the data-table DB built on it, with lazy migration. */
export interface Deps {
  client: Client;
  db: Database;
  ensureSchema(): Promise<void>;
}

const schemaEnsured = new WeakMap<Client, Promise<void>>();

/** Build {@link Deps} for a specific client (used by tests with `:memory:`). */
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
          await db.exec(CREATE_ROOM_IDX);
        })();
        schemaEnsured.set(client, p);
      }
      return p;
    },
  };
}

function clientFromEnv(): Client {
  const url = Deno.env.get("TURSO_DATABASE_URL");
  if (url) {
    const authToken = Deno.env.get("TURSO_AUTH_TOKEN") ?? undefined;
    return createClient({ url, authToken });
  }
  const local = Deno.env.get("TURSO_LOCAL_URL") ?? "file:./.data/photorrent.db";
  // Ensure the parent directory exists for a local `file:` database.
  const path = local.startsWith("file:") ? local.slice("file:".length) : null;
  if (path && path !== ":memory:") {
    const slash = path.lastIndexOf("/");
    if (slash > 0) {
      try {
        Deno.mkdirSync(path.slice(0, slash), { recursive: true });
      } catch { /* already exists */ }
    }
  }
  return createClient({ url: local });
}

let defaults: Deps | null = null;

/** The process-wide {@link Deps}, created from env on first call. */
export function defaultDeps(): Deps {
  if (!defaults) defaults = makeDeps(clientFromEnv());
  return defaults;
}
