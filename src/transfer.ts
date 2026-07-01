/**
 * Data plane: a WebRTC mesh that moves encrypted photo bytes browser-to-browser
 * over `RTCDataChannel`, plus the local ciphertext store that persists them.
 *
 * This module is browser-only (it needs `RTCPeerConnection` / `indexedDB`); it
 * is bundled for the client and never imported by the Deno/Worker server.
 *
 * Peer protocol (over the channel, after WebRTC connects):
 *   {t:"have?",hash}          -> {t:"have",hash,yes}
 *   {t:"want",hash}           -> binary ciphertext chunks, then {t:"want-done",hash}
 *
 * Any peer that holds a photo can serve it, so receivers become sources once
 * they store and verify a hash — the swarm property, without BitTorrent.
 */

import { sha256Hex } from "./crypto.ts";
import type { RoomSocket } from "./manifest.ts";

const CHUNK_SIZE = 16 * 1024; // 16 KB data-channel messages.
const BUFFER_HIGH = 1 << 20; // pause sending above 1 MB buffered.
const BUFFER_LOW = 256 * 1024; // resume once drained below 256 KB.
const HAVE_TIMEOUT_MS = 1500;
const WANT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// local ciphertext store (IndexedDB) — survives reload / going home
// ---------------------------------------------------------------------------

const DB_NAME = "photorrent";
const STORE_NAME = "ciphertext";

/**
 * Persistent store of encrypted photo bytes keyed by `hash`. We store and serve
 * ciphertext only; plaintext and `K` are never written to disk.
 */
export class LocalStore {
  #db: Promise<IDBDatabase>;

  constructor() {
    this.#db = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE_NAME);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async #tx(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    const db = await this.#db;
    return db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
  }

  async put(hash: string, bytes: Uint8Array): Promise<void> {
    const store = await this.#tx("readwrite");
    await promisify(store.put(bytes, hash));
  }

  async get(hash: string): Promise<Uint8Array | undefined> {
    const store = await this.#tx("readonly");
    const value = await promisify<Uint8Array | undefined>(store.get(hash));
    return value ? new Uint8Array(value) : undefined;
  }

  async has(hash: string): Promise<boolean> {
    const store = await this.#tx("readonly");
    const key = await promisify(store.getKey(hash));
    return key !== undefined;
  }

  async keys(): Promise<Set<string>> {
    const store = await this.#tx("readonly");
    const keys = await promisify<IDBValidKey[]>(store.getAllKeys());
    return new Set(keys.map((k) => String(k)));
  }
}

function promisify<T = unknown>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ---------------------------------------------------------------------------
// ICE / TURN — fetched from the server so TURN creds never live in the client
// ---------------------------------------------------------------------------

export async function fetchIceServers(): Promise<RTCIceServer[]> {
  try {
    const res = await fetch("/api/ice");
    if (!res.ok) throw new Error(`ice ${res.status}`);
    const body = await res.json() as { iceServers?: RTCIceServer[] };
    return body.iceServers ?? DEFAULT_ICE;
  } catch {
    return DEFAULT_ICE;
  }
}

const DEFAULT_ICE: RTCIceServer[] = [
  { urls: "stun:stun.cloudflare.com:3478" },
];

// ---------------------------------------------------------------------------
// per-peer connection with perfect-negotiation glare handling
// ---------------------------------------------------------------------------

interface Inbound {
  hash: string;
  chunks: Uint8Array[];
  received: number;
  resolve: (bytes: Uint8Array) => void;
  reject: (err: Error) => void;
  timer: number;
}

type ControlMessage =
  | { t: "have?"; hash: string }
  | { t: "have"; hash: string; yes: boolean }
  | { t: "want"; hash: string }
  | { t: "want-done"; hash: string };

class Peer {
  readonly id: string;
  readonly pc: RTCPeerConnection;
  #dc: RTCDataChannel | null = null;
  #polite: boolean;
  #makingOffer = false;
  #ignoreOffer = false;
  #inbound: Inbound | null = null;
  #openWaiters: Array<() => void> = [];

  constructor(
    id: string,
    selfId: string,
    iceServers: RTCIceServer[],
    private readonly store: LocalStore,
    private readonly signal: (data: unknown) => void,
    private readonly onHave: (hash: string, yes: boolean) => void,
  ) {
    this.id = id;
    // Deterministic roles: the lexicographically greater id initiates; the
    // other is "polite" and yields on offer collisions.
    const initiator = selfId > id;
    this.#polite = !initiator;
    this.pc = new RTCPeerConnection({ iceServers });

    this.pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.signal({ type: "ice", candidate });
    };
    this.pc.onnegotiationneeded = async () => {
      try {
        this.#makingOffer = true;
        await this.pc.setLocalDescription();
        this.signal({ type: "sdp", description: this.pc.localDescription });
      } catch {
        // Renegotiation failures surface as a dead channel; fetch falls back.
      } finally {
        this.#makingOffer = false;
      }
    };
    this.pc.ondatachannel = ({ channel }) => this.#bindChannel(channel);

