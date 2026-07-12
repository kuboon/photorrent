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
  fetch(request: Request, env: Env): Response | Promise<Response> {
    setEnv(env);

    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const match = new URL(request.url).pathname.match(WS_PATH);
      if (match) {
        const stub = env.ROOM.get(
          env.ROOM.idFromName(decodeURIComponent(match[1])),
        );
        return stub.fetch(request);
      }
    }

    return router.fetch(request);
  },
};
