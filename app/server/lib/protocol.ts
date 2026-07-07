/**
 * WebSocket message protocol shared by the server room hub and the browser
 * client. **Types only** — no runtime code, no Deno/DOM APIs — so the client
 * bundler (`Deno.bundle`) can import it across workspace members and emit
 * nothing for it.
 *
 * A room is implied by the socket (the roomId is carried in the WS URL path,
 * `/ws/:roomId`), so messages never repeat it — except signaling, which needs
 * explicit peer addressing.
 */

/**
 * One indexed file as broadcast/stored. The thumbnail bytes are delivered
 * separately by URL (see {@link FileMeta.thumbUrl}), never inlined, so WS
 * frames stay small.
 */
export interface FileMeta {
  /** Content hash (SHA-256, hex) — the primary key and dedup identity. */
  id: string;
  filename: string;
  /** Original file size in bytes. */
  size: number;
  mime: string;
  /** Thumbnail intrinsic dimensions, for grid layout. */
  width: number;
  height: number;
  /** `"/api/room/<roomId>/thumb?id=<fileId>"` — where the thumbnail bytes live. */
  thumbUrl: string;
  /** Ephemeral peerId of the uploader (Phase 1 has no accounts). */
  uploader: string;
  /** Epoch milliseconds when the file was added. */
  createdAt: number;
}

/** Map of fileId → peerIds that currently hold the file body. */
export type Holders = Record<string, string[]>;

/** Messages the client sends to the server. */
export type ClientMsg =
  /** Sent right after the socket opens; registers this peer in the room. */
  | { t: "join"; peerId: string }
  /** "I uploaded a file" — the thumbnail has already been POSTed. */
  | { t: "add"; file: FileMeta }
  /** Uploader retracts a file it added. */
  | { t: "remove"; id: string }
  /** "I now hold this file body" (uploaded, or downloaded from a peer). */
  | { t: "have"; id: string }
  /** WebRTC offer/answer/ice, relayed verbatim to `to`. */
  | { t: "signal"; to: string; data: unknown }
  /** Byte-relay fallback: a transfer chunk/control forwarded to `to` when P2P
   * can't connect. The server forwards it blind — it never stores bodies. */
  | { t: "relay"; to: string; data: unknown };

/** Messages the server sends to the client. */
export type ServerMsg =
  /** Full current state, sent once on join. */
  | { t: "snapshot"; files: FileMeta[]; peers: string[]; holders: Holders }
  | { t: "added"; file: FileMeta }
  | { t: "removed"; id: string }
  /** Roster of currently-connected peers changed. */
  | { t: "presence"; peers: string[] }
  /** The set of peers holding a file changed. */
  | { t: "holders"; id: string; peers: string[] }
  /** A relayed peer signaling message. */
  | { t: "signal"; from: string; data: unknown }
  /** A relayed byte-transfer message (P2P fallback). */
  | { t: "relay"; from: string; data: unknown }
  | { t: "error"; message: string };
