/**
 * photorrent CLI — share the current directory's media into a room and mirror
 * everyone else's into `./shared`.
 *
 *   photorrent <room-url>     join an existing room
 *   photorrent new <server>   mint a new room, print its URL, then share
 *
 * It joins the room WebSocket, publishes each local media file (content hash →
 * placeholder thumbnail → `add`), and pulls every file it lacks from a holder
 * over the server byte-relay (no WebRTC — see `lib/transfer.ts`). Downloaded
 * bodies are saved under `shared/` and re-announced with `have`, so this peer
 * seeds them onward. Runs until interrupted (Ctrl+C).
 */

import type { ClientMsg, FileMeta, ServerMsg } from "../server/lib/protocol.ts";
import {
  newRoomUrl,
  parseRoomUrl,
  type RoomEndpoints,
} from "./lib/room_url.ts";
import { type OwnedFile, scanMedia, SHARED_DIR } from "./lib/media.ts";
import { placeholderThumb } from "./lib/thumb.ts";
import { RelayTransfer } from "./lib/transfer.ts";

interface Options {
  roomUrl: string;
  /** True when the room was freshly minted (`new`); print its URL prominently. */
  minted: boolean;
  name?: string;
}

function parseArgs(args: string[]): Options {
  let name: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--name") name = args[++i];
    else if (a.startsWith("--name=")) name = a.slice("--name=".length);
    else positional.push(a);
  }

  if (positional[0] === "new") {
    const server = positional[1];
    if (!server) throw new Error("usage: photorrent new <server-url>");
    return { roomUrl: newRoomUrl(server), minted: true, name };
  }
  const roomUrl = positional[0];
  if (!roomUrl) {
    throw new Error(
      "usage: photorrent <room-url>  |  photorrent new <server-url>",
    );
  }
  // Validate early with a clear message.
  parseRoomUrl(roomUrl);
  return { roomUrl, minted: false, name };
}

function log(msg: string): void {
  console.error(msg);
}

async function main(): Promise<void> {
  let opts: Options;
  try {
    opts = parseArgs(Deno.args);
  } catch (err) {
    log((err as Error).message);
    Deno.exit(2);
  }

  const room = parseRoomUrl(opts.roomUrl);
  if (opts.minted) {
    log(`新しいアルバムを作成しました。この URL を参加者に配ってください:`);
    // The URL is the one machine-readable output — stdout, so it can be piped.
    console.log(opts.roomUrl);
  } else {
    log(`アルバムに参加: ${opts.roomUrl}`);
  }

  const cwd = Deno.cwd();
  const sharedDir = `${cwd}/${SHARED_DIR}`;
  const peerId = crypto.randomUUID();

  log(`メディアを走査中 (${cwd}) …`);
  const scanned = await scanMedia(cwd, (n) => log(`  hashing ${n}`));
  const owned = new Map<string, OwnedFile>(scanned.map((f) => [f.id, f]));
  log(`共有対象: ${owned.size} ファイル`);

  new Session(room, peerId, owned, sharedDir, opts.name).start();
}

/** One live room connection: WS lifecycle + index/holder state + transfers. */
class Session {
  #ws: WebSocket | null = null;
  #stopped = false;
  #backoff = 500;

  #index = new Map<string, FileMeta>();
  #holders = new Map<string, Set<string>>();
  #peers = new Set<string>();
  #transfer: RelayTransfer;

