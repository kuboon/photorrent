/**
 * `deno serve` entry point.
 *
 * A thin `fetch` wrapper around the fetch-router that intercepts WebSocket
 * upgrades for `/ws/:roomId` and handles them directly (see `controllers/ws.ts`
 * for why the router can't carry the upgrade Response). Everything else is
 * delegated to the router unchanged.
 */

import router from "./router.ts";
import { handleWsUpgrade } from "./controllers/ws.ts";

const WS_PATH = /^\/ws\/([^/]+)\/?$/;

export default {
  fetch(request: Request): Response | Promise<Response> {
    const isUpgrade =
      request.headers.get("upgrade")?.toLowerCase() === "websocket";
    if (isUpgrade) {
      const match = new URL(request.url).pathname.match(WS_PATH);
      if (match) {
        return handleWsUpgrade(request, decodeURIComponent(match[1]));
      }
    }
    return router.fetch(request);
  },
};
