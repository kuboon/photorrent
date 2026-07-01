/**
 * The live room: the ephemeral set of connected sockets for one `roomId`, plus
 * fan-out and directed send. This is the only stateful, environment-specific
 * piece — Deno backs it with an in-memory registry, Cloudflare with a Durable
 * Object per room. The message-handling logic (`session.ts`) is shared.
 */

import type { ServerMessage } from "../../src/protocol.ts";

/** A single connected participant's outbound channel. */
export interface Conn {
  send(msg: ServerMessage): void;
}

/** The live socket set + routing primitives for one room. */
export interface RoomLive {
  add(peerId: string, conn: Conn): void;
  remove(peerId: string): void;
  /** Peer ids currently in the room, optionally excluding one. */
  peerIds(exclude?: string): string[];
  /** Send to every peer, optionally excluding one (usually the sender). */
  broadcast(msg: ServerMessage, exclude?: string): void;
  /** Send to a single peer, if present. */
  sendTo(peerId: string, msg: ServerMessage): void;
}

/** In-memory implementation shared by Deno and the Durable Object. */
export class MemoryRoom implements RoomLive {
  #conns = new Map<string, Conn>();

  add(peerId: string, conn: Conn): void {
    this.#conns.set(peerId, conn);
  }

  remove(peerId: string): void {
    this.#conns.delete(peerId);
  }

  peerIds(exclude?: string): string[] {
    const ids = [...this.#conns.keys()];
    return exclude ? ids.filter((id) => id !== exclude) : ids;
  }

  broadcast(msg: ServerMessage, exclude?: string): void {
    for (const [id, conn] of this.#conns) {
      if (id === exclude) continue;
      conn.send(msg);
    }
  }

  sendTo(peerId: string, msg: ServerMessage): void {
    this.#conns.get(peerId)?.send(msg);
  }

  get size(): number {
    return this.#conns.size;
  }
}

/**
 * Registry of live rooms for a single-process (Deno) deployment. Rooms are
 * created on demand and dropped once empty so idle parties cost nothing.
 */
export class RoomRegistry {
  #rooms = new Map<string, MemoryRoom>();

  get(roomId: string): MemoryRoom {
    let room = this.#rooms.get(roomId);
    if (!room) {
      room = new MemoryRoom();
      this.#rooms.set(roomId, room);
    }
    return room;
  }

  dropIfEmpty(roomId: string): void {
    const room = this.#rooms.get(roomId);
    if (room && room.size === 0) this.#rooms.delete(roomId);
  }
}
