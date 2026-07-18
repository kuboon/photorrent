/**
 * RoomDO — one Durable Object instance per room. It owns the room's live state:
 * the connected WebSockets plus the holders/presence tracking, via a reused
 * {@link RoomHub} (the same class the Deno server uses — it only needs a `Sink`
 * duck type, which a Cloudflare WebSocket satisfies). Index/thumbnail writes go
 * to Turso/R2 through the edge store factory.
 *
 * The Worker routes every `/ws/:roomId` upgrade to `env.ROOM.get(idFromName(
 * roomId))`, so all of a room's sockets land in the same instance and can be
 * fanned out to.
 */

/// <reference path="./cf.d.ts" />
import { RoomHub } from "../server/lib/room_hub.ts";
import type { ClientMsg } from "../server/lib/protocol.ts";
import { edgeStoreFactory, type Env } from "./edge_deps.ts";

export class RoomDO {
  private hub: RoomHub;

  constructor(_state: DurableObjectState, env: Env) {
    this.hub = new RoomHub(edgeStoreFactory(env));
  }

  fetch(request: Request): Response {
    const roomId = new URL(request.url).pathname.replace(/^\/ws\//, "")
      .replace(/\/$/, "");
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    let peerId: string | null = null;

    server.addEventListener("message", async (event) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        server.send(JSON.stringify({ t: "error", message: "invalid json" }));
        return;
      }
      try {
        if (msg.t === "join") {
          peerId = msg.peerId;
          await this.hub.join(roomId, peerId, server);
          return;
        }
        if (peerId === null) {
          server.send(JSON.stringify({ t: "error", message: "join first" }));
          return;
        }
        await this.hub.handle(roomId, peerId, msg);
      } catch (err) {
        const e = err as Error;
        console.error("[room_do]", roomId, msg.t, e?.stack ?? e);
        server.send(
          JSON.stringify({
            t: "error",
            message: `${msg.t}: ${e?.message ?? e}`,
          }),
        );
      }
    });

    server.addEventListener("close", () => {
      if (peerId !== null) this.hub.leave(roomId, peerId);
    });

    return new Response(null, { status: 101, webSocket: client });
  }
}
