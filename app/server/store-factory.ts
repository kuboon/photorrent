/**
 * Pick a manifest backend from the environment (Deno). Uses Turso when
 * `TURSO_DATABASE_URL` is set, otherwise an in-memory store for local dev.
 */

import { createClient } from "@libsql/client";
import {
  type ManifestStore,
  MemoryManifestStore,
  TursoManifestStore,
} from "./manifest-store.ts";

export function createManifestStore(): ManifestStore {
  const url = Deno.env.get("TURSO_DATABASE_URL");
  if (!url) {
    console.warn("[store] TURSO_DATABASE_URL unset — using in-memory manifest");
    return new MemoryManifestStore();
  }
  const authToken = Deno.env.get("TURSO_AUTH_TOKEN");
  return new TursoManifestStore(createClient({ url, authToken }));
}
