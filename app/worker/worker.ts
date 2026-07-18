/// <reference path="./cf.d.ts" />
/**
 * Cloudflare Workers entry point.
 *
 * WebSocket upgrades for `/ws/:roomId` are routed to that room's Durable Object
 * (one instance per room, keyed by `idFromName(roomId)`), which owns the live
 * connections + holders. Everything else goes to the fetch-router (SSR + REST).
 * Static client assets under `bundled/` are served by the Workers Assets
 * binding before the Worker runs, so they never reach here.
 */

import { RoomDO } from "./room_do.ts";
import { type Env, setEnv } from "./edge_deps.ts";
import router from "./router.ts";

const WS_PATH = /^\/ws\/([^/]+)\/?$/;

export { RoomDO };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    setEnv(env);

    try {
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const match = new URL(request.url).pathname.match(WS_PATH);
        if (match) {
          const stub = env.ROOM.get(
            env.ROOM.idFromName(decodeURIComponent(match[1])),
          );
          return await stub.fetch(request);
        }
      }

      return await router.fetch(request);
    } catch (err) {
      // Surface the failure to Workers Logs (observability) *and* the response
      // body so a 500 isn't opaque while we validate the edge storage wiring.
      const e = err as Error;
      const url = new URL(request.url);
      console.error("[worker] unhandled error", url.pathname, e?.stack ?? e);
      return new Response(
        `worker error at ${url.pathname}: ${e?.message ?? e}\n${
          e?.stack ?? ""
        }`,
        { status: 500, headers: { "content-type": "text/plain" } },
      );
    }
  },
};
