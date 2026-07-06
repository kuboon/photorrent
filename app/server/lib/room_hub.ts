/**
 * The room hub — a process-wide singleton that owns, per room:
 *   - the set of connected sockets (keyed by peerId), and
 *   - the {@link RoomStore} (file index + thumbnails).
 *
 * It broadcasts index events (`added`/`removed`) and presence changes to a
 * room, and relays WebRTC signaling messages between two peers. The WS
 * controller (`controllers/ws.ts`) is a thin adapter that parses frames and
 * calls these methods.
 *
 * Sockets are accepted as a minimal duck type ({@link Sink}) so tests can drive
 * the hub with fake sockets — no real network required.
 */

import type { ClientMsg, FileMeta, ServerMsg } from "./protocol.ts";
import { createRoomStore, type RoomStore, type Thumb } from "./index_store.ts";

/** The subset of `WebSocket` the hub needs. */
export interface Sink {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

const WS_OPEN = 1;

interface Room {
  sockets: Map<string, Sink>;
  store: RoomStore;
}

export class RoomHub {
  private rooms = new Map<string, Room>();

  private getRoom(roomId: string): Room {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = { sockets: new Map(), store: createRoomStore(roomId) };
      this.rooms.set(roomId, room);
    }
    return room;
  }

  private peerIds(room: Room): string[] {
    return [...room.sockets.keys()];
  }

  private send(socket: Sink, msg: ServerMsg): void {
    if (socket.readyState === WS_OPEN) socket.send(JSON.stringify(msg));
  }

  /**
   * Broadcast a message to every socket in the room, optionally skipping one
   * peer (typically the originator).
   */
  broadcast(roomId: string, msg: ServerMsg, exceptPeerId?: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    for (const [peerId, socket] of room.sockets) {
      if (peerId === exceptPeerId) continue;
      this.send(socket, msg);
    }
  }

  /**
   * Register a socket under `peerId`, send it the current snapshot, and notify
   * the rest of the room of the new presence. Returns the snapshot that was
   * sent (handy for tests).
   */
  async join(
    roomId: string,
    peerId: string,
    socket: Sink,
  ): Promise<{ files: FileMeta[]; peers: string[] }> {
    const room = this.getRoom(roomId);
    // Register BEFORE computing the snapshot so no concurrent `add` is missed
    // and the joiner appears in its own presence list.
    room.sockets.set(peerId, socket);

    const files = await room.store.listFiles();
    const peers = this.peerIds(room);
    this.send(socket, { t: "snapshot", files, peers });
    this.broadcast(roomId, { t: "presence", peers }, peerId);
    return { files, peers };
  }

  /** Remove a socket and notify the room. Cleans up rooms that empty out. */
  leave(roomId: string, peerId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.sockets.delete(peerId);
    if (room.sockets.size === 0) {
      this.rooms.delete(roomId);
      return;
    }
    this.broadcast(roomId, { t: "presence", peers: this.peerIds(room) });
  }

  /** Add a file to the index and broadcast it to the room. */
  async addFile(roomId: string, file: FileMeta): Promise<void> {
    const room = this.getRoom(roomId);
    await room.store.addFile(file);
    this.broadcast(roomId, { t: "added", file });
  }

  /** Remove a file from the index and broadcast the removal. */
  async removeFile(roomId: string, id: string): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room) return;
    await room.store.removeFile(id);
    this.broadcast(roomId, { t: "removed", id });
  }

  /** Relay a signaling payload to a single addressed peer in the room. */
  relaySignal(roomId: string, from: string, to: string, data: unknown): void {
    const room = this.rooms.get(roomId);
    const target = room?.sockets.get(to);
    if (target) this.send(target, { t: "signal", from, data });
  }

  /** Dispatch a parsed client message from `peerId` in `roomId`. */
  async handle(roomId: string, peerId: string, msg: ClientMsg): Promise<void> {
    switch (msg.t) {
      case "join":
        // Registration happens in `join()`, called by the controller on open.
        break;
      case "add":
        await this.addFile(roomId, msg.file);
        break;
      case "remove":
        await this.removeFile(roomId, msg.id);
        break;
      case "signal":
        this.relaySignal(roomId, peerId, msg.to, msg.data);
        break;
    }
  }

  // --- REST / thumbnail helpers -------------------------------------------

  listFiles(roomId: string): Promise<FileMeta[]> {
    return this.getRoom(roomId).store.listFiles();
  }

  putThumb(roomId: string, id: string, thumb: Thumb): Promise<void> {
    return this.getRoom(roomId).store.putThumb(id, thumb);
  }

  getThumb(roomId: string, id: string): Promise<Thumb | null> {
    return this.getRoom(roomId).store.getThumb(id);
  }

  /** Number of connected peers in a room (0 if the room doesn't exist). */
  peerCount(roomId: string): number {
    return this.rooms.get(roomId)?.sockets.size ?? 0;
  }
}

/** Process-wide singleton used by the controllers. */
export const hub = new RoomHub();
