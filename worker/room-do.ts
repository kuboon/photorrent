/**
 * Cloudflare Durable Object: one instance per `roomId` holds the live sockets,
 * relays signaling, and broadcasts manifest entries — the prod counterpart to
 * Deno's in-memory `RoomRegistry`. Uses the WebSocket Hibernation API so idle
 * parties don't accrue duration charges.
 *
 * Because hibernation drops in-memory JS state, per-connection state (the room
 * id and the peer id) lives in each socket's serialized attachment, and room
 * membership is derived on demand from `ctx.getWebSockets()`. All the actual
 * protocol logic is the shared `session.ts` handler.
 */

import { DurableObject } from "cloudflare:workers";
import { createClient } from "@libsql/client/web";

import type { ServerMessage } from "../src/protocol.ts";
import type { Conn, RoomLive } from "../app/server/room.ts";
import {
  handleClose,
  handleMessage,
  type PeerIdRef,
} from "../app/server/session.ts";
import {
  MemoryManifestStore,
  type ManifestStore,
  TursoManifestStore,
} from "../app/server/manifest-store.ts";

interface Env {
  TURSO_DATABASE_URL?: string;
  TURSO_AUTH_TOKEN?: string;
}

interface Attachment {
  roomId?: string;
  peerId?: string;
}

export class RoomDurableObject extends DurableObject<Env> {
  #store: ManifestStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#store = env.TURSO_DATABASE_URL
      ? new TursoManifestStore(
        createClient({
          url: env.TURSO_DATABASE_URL,
          authToken: env.TURSO_AUTH_TOKEN,
        }),
      )
      : new MemoryManifestStore();
  }

  override fetch(req: Request): Response {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const roomId = new URL(req.url).searchParams.get("room") ?? "";
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ roomId } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (typeof message !== "string") return;
    const att = (ws.deserializeAttachment() ?? {}) as Attachment;
    const ref: PeerIdRef = {
      get: () => att.peerId ?? null,
      set: (id) => {
        att.peerId = id;
        ws.serializeAttachment(att);
      },
    };
    const conn: Conn = {
      send: (msg: ServerMessage) => {
        try {
          ws.send(JSON.stringify(msg));
        } catch {
          // socket closing; ignore
        }
      },
    };
    await handleMessage(att.roomId ?? "", this.#room(), this.#store, conn, ref, message);
  }

  override webSocketClose(ws: WebSocket): void {
    const att = (ws.deserializeAttachment() ?? {}) as Attachment;
    handleClose(this.#room(), {
      get: () => att.peerId ?? null,
      set: () => {},
    });
    try {
      ws.close();
    } catch {
      // already closed
    }
  }

  override webSocketError(ws: WebSocket): void {
    this.webSocketClose(ws);
  }

  /** A RoomLive view over the DO's currently-attached sockets. */
  #room(): RoomLive {
    const ctx = this.ctx;
    const peerIdOf = (ws: WebSocket): string | null =>
      (ws.deserializeAttachment() as Attachment | null)?.peerId ?? null;

    return {
      add() {}, // membership is tracked by the runtime, not a map
      remove() {},
      peerIds(exclude?: string): string[] {
        const ids: string[] = [];
        for (const ws of ctx.getWebSockets()) {
          const id = peerIdOf(ws);
          if (id && id !== exclude) ids.push(id);
        }
        return ids;
      },
      broadcast(msg: ServerMessage, exclude?: string): void {
        const payload = JSON.stringify(msg);
        for (const ws of ctx.getWebSockets()) {
          const id = peerIdOf(ws);
          if (!id || id === exclude) continue;
          try {
            ws.send(payload);
          } catch {
            // ignore
          }
        }
      },
      sendTo(peerId: string, msg: ServerMessage): void {
        const payload = JSON.stringify(msg);
        for (const ws of ctx.getWebSockets()) {
          if (peerIdOf(ws) === peerId) {
            try {
              ws.send(payload);
            } catch {
              // ignore
            }
            return;
          }
        }
      },
    };
  }
}