    if (initiator) this.#bindChannel(this.pc.createDataChannel("data"));
  }

  #bindChannel(dc: RTCDataChannel): void {
    dc.binaryType = "arraybuffer";
    this.#dc = dc;
    dc.onopen = () => {
      for (const w of this.#openWaiters.splice(0)) w();
    };
    dc.onmessage = (ev) => this.#onMessage(ev.data);
  }

  get open(): boolean {
    return this.#dc?.readyState === "open";
  }

  get busy(): boolean {
    return this.#inbound !== null;
  }

  waitOpen(timeoutMs = 10_000): Promise<void> {
    if (this.open) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("channel open timeout")),
        timeoutMs,
      );
      this.#openWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Apply a signaling payload relayed from this peer (perfect negotiation). */
  async applySignal(data: unknown): Promise<void> {
    const msg = data as {
      type?: string;
      description?: RTCSessionDescriptionInit;
      candidate?: RTCIceCandidateInit;
    };
    try {
      if (msg.type === "sdp" && msg.description) {
        const offerCollision = msg.description.type === "offer" &&
          (this.#makingOffer || this.pc.signalingState !== "stable");
        this.#ignoreOffer = !this.#polite && offerCollision;
        if (this.#ignoreOffer) return;
        await this.pc.setRemoteDescription(msg.description);
        if (msg.description.type === "offer") {
          await this.pc.setLocalDescription();
          this.signal({ type: "sdp", description: this.pc.localDescription });
        }
      } else if (msg.type === "ice" && msg.candidate) {
        try {
          await this.pc.addIceCandidate(msg.candidate);
        } catch {
          if (!this.#ignoreOffer) throw new Error("addIceCandidate failed");
        }
      }
    } catch {
      // Swallow; a failed negotiation just means this peer can't serve us.
    }
  }

  #sendControl(msg: ControlMessage): void {
    if (this.#dc?.readyState === "open") this.#dc.send(JSON.stringify(msg));
  }

  /** Ask whether this peer holds `hash`; the reply arrives via `onHave`. */
  ask(hash: string): void {
    this.#sendControl({ t: "have?", hash });
  }

  /** Request `hash`; resolves with the reassembled, verified ciphertext. */
  want(hash: string, size: number): Promise<Uint8Array> {
    if (this.#inbound) return Promise.reject(new Error("peer busy"));
    return new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#inbound?.hash === hash) {
          this.#inbound = null;
          reject(new Error("want timeout"));
        }
      }, WANT_TIMEOUT_MS);
      this.#inbound = { hash, chunks: [], received: 0, resolve, reject, timer };
      void size;
      this.#sendControl({ t: "want", hash });
    });
  }

  async #onMessage(data: string | ArrayBuffer): Promise<void> {
    if (typeof data === "string") {
      let msg: ControlMessage;
      try {
        msg = JSON.parse(data) as ControlMessage;
      } catch {
        return;
      }
      switch (msg.t) {
        case "have?":
          this.#sendControl({
            t: "have",
            hash: msg.hash,
            yes: await this.store.has(msg.hash),
          });
          break;
        case "have":
          this.onHave(msg.hash, msg.yes);
          break;
        case "want":
          await this.#serve(msg.hash);
          break;
        case "want-done":
          this.#finishInbound(msg.hash);
          break;
      }
      return;
    }
    // Binary chunk for the current inbound transfer.
    if (this.#inbound) {
      const chunk = new Uint8Array(data);
      this.#inbound.chunks.push(chunk);
      this.#inbound.received += chunk.length;
    }
  }

  #finishInbound(hash: string): void {
    const inbound = this.#inbound;
    if (!inbound || inbound.hash !== hash) return;
    this.#inbound = null;
    clearTimeout(inbound.timer);
    const bytes = concat(inbound.chunks, inbound.received);
    inbound.resolve(bytes);
  }

  async #serve(hash: string): Promise<void> {
    const dc = this.#dc;
    if (!dc || dc.readyState !== "open") return;
    const bytes = await this.store.get(hash);
    if (!bytes) {
      // We don't hold it; a `want-done` with nothing lets the requester move on.
      this.#sendControl({ t: "want-done", hash });
      return;
    }
    dc.bufferedAmountLowThreshold = BUFFER_LOW;
    for (let off = 0; off < bytes.length; off += CHUNK_SIZE) {
      if (dc.readyState !== "open") return;
      if (dc.bufferedAmount > BUFFER_HIGH) await drain(dc);
      dc.send(bytes.subarray(off, off + CHUNK_SIZE) as Uint8Array<ArrayBuffer>);
    }
    this.#sendControl({ t: "want-done", hash });
  }

  close(): void {
    if (this.#inbound) {
      clearTimeout(this.#inbound.timer);
      this.#inbound.reject(new Error("peer closed"));
      this.#inbound = null;
    }
    try {
      this.#dc?.close();
      this.pc.close();
    } catch {
      // already closed
    }
  }
}

