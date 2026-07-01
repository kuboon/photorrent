/**
 * Cloudflare Worker entry (prod). Routes:
 *   - `/ws?room=<id>`  -> the room's Durable Object (signaling + manifest)
 *   - `/api/ice`       -> STUN + minted TURN credentials
 *   - `/`              -> the app shell
 *   - everything else  -> static assets (style.css, favicon.svg, mod.js)
 *
 * Reuses the same `ice.ts`, `shell.ts`, and `session.ts` modules as the Deno
 * server; only the transport wiring differs.
 */

import { iceResponse } from "../app/server/ice.ts";
import { shellHtml } from "../app/ui/shell.ts";

export { RoomDurableObject } from "./room-do.ts";

export interface Env {
  ROOM: DurableObjectNamespace;
  ASSETS: Fetcher;
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
  TURSO_DATABASE_URL?: string;
  TURSO_AUTH_TOKEN?: string;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/ws") {
      const roomId = url.searchParams.get("room");
      if (!roomId || !/^[0-9a-f]{64}$/.test(roomId)) {
        return new Response("bad room", { status: 400 });
      }
      const stub = env.ROOM.get(env.ROOM.idFromName(roomId));
      return stub.fetch(req);
    }

    if (url.pathname === "/api/ice") {
      return iceResponse(env);
    }

    if (url.pathname === "/") {
      return new Response(shellHtml(), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