  constructor(
    private room: RoomEndpoints,
    private peerId: string,
    private owned: Map<string, OwnedFile>,
    private sharedDir: string,
    private name?: string,
  ) {
    this.#transfer = new RelayTransfer({
      myPeerId: peerId,
      sharedDir,
      sendRelay: (to, data) => this.#send({ t: "relay", to, data }),
      announceHave: (id) => this.#send({ t: "have", id }),
      lookup: (id) => this.owned.get(id),
      onDownloaded: (id, path, filename) =>
        this.#onDownloaded(id, path, filename),
      log,
    });
  }

  start(): void {
    Deno.addSignalListener("SIGINT", () => {
      this.#stopped = true;
      this.#ws?.close();
      log("\n終了します。");
      Deno.exit(0);
    });
    this.#connect();
  }

  #connect(): void {
    log("接続しています…");
    const ws = new WebSocket(this.room.wsUrl);
    this.#ws = ws;

    ws.onopen = () => {
      this.#backoff = 500;
      log(`接続しました (peer ${this.peerId.slice(0, 8)})`);
      this.#send({ t: "join", peerId: this.peerId });
    };
    ws.onmessage = (e) => {
      try {
        this.#onMessage(JSON.parse(e.data) as ServerMsg);
      } catch (err) {
        log(`[ws] bad message: ${(err as Error).message}`);
      }
    };
    ws.onerror = () => ws.close();
    ws.onclose = () => {
      if (this.#stopped) return;
      log(`切断されました。${this.#backoff}ms 後に再接続します。`);
      setTimeout(() => this.#connect(), this.#backoff);
      this.#backoff = Math.min(this.#backoff * 2, 10000);
    };
  }

  #send(msg: ClientMsg): void {
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify(msg));
    }
  }

  #onMessage(msg: ServerMsg): void {
    switch (msg.t) {
      case "snapshot":
        this.#index = new Map(msg.files.map((f) => [f.id, f]));
        this.#holders = new Map(
          Object.entries(msg.holders).map(([id, ps]) => [id, new Set(ps)]),
        );
        this.#peers = new Set(msg.peers);
        void this.#publishOwned();
        this.#retryDownloads();
        break;
      case "added":
        this.#index.set(msg.file.id, msg.file);
        this.#onIndexedFile(msg.file);
        break;
      case "removed":
        this.#index.delete(msg.id);
        this.#holders.delete(msg.id);
        break;
      case "presence":
        this.#peers = new Set(msg.peers);
        this.#retryDownloads();
        break;
      case "holders":
        this.#holders.set(msg.id, new Set(msg.peers));
        this.#maybeDownload(msg.id);
        break;
      case "relay":
        this.#transfer.onRelay(msg.from, msg.data as never);
        break;
      case "signal":
        // We don't speak WebRTC; browsers fall back to relay after a timeout.
        break;
      case "error":
        log(`[server] ${msg.message}`);
        break;
    }
  }

  /** Announce/upload every local file, then pull what we're missing. */
  async #publishOwned(): Promise<void> {
    for (const file of this.owned.values()) {
      if (this.#index.has(file.id)) {
        // Already indexed by someone else — just become an extra holder.
        this.#send({ t: "have", id: file.id });
      } else {
        await this.#uploadNew(file);
      }
    }
  }

  async #uploadNew(file: OwnedFile): Promise<void> {
    const thumb = placeholderThumb(file.mime);
    try {
      const res = await fetch(this.room.thumbUrl(file.id), {
        method: "POST",
        headers: { "content-type": thumb.contentType },
        body: new Blob([thumb.bytes]),
      });
      if (!res.ok && res.status !== 204) {
        log(`サムネ POST 失敗 (${res.status}): ${file.filename}`);
      }
    } catch (err) {
      log(`サムネ POST 失敗: ${file.filename} (${(err as Error).message})`);
    }
    const meta: FileMeta = {
      id: file.id,
      filename: file.filename,
      size: file.size,
      mime: file.mime,
      width: thumb.width,
      height: thumb.height,
      thumbUrl: this.room.thumbPath(file.id),
      uploader: this.peerId,
      ...(this.name ? { uploaderName: this.name } : {}),
      createdAt: Date.now(),
    };
    this.#index.set(file.id, meta);
    this.#send({ t: "add", file: meta });
    log(`＋ 共有: ${file.filename}`);
  }

  #onIndexedFile(file: FileMeta): void {
    if (file.uploader === this.peerId) return;
    if (this.owned.has(file.id)) {
      this.#send({ t: "have", id: file.id }); // we hold the same content
    } else {
      this.#maybeDownload(file.id);
    }
  }

  #retryDownloads(): void {
    for (const id of this.#index.keys()) this.#maybeDownload(id);
  }

  #maybeDownload(id: string): void {
    if (this.owned.has(id) || this.#transfer.isDownloading(id)) return;
    const meta = this.#index.get(id);
    if (!meta || meta.uploader === this.peerId) return;
    const holder = this.#pickHolder(id);
    if (holder) this.#transfer.download(id, meta.mime, meta.filename, holder);
  }

  /** An online holder other than us, or null. */
  #pickHolder(id: string): string | null {
    const set = this.#holders.get(id);
    if (!set) return null;
    for (const h of set) {
      if (h !== this.peerId && this.#peers.has(h)) return h;
    }
    return null;
  }

  #onDownloaded(id: string, path: string, filename: string): void {
    const meta = this.#index.get(id);
    this.owned.set(id, {
      id,
      path,
      filename,
      mime: meta?.mime ?? "application/octet-stream",
      size: meta?.size ?? 0,
    });
    log(`保存: ${SHARED_DIR}/${filename.split("/").pop()}`);
  }
}

if (import.meta.main) {
  await main();
}
