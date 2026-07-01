/**
 * Persistence for the append-only encrypted manifest. The server stores only
 * ciphertext metadata (see {@link ManifestEntry}) — never photo bytes and never
 * the party key.
 *
 * Two backends: Turso (libSQL) for real deployments (reachable from both Deno
 * and the Cloudflare Worker), and an in-memory fallback for local dev / tests
 * when no database URL is configured.
 */

import type { ManifestEntry } from "../../src/protocol.ts";

/**
 * Minimal structural view of a libSQL client — just the `execute` surface we
 * use. Both `@libsql/client` (Deno/Node) and `@libsql/client/web` (Worker)
 * satisfy it, so the shared store doesn't depend on either package's types
 * (which resolve differently across the two toolchains).
 */
interface LibsqlRow {
  [column: string]: unknown;
}
interface LibsqlResult {
  rows: LibsqlRow[];
}
export interface LibsqlClient {
  execute(
    stmt: string | { sql: string; args: unknown[] },
  ): Promise<LibsqlResult>;
}

export interface ManifestStore {
  /** Append an entry for a room (idempotent on `(roomId, hash)`). */
  append(roomId: string, entry: ManifestEntry): Promise<void>;
  /** All entries for a room, oldest first. */
  list(roomId: string): Promise<ManifestEntry[]>;
}

// ---------------------------------------------------------------------------
// in-memory fallback
// ---------------------------------------------------------------------------

export class MemoryManifestStore implements ManifestStore {
  #rooms = new Map<string, Map<string, ManifestEntry>>();

  append(roomId: string, entry: ManifestEntry): Promise<void> {
    let room = this.#rooms.get(roomId);
    if (!room) {
      room = new Map();
      this.#rooms.set(roomId, room);
    }
    if (!room.has(entry.hash)) room.set(entry.hash, entry);
    return Promise.resolve();
  }

  list(roomId: string): Promise<ManifestEntry[]> {
    const room = this.#rooms.get(roomId);
    const entries = room ? [...room.values()] : [];
    entries.sort((a, b) => a.addedAt - b.addedAt);
    return Promise.resolve(entries);
  }
}

// ---------------------------------------------------------------------------
// Turso (libSQL)
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS manifest (
  room_id   TEXT NOT NULL,
  hash      TEXT NOT NULL,
  owner     TEXT NOT NULL,
  size      INTEGER NOT NULL,
  enc_name  TEXT NOT NULL,
  enc_thumb TEXT NOT NULL,
  added_at  INTEGER NOT NULL,
  PRIMARY KEY (room_id, hash)
);
`;

export class TursoManifestStore implements ManifestStore {
  #ready: Promise<void>;

  constructor(private readonly client: LibsqlClient) {
    this.#ready = this.client.execute(SCHEMA).then(() => {});
  }

  async append(roomId: string, entry: ManifestEntry): Promise<void> {
    await this.#ready;
    await this.client.execute({
      sql: `INSERT OR IGNORE INTO manifest
          (room_id, hash, owner, size, enc_name, enc_thumb, added_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        roomId,
        entry.hash,
        entry.owner,
        entry.size,
        entry.encName,
        entry.encThumb,
        entry.addedAt,
      ],
    });
  }

  async list(roomId: string): Promise<ManifestEntry[]> {
    await this.#ready;
    const result = await this.client.execute({
      sql: `SELECT hash, owner, size, enc_name, enc_thumb, added_at
         FROM manifest WHERE room_id = ? ORDER BY added_at ASC`,
      args: [roomId],
    });
    return result.rows.map((row) => ({
      hash: row.hash as string,
      owner: row.owner as string,
      size: Number(row.size),
      encName: row.enc_name as string,
      encThumb: row.enc_thumb as string,
      addedAt: Number(row.added_at),
    }));
  }
}