function drain(dc: RTCDataChannel): Promise<void> {
  return new Promise((resolve) => {
    const handler = () => {
      dc.removeEventListener("bufferedamountlow", handler);
      resolve();
    };
    dc.addEventListener("bufferedamountlow", handler);
  });
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// transfer manager — wires signaling to the peer mesh and drives fetches
// ---------------------------------------------------------------------------

export interface TransferEvents {
  /** Fired when the set of connected peers changes. */
  onPeers?: (count: number) => void;
  /** Fired after a photo is fetched and stored, so the UI can refresh. */
  onStored?: (hash: string) => void;
}

export class TransferManager {
  readonly store: LocalStore;
  #socket: RoomSocket;
  #selfId: string;
  #iceServers: RTCIceServer[];
  #peers = new Map<string, Peer>();
  #haveWaiters = new Map<string, Set<string>>(); // hash -> peerIds that answered yes
  #events: TransferEvents;

  constructor(
    socket: RoomSocket,
    store: LocalStore,
    iceServers: RTCIceServer[],
    events: TransferEvents = {},
  ) {
    this.#socket = socket;
    this.store = store;
    this.#selfId = socket.peerId;
    this.#iceServers = iceServers;
    this.#events = events;
  }

  /** Open connections to the peers already in the room (from `welcome`). */
  connectAll(peerIds: string[]): void {
    for (const id of peerIds) this.#ensurePeer(id);
  }

  handlePeerJoin(peerId: string): void {
    this.#ensurePeer(peerId);
  }

  handlePeerLeave(peerId: string): void {
    this.#peers.get(peerId)?.close();
    this.#peers.delete(peerId);
    this.#events.onPeers?.(this.#peers.size);
  }

  handleSignal(from: string, data: unknown): void {
    void this.#ensurePeer(from).applySignal(data);
  }

  #ensurePeer(id: string): Peer {
    let peer = this.#peers.get(id);
    if (peer) return peer;
    peer = new Peer(
      id,
      this.#selfId,
      this.#iceServers,
      this.store,
      (data) => this.#socket.sendSignal(id, data),
      (hash, yes) => {
        if (yes) this.#haveWaiters.get(hash)?.add(id);
      },
    );
    this.#peers.set(id, peer);
    this.#events.onPeers?.(this.#peers.size);
    return peer;
  }

  /** Ask every open peer whether they hold `hash`; collect the yes-responders. */
  async #queryHolders(hash: string): Promise<string[]> {
    const holders = new Set<string>();
    this.#haveWaiters.set(hash, holders);
    const open = [...this.#peers.values()].filter((p) => p.open);
    for (const p of open) p.ask(hash);
    await delay(HAVE_TIMEOUT_MS);
    this.#haveWaiters.delete(hash);
    return [...holders];
  }

  /**
   * Fetch a missing photo: find a holder, stream it, verify
   * `SHA-256(ciphertext) === hash`, store it, and become a source ourselves.
   * Falls back across holders on failure. Returns the stored ciphertext.
   */
  async fetchPhoto(hash: string, size: number): Promise<Uint8Array> {
    const local = await this.store.get(hash);
    if (local) return local;

    // Make sure channels have a chance to open before we query.
    await Promise.race([
      Promise.all(
        [...this.#peers.values()].map((p) => p.waitOpen().catch(() => {})),
      ),
      delay(3000),
    ]);

    const holders = await this.#queryHolders(hash);
    let lastError: Error | null = null;

    for (const holderId of holders) {
      const peer = this.#peers.get(holderId);
      if (!peer || !peer.open || peer.busy) continue;
      try {
        const bytes = await peer.want(hash, size);
        if (bytes.length === 0) throw new Error("empty transfer");
        const actual = await sha256Hex(bytes);
        if (actual !== hash) throw new Error("hash mismatch");
        await this.store.put(hash, bytes);
        this.#events.onStored?.(hash);
        return bytes;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }
    throw lastError ?? new Error(`no holder for ${hash}`);
  }

  /** Store our own freshly-encrypted ciphertext so we can serve it. */
  async addLocal(hash: string, bytes: Uint8Array): Promise<void> {
    await this.store.put(hash, bytes);
    this.#events.onStored?.(hash);
  }

  get peerCount(): number {
    return this.#peers.size;
  }

  close(): void {
    for (const peer of this.#peers.values()) peer.close();
    this.#peers.clear();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
