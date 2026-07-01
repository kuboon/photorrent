/**
 * Local (Deno) entry point. A single `Deno.serve` process that:
 *   - upgrades `/ws?room=<roomId>` to a control-plane WebSocket (signaling +
 *     manifest), backed by an in-memory room registry;
 *   - delegates all other requests to the Remix fetch-router (static assets,
 *     `GET /`, `GET /api/ice`).
 *
 * Prod runs on a Cloudflare Worker + Durable Object instead (see `worker/`),
 * reusing the same room/session/manifest modules.
 */

import { createAppRouter } from "./app/router.ts";
import type { ServerMessage } from "./src/protocol.ts";
import { RoomRegistry } from "./app/server/room.ts";
import { createSession } from "./app/server/session.ts";
import { createManifestStore } from "./app/server/store-factory.ts";

const store = createManifestStore();
const registry = new RoomRegistry();
const router = createAppRouter();

const port = Number(Deno.env.get("PORT") ?? 44100);

Deno.serve({ port }, (req) => {
  const url = new URL(req.url);
  if (url.pathname === "/ws") return handleWebSocket(req, url);
  return router.fetch(req);
});

console.log(`photorrent listening on http://localhost:${port}`);

function handleWebSocket(req: Request, url: URL): Response {
  const roomId = url.searchParams.get("room");
  if (!roomId || !/^[0-9a-f]{64}$/.test(roomId)) {
    return new Response("bad room", { status: 400 });
  }
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("expected websocket", { status: 426 });
  }

  const { socket, response } = Deno.upgradeWebSocket(req);
  const room = registry.get(roomId);
  const conn = {
    send(msg: ServerMessage) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(msg));
      }
    },
  };
  const session = createSession(
    roomId,
    room,
    store,
    conn,
    () => registry.dropIfEmpty(roomId),
  );

  socket.onmessage = (ev) => {
    if (typeof ev.data === "string") void session.onMessage(ev.data);
  };
  socket.onclose = () => session.onClose();
  socket.onerror = () => session.onClose();

  return response;
}
