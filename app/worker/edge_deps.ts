/**
 * Cloudflare Workers runtime wiring: builds the Turso-backed {@link RoomStore}
 * from the Worker's `env` bindings, using the edge (`@libsql/client/web`) client
 * and R2 for thumbnail bytes.
 *
 * Mirrors `app/server/lib/stores.ts` (the Deno wiring) but sources everything
 * from `env` instead of `Deno.env`/native client. The shared, runtime-agnostic
 * modules (`db_core`, `index_store`, `object_store`, `room_hub`, `protocol`) are
 * reused unchanged.
 */

/// <reference path="./cf.d.ts" />
import { createClient } from "@libsql/client/web";
import { type Deps, makeDeps } from "../server/lib/db_core.ts";
import { createRoomStore, type RoomStore } from "../server/lib/index_store.ts";
import { R2ObjectStore } from "../server/lib/object_store.ts";
import type { R2BucketLike } from "../server/lib/object_store.ts";
import type { StoreFactory } from "../server/lib/room_hub.ts";

/** Worker environment bindings (see `wrangler.jsonc`). */
export interface Env {
  ROOM: DurableObjectNamespace;
  THUMB_BUCKET: R2BucketLike;
  ASSETS: Fetcher;
  TURSO_DATABASE_URL: string;
  TURSO_AUTH_TOKEN?: string;
}

let cached: Deps | null = null;

/** {@link Deps} over the edge libSQL client (cached per isolate). */
export function edgeDeps(env: Env): Deps {
  if (!cached) {
    cached = makeDeps(
      createClient({
        url: env.TURSO_DATABASE_URL,
        authToken: env.TURSO_AUTH_TOKEN,
      }),
    );
  }
  return cached;
}

/** A {@link StoreFactory} bound to this Worker's env (Turso + R2). The libSQL
 * client is built lazily on first room use (not when the DO is constructed), so
 * a WebSocket can be accepted before any DB call. */
export function edgeStoreFactory(env: Env): StoreFactory {
  return (roomId: string): RoomStore =>
    createRoomStore(roomId, {
      deps: edgeDeps(env),
      objectStore: new R2ObjectStore(env.THUMB_BUCKET),
    });
}

// The Worker's env is stable per isolate; capture it on first fetch so the
// fetch-router controllers (which only receive a Request) can reach storage.
let ENV: Env | null = null;
export function setEnv(env: Env): void {
  ENV = env;
}
export function requireEnv(): Env {
  if (!ENV) throw new Error("worker env not initialized");
  return ENV;
}

/** Build a room store for the current Worker env (used by the API handlers). */
export function edgeRoomStore(roomId: string): RoomStore {
  return edgeStoreFactory(requireEnv())(roomId);
}
