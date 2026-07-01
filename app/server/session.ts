/**
 * Shared control-plane message handling — the same logic runs under Deno's
 * in-memory registry and inside the Cloudflare Durable Object. It owns one
 * connection's lifecycle within a room: the `join` handshake, signaling relay,
 * and manifest append + broadcast.
 *
 * The per-connection peer id is accessed through a {@link PeerIdRef} so callers
 * can back it however they like — a closure variable (Deno) or a hibernatable
 * WebSocket attachment (Durable Object). The server never inspects
 * `signal.data`; it is relayed verbatim.
 */

import type { ClientMessage, ManifestEntry } from "../../src/protocol.ts";
import type { ManifestStore } from "./manifest-store.ts";
import type { Conn, RoomLive } from "./room.ts";

/** Storage for a connection's assigned peer id (closure or ws attachment). */
export interface PeerIdRef {
  get(): string | null;
  set(id: string): void;
}

/** Handle one inbound frame for a connection. */
export async function handleMessage(
  roomId: string,
  room: RoomLive,
  store: ManifestStore,
  conn: Conn,
  ref: PeerIdRef,
  raw: string,
): Promise<void> {
  let msg: ClientMessage;
  try {
    msg = JSON.parse(raw) as ClientMessage;
  } catch {
    return;
  }

  switch (msg.t) {
    case "join": {
      if (ref.get()) return; // already joined
      const peerId = msg.peerId;
      const manifest = await store.list(roomId);
      const peers = room.peerIds(); // existing peers, before we add ourselves
      ref.set(peerId);
      room.add(peerId, conn);
      conn.send({ t: "welcome", peers, manifest });
      room.broadcast({ t: "peer-join", peerId }, peerId);
      break;
    }
    case "signal": {
      const from = ref.get();
      if (!from) return;
      room.sendTo(msg.to, { t: "signal", to: msg.to, from, data: msg.data });
      break;
    }
    case "manifest-add": {
      if (!ref.get()) return;
      const entry = sanitizeEntry(msg.entry);
      if (!entry) return;
      await store.append(roomId, entry);
      room.broadcast({ t: "manifest-entry", entry });
      break;
    }
  }
}

/** Handle a connection close: drop it from the room and announce departure. */
export function handleClose(room: RoomLive, ref: PeerIdRef): void {
  const peerId = ref.get();
  if (!peerId) return;
  room.remove(peerId);
  room.broadcast({ t: "peer-leave", peerId });
}

// --- Deno convenience wrapper ----------------------------------------------

export interface Session {
  onMessage(raw: string): Promise<void>;
  onClose(): void;
  readonly peerId: string | null;
}

/** A per-connection session with the peer id held in a closure (Deno). */
export function createSession(
  roomId: string,
  room: RoomLive,
  store: ManifestStore,
  conn: Conn,
  onEmpty?: () => void,
): Session {
  let peerId: string | null = null;
  const ref: PeerIdRef = {
    get: () => peerId,
    set: (id) => {
      peerId = id;
    },
  };
  return {
    onMessage: (raw) => handleMessage(roomId, room, store, conn, ref, raw),
    onClose() {
      handleClose(room, ref);
      onEmpty?.();
    },
    get peerId() {
      return peerId;
    },
  };
}

/** Validate the shape of a client-supplied manifest entry before persisting. */
export function sanitizeEntry(entry: ManifestEntry): ManifestEntry | null {
  if (!entry || typeof entry !== "object") return null;
  const { hash, owner, size, encName, encThumb, addedAt } = entry;
  if (
    typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash) ||
    typeof owner !== "string" || owner.length === 0 || owner.length > 64 ||
    typeof size !== "number" || !Number.isFinite(size) || size < 0 ||
    typeof encName !== "string" ||
    typeof encThumb !== "string" ||
    typeof addedAt !== "number" || !Number.isFinite(addedAt)
  ) {
    return null;
  }
  return { hash, owner, size, encName, encThumb, addedAt };
}
