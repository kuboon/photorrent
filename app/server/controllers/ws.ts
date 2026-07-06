/**
 * WebSocket upgrade handling for `/ws/:roomId`.
 *
 * IMPORTANT: the upgrade is intercepted at the top level (see `main.ts`) and
 * handled by {@link handleWsUpgrade} directly, NOT routed through
 * `@remix-run/fetch-router`. The router reconstructs the handler's `Response`,
 * which drops the `Sec-WebSocket-Extensions: permessage-deflate` header that
 * `Deno.upgradeWebSocket` negotiates — leaving the socket sending compressed
 * frames the client is told to treat as uncompressed ("Reserved bits are not
 * zero" / "Invalid frame header"). Returning the upgrade `Response` straight
 * from the top-level `Deno.serve` handler avoids that.
 *
 * The protocol (see `lib/protocol.ts`):
 *   - on open the client sends `join`; we register the socket and reply with a
 *     `snapshot`, then broadcast `presence`;
 *   - `add`/`remove` mutate the room index and fan out to peers;
 *   - `signal` is relayed verbatim to the addressed peer (Phase 2 WebRTC).
 */

import type { BuildAction } from "@remix-run/fetch-router";
import type { routes } from "../routes.ts";
import { hub } from "../lib/room_hub.ts";
import type { ClientMsg } from "../lib/protocol.ts";

/** Perform the WebSocket upgrade for a room and wire it to the hub. */
export function handleWsUpgrade(request: Request, roomId: string): Response {
  const { socket, response } = Deno.upgradeWebSocket(request);

  // peerId is assigned by the client's `join` message; until then the socket
  // is unregistered.
  let peerId: string | null = null;

  socket.onmessage = async (event) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      socket.send(JSON.stringify({ t: "error", message: "invalid json" }));
      return;
    }

    if (msg.t === "join") {
      peerId = msg.peerId;
      await hub.join(roomId, peerId, socket);
      return;
    }

    if (peerId === null) {
      socket.send(JSON.stringify({ t: "error", message: "join first" }));
      return;
    }

    await hub.handle(roomId, peerId, msg);
  };

  socket.onclose = () => {
    if (peerId !== null) hub.leave(roomId, peerId);
  };

  return response;
}

/**
 * Router action for `/ws/:roomId`. Real upgrades are intercepted upstream in
 * `main.ts`; this only handles the non-upgrade case (a plain GET), returning
 * 426 to say a WebSocket is required.
 */
export const wsAction = {
  handler(context) {
    if (
      context.request.headers.get("upgrade")?.toLowerCase() === "websocket"
    ) {
      // Shouldn't normally reach here (main.ts intercepts), but stay correct.
      return handleWsUpgrade(context.request, context.params.roomId);
    }
    return new Response("expected websocket upgrade", { status: 426 });
  },
} satisfies BuildAction<"GET", typeof routes.ws>;
