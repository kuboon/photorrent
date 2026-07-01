/**
 * Manifest: the party's append-only, end-to-end-encrypted photo index, plus
 * the control-plane WebSocket client that keeps it live.
 *
 * The same socket carries both the manifest (append + broadcast) and the
 * WebRTC signaling relay (see {@link RoomSocket.onSignal} /
 * {@link RoomSocket.sendSignal}). The data plane — actually moving photo bytes
 * — lives in `transfer.ts`.
 */

import type {
  ClientMessage,
  ManifestEntry,
  ServerMessage,
  SignalMessage,
} from "./protocol.ts";

export type { ManifestEntry };

// ---------------------------------------------------------------------------
// selectors — pure functions over the manifest + what we hold locally
// ---------------------------------------------------------------------------

/**
 * Hashes present in the manifest but not in `owned` — the photos this device
 * still needs to fetch from peers.
 */
export function missing(
  entries: readonly ManifestEntry[],
  owned: ReadonlySet<string>,
): ManifestEntry[] {
  return entries.filter((e) => !owned.has(e.hash));
}

export interface OwnedSummary {
  /** Distinct photos in the party. */
  total: number;
  /** How many of them this device holds. */
  owned: number;
  /** How many are still missing (`total - owned`). */
  missing: number;
}

/** `owned / total` counts for the header, deduped by hash. */
export function ownedSummary(
  entries: readonly ManifestEntry[],
  owned: ReadonlySet<string>,
): OwnedSummary {
  const hashes = new Set(entries.map((e) => e.hash));
  let ownedCount = 0;
  for (const hash of hashes) if (owned.has(hash)) ownedCount++;
  return {
    total: hashes.size,
    owned: ownedCount,
    missing: hashes.size - ownedCount,
  };
}

/** Deduplicate manifest entries by hash, keeping the earliest `addedAt`. */
export function dedupe(entries: readonly ManifestEntry[]): ManifestEntry[] {
  const byHash = new Map<string, ManifestEntry>();
  for (const e of entries) {
    const prev = byHash.get(e.hash);
    if (!prev || e.addedAt < prev.addedAt) byHash.set(e.hash, e);
  }
  return [...byHash.values()].sort((a, b) => a.addedAt - b.addedAt);
}

// ---------------------------------------------------------------------------
// control-plane socket client
// ---------------------------------------------------------------------------

export interface RoomSocketHandlers {
  /** The full manifest snapshot delivered on join. */
  onWelcome?: (peers: string[], manifest: ManifestEntry[]) => void;
  /** A single newly-appended manifest entry. */
  onManifestEntry?: (entry: ManifestEntry) => void;
  /** A signaling payload addressed to us (SDP/ICE), for the WebRTC layer. */
  onSignal?: (from: string, data: unknown) => void;
  onPeerJoin?: (peerId: string) => void;
  onPeerLeave?: (peerId: string) => void;
  onOpen?: () => void;
  onClose?: () => void;
}

/**
 * Build the `ws(s)://` URL for a room from an http(s) origin. The room id is
 * opaque (derived from `K`), so it is safe to place in the query string; `K`
 * itself never leaves the fragment.
 */
export function roomSocketUrl(origin: string, roomId: string): string {
  const url = new URL("/ws", origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("room", roomId);
  return url.toString();
}

/**
 * A thin wrapper over a single WebSocket speaking the {@link ServerMessage} /
 * {@link ClientMessage} protocol. Handles the initial `join` handshake and
 * demultiplexes manifest, presence, and signaling messages.
 */
export class RoomSocket {
  #ws: WebSocket;
  #peerId: string;
  #handlers: RoomSocketHandlers;

  constructor(url: string, peerId: string, handlers: RoomSocketHandlers = {}) {
    this.#peerId = peerId;
    this.#handlers = handlers;
    this.#ws = new WebSocket(url);
    this.#ws.addEventListener("open", () => {
      this.#send({ t: "join", peerId });
      this.#handlers.onOpen?.();
    });
    this.#ws.addEventListener("close", () => this.#handlers.onClose?.());
    this.#ws.addEventListener("message", (ev) => this.#onMessage(ev));
  }

  get peerId(): string {
    return this.#peerId;
  }

  #onMessage(ev: MessageEvent): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(
        typeof ev.data === "string" ? ev.data : "",
      ) as ServerMessage;
    } catch {
      return;
    }
    switch (msg.t) {
      case "welcome":
        this.#handlers.onWelcome?.(msg.peers, msg.manifest);
        break;
      case "manifest-entry":
        this.#handlers.onManifestEntry?.(msg.entry);
        break;
      case "signal":
        if (msg.to === this.#peerId) {
          this.#handlers.onSignal?.(msg.from, msg.data);
        }
        break;
      case "peer-join":
        this.#handlers.onPeerJoin?.(msg.peerId);
        break;
      case "peer-leave":
        this.#handlers.onPeerLeave?.(msg.peerId);
        break;
    }
  }

  #send(msg: ClientMessage): void {
    if (this.#ws.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify(msg));
    }
  }

  /** Append an entry to the party manifest. */
  addManifest(entry: ManifestEntry): void {
    this.#send({ t: "manifest-add", entry });
  }

  /** Relay a signaling payload to a specific peer. */
  sendSignal(to: string, data: unknown): void {
    const msg: SignalMessage = { t: "signal", to, from: this.#peerId, data };
    this.#send(msg);
  }

  close(): void {
    this.#ws.close();
  }
}
