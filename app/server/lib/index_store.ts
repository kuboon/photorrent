/**
 * Per-room storage for the file index and thumbnails, Turso-backed.
 *
 * Three backends, composed behind the {@link RoomStore} interface so the hub is
 * agnostic to them:
 *   - **index** (FileMeta rows) → `@remix-run/data-table` `files` table.
 *   - **thumbnail bytes** → {@link ObjectStore} (local dir in dev, R2 in prod).
 *   - **thumbnail content-type** → `@kuboon/kv/turso.ts` (`TursoKvRepo`).
 *
 * Rooms share one database; isolation is by the `room` column / key prefix.
 */

import { TursoKvRepo } from "@kuboon/kv/turso.ts";
import { sql } from "@remix-run/data-table";
import type { Client } from "@libsql/client";
import type { FileMeta } from "./protocol.ts";
import { type Deps, files } from "./db_core.ts";
import type { ObjectStore } from "./object_store.ts";

/** Stored thumbnail: raw bytes plus their content-type. */
export interface Thumb {
  bytes: Uint8Array<ArrayBuffer>;
  ct: string;
}

/** Storage for a single room's index + thumbnails. */
export interface RoomStore {
  addFile(file: FileMeta): Promise<void>;
  removeFile(id: string): Promise<void>;
  listFiles(): Promise<FileMeta[]>;
  putThumb(id: string, thumb: Thumb): Promise<void>;
  getThumb(id: string): Promise<Thumb | null>;
}

/** Injected backends. Required so this module stays free of any runtime-
 * specific defaults (Deno env / native client) and imports cleanly on the
 * edge; the Deno wiring lives in `stores.ts`, the Worker's in `edge_deps.ts`. */
export interface RoomStoreDeps {
  deps: Deps;
  objectStore: ObjectStore;
  /** libSQL client for the thumbnail-content-type KV. Defaults to `deps.client`. */
  kvClient?: Client;
}

type FileRow = {
  file_id: string;
  filename: string;
  size: number;
  mime: string;
  width: number;
  height: number;
  uploader: string;
  uploader_name: string | null;
  created_at: number;
};

export function createRoomStore(
  roomId: string,
  backends: RoomStoreDeps,
): RoomStore {
  const { deps, objectStore } = backends;
  const kvClient = backends.kvClient ?? deps.client;
  const thumbCt = new TursoKvRepo<{ ct: string }>(
    kvClient,
    ["room", roomId, "thumbct"],
  );

  const rowKey = (fileId: string) => `${roomId}/${fileId}`;

  const toMeta = (row: FileRow): FileMeta => ({
    id: row.file_id,
    filename: row.filename,
    size: Number(row.size),
    mime: row.mime,
    width: Number(row.width),
    height: Number(row.height),
    thumbUrl: `/api/room/${roomId}/thumb?id=${row.file_id}`,
    uploader: row.uploader,
    ...(row.uploader_name ? { uploaderName: row.uploader_name } : {}),
    createdAt: Number(row.created_at),
  });

  return {
    async addFile(file) {
      await deps.ensureSchema();
      // Idempotent upsert — re-adding the same content id refreshes metadata.
      await deps.db.exec(sql`
        INSERT INTO files
          (id, room, file_id, filename, size, mime, width, height, uploader, uploader_name, created_at)
        VALUES
          (${rowKey(file.id)}, ${roomId}, ${file.id}, ${file.filename},
           ${file.size}, ${file.mime}, ${file.width}, ${file.height},
           ${file.uploader}, ${file.uploaderName ?? null}, ${file.createdAt})
        ON CONFLICT(id) DO UPDATE SET
          filename = excluded.filename, size = excluded.size,
          mime = excluded.mime, width = excluded.width,
          height = excluded.height, uploader = excluded.uploader,
          uploader_name = excluded.uploader_name,
          created_at = excluded.created_at`);
    },

    async removeFile(id) {
      await deps.ensureSchema();
      await deps.db.exec(sql`DELETE FROM files WHERE id = ${rowKey(id)}`);
      await thumbCt.entry(id).update(() => null);
    },

    async listFiles() {
      await deps.ensureSchema();
      const rows = await deps.db.findMany(files, {
        where: { room: roomId },
        orderBy: ["created_at", "asc"],
      }) as unknown as FileRow[];
      return rows.map(toMeta);
    },

    async putThumb(id, thumb) {
      await objectStore.put(rowKey(id), thumb.bytes);
      await thumbCt.entry(id).update(() => ({ ct: thumb.ct }));
    },

    async getThumb(id) {
      const bytes = await objectStore.get(rowKey(id));
      if (!bytes) return null;
      const meta = await thumbCt.entry(id).get();
      return {
        bytes: bytes as Uint8Array<ArrayBuffer>,
        ct: meta?.ct ?? "image/jpeg",
      };
    },
  };
}
