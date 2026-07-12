/**
 * Deno-side persistence wiring: the native `@libsql/client` plus env-driven
 * client selection. Kept separate from `db_core.ts` (which is runtime-agnostic)
 * so the pure core can be imported on Cloudflare Workers without pulling in the
 * native client or `Deno.*`.
 *
 * Client selection (by env):
 *   - `TURSO_DATABASE_URL` (+ `TURSO_AUTH_TOKEN`) → remote Turso.
 *   - else `TURSO_LOCAL_URL` (default `file:./.data/photorrent.db`) → local
 *     libSQL for dev; tests pass `:memory:`.
 *
 * On Cloudflare Workers the Worker builds {@link Deps} from
 * `@libsql/client/web` instead (see `app/worker/edge_deps.ts`).
 */

import { type Client, createClient } from "@libsql/client";
import { type Deps, makeDeps } from "./db_core.ts";

export { type Deps, files, makeDeps } from "./db_core.ts";

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

/** The process-wide {@link Deps}, created from env on first call (Deno only). */
export function defaultDeps(): Deps {
  if (!defaults) defaults = makeDeps(clientFromEnv());
  return defaults;
}
