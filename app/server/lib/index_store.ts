/**
 * Per-room storage for the file index and thumbnail bytes.
 *
 * Backed by `@kuboon/kv`'s {@link KvRepo}. Phase 1 uses the in-memory backend
 * ({@link MemoryKvRepo}); swapping to Deno KV for multi-process persistence is
 * a one-line change here (construct {@link DenoKvRepo} instead) — the rest of
 * the app only sees the {@link RoomStore} interface.
 *
 * IMPORTANT: each room gets its **own** repo instance. `MemoryKvRepo`'s async
 * iterator walks that instance's whole backing map, so sharing one instance
 * across rooms would leak files between rooms during snapshots.
 */

import type { KvRepo } from "@kuboon/kv";
import { MemoryKvRepo } from "@kuboon/kv/memory.ts";
import type { FileMeta } from "./protocol.ts";

/** Stored thumbnail: raw bytes plus their content-type. */
export interface Thumb {
  bytes: Uint8Array<ArrayBuffer>;
  ct: string;
}

/** Abandoned rooms self-evict after this long with no writes. */
const ROOM_TTL_MS = 12 * 60 * 60 * 1000;

/** Storage for a single room's index + thumbnails. */
export interface RoomStore {
  /** Insert or replace a file's metadata. */
  addFile(file: FileMeta): Promise<void>;
  /** Delete a file's metadata (thumbnail is left to expire). */
  removeFile(id: string): Promise<void>;
  /** All files currently in the room, newest first. */
  listFiles(): Promise<FileMeta[]>;
  /** Store a thumbnail's bytes. */
  putThumb(id: string, thumb: Thumb): Promise<void>;
  /** Fetch a thumbnail's bytes, or null if unknown/expired. */
  getThumb(id: string): Promise<Thumb | null>;
}

/** Create an in-memory {@link RoomStore} for one room. */
export function createRoomStore(roomId: string): RoomStore {
  const index: KvRepo<FileMeta> = new MemoryKvRepo<FileMeta>(
    ["room", roomId, "file"],
    { expireIn: ROOM_TTL_MS },
  );
  const thumbs: KvRepo<Thumb> = new MemoryKvRepo<Thumb>(
    ["room", roomId, "thumb"],
    { expireIn: ROOM_TTL_MS },
  );

  return {
    async addFile(file) {
      await index.entry(file.id).update(() => file);
    },
    async removeFile(id) {
      await index.entry(id).update(() => null);
    },
    async listFiles() {
      const files: FileMeta[] = [];
      for await (const entry of index) {
        const file = await entry.get();
        if (file) files.push(file);
      }
      files.sort((a, b) => a.createdAt - b.createdAt);
      return files;
    },
    async putThumb(id, thumb) {
      await thumbs.entry(id).update(() => thumb);
    },
    async getThumb(id) {
      return await thumbs.entry(id).get();
    },
  };
}
