/**
 * Deno-side runtime wiring: the process-wide {@link RoomHub} singleton backed by
 * the native libSQL client + local/R2 object store. Kept separate from the pure
 * `room_hub.ts` / `index_store.ts` so those can run inside a Cloudflare Durable
 * Object (which wires its own edge backends in `app/worker/edge_deps.ts`).
 */

import { RoomHub } from "./room_hub.ts";
import { createRoomStore, type RoomStore } from "./index_store.ts";
import { defaultDeps } from "./db.ts";
import { defaultObjectStore } from "./object_store.ts";

/** A Turso/local-backed {@link RoomStore} for a room (Deno runtime). */
export function denoRoomStore(roomId: string): RoomStore {
  return createRoomStore(roomId, {
    deps: defaultDeps(),
    objectStore: defaultObjectStore(),
  });
}

/** Process-wide hub used by the Deno controllers. */
export const hub = new RoomHub(denoRoomStore);
