/**
 * Relay-only body transfer.
 *
 * The web client prefers a direct WebRTC data channel and only falls back to
 * the server byte-relay; Deno has no WebRTC, so the CLI speaks the relay path
 * exclusively. The chunk protocol is identical to `app/client/lib/transfer.ts`,
 * so a CLI and a browser interoperate:
 *
 *   requester → holder:  {c:"req", id}
 *   holder → requester:  {c:"begin", id, size, mime, name}
 *                        <base64 byte frames…>
 *                        {c:"end", id}          (or {c:"err", id, message})
 *
 * Each frame rides a `relay` WS message as `{tid, j}` (JSON control) or
 * `{tid, b}` (base64 bytes), addressed to a single peer; the server forwards it
 * blind and never sees a body. Downloaded bodies are written under `shared/`
 * and re-announced via `have`, so the CLI becomes a holder too (re-seeding).
 */

import { base64ToBytes, bytesToBase64 } from "./base64.ts";
import { DownloadWriter, type OwnedFile } from "./media.ts";

/** Bytes per relay frame (pre-base64), matching the web client. */
const CHUNK = 16 * 1024;

/** Relay payload as carried in `relay.data` on the wire. */
export interface RelayData {
  tid: string;
  j?: unknown;
  b?: string;
}

interface Ctrl {
  c: "req" | "begin" | "end" | "err";
  id: string;
  size?: number;
  mime?: string;
  name?: string;
  message?: string;
}

export interface TransferDeps {
  myPeerId: string;
  sharedDir: string;
  sendRelay: (to: string, data: RelayData) => void;
  announceHave: (id: string) => void;
  /** Resolve a held body to stream from disk, or undefined if not held. */
  lookup: (id: string) => OwnedFile | undefined;
  /** Called after a download commits, with the saved path + filename. */
  onDownloaded: (id: string, path: string, filename: string) => void;
  log: (msg: string) => void;
}

interface Download {
  id: string;
  tid: string;
  holder: string;
  filename: string;
  mime: string;
  writer?: DownloadWriter;
  received: number;
  done: boolean;
  /** Serializes writes so out-of-order async scheduling can't reorder bytes. */
  queue: Promise<void>;
}

function short(peerId: string): string {
  return peerId.slice(0, 8);
}

export class RelayTransfer {
  #byId = new Map<string, Download>();
  #byTid = new Map<string, Download>();
  #serving = new Set<string>();

  constructor(private deps: TransferDeps) {}

  isDownloading(id: string): boolean {
    return this.#byId.has(id);
  }

  // --- requester side -----------------------------------------------------

  /** Start pulling `id` from `holder`. No-op if already in flight or ours. */
  download(id: string, mime: string, filename: string, holder: string): void {
    if (this.#byId.has(id) || holder === this.deps.myPeerId) return;
    const tid = crypto.randomUUID();
    const dl: Download = {
      id,
      tid,
      holder,
      filename,
      mime,
      received: 0,
      done: false,
      queue: Promise.resolve(),
    };
    this.#byId.set(id, dl);
    this.#byTid.set(tid, dl);
    this.deps.log(`↓ ${filename} ← ${short(holder)} (relay)`);
    this.deps.sendRelay(holder, { tid, j: { c: "req", id } });
  }

  // --- inbound relay routing ----------------------------------------------

  /** Route an inbound relay payload (from a ServerMsg `relay`). */
  onRelay(from: string, data: RelayData): void {
    if (!data?.tid) return;
    const dl = this.#byTid.get(data.tid);
    if (dl) {
      this.#onRequesterFrame(dl, data);
    } else if (data.j) {
      const ctrl = data.j as Ctrl;
      if (ctrl.c === "req") void this.#serve(from, data.tid, ctrl.id);
    }
  }

  #onRequesterFrame(dl: Download, data: RelayData): void {
    if (data.b !== undefined) {
      const bytes = base64ToBytes(data.b);
      this.#enqueue(dl, async () => {
        if (dl.writer) {
          await dl.writer.write(bytes);
          dl.received += bytes.length;
        }
      });
      return;
    }
    const ctrl = data.j as Ctrl;
    if (ctrl.c === "begin") {
      dl.filename = ctrl.name || dl.filename;
      dl.mime = ctrl.mime || dl.mime;
      this.#enqueue(dl, async () => {
        dl.writer = await DownloadWriter.create(
          this.deps.sharedDir,
          dl.id,
          dl.filename,
        );
      });
    } else if (ctrl.c === "end") {
      this.#enqueue(dl, async () => {
        if (dl.done) return;
        dl.done = true;
        const path = dl.writer ? await dl.writer.commit() : dl.filename;
        this.#cleanup(dl);
        this.deps.onDownloaded(dl.id, path, dl.filename);
        this.deps.announceHave(dl.id);
        this.deps.log(`✓ ${dl.filename} (${dl.received} bytes)`);
      });
    } else if (ctrl.c === "err") {
      this.#enqueue(dl, async () => {
        if (dl.done) return;
        dl.done = true;
        await dl.writer?.abort();
        this.#cleanup(dl);
        this.deps.log(`✗ ${dl.filename}: ${ctrl.message ?? "transfer error"}`);
      });
    }
  }

  #enqueue(dl: Download, fn: () => Promise<void>): void {
    dl.queue = dl.queue.then(fn).catch((err) => {
      this.deps.log(`✗ ${dl.filename}: ${(err as Error).message}`);
      this.#cleanup(dl);
    });
  }

  #cleanup(dl: Download): void {
    this.#byId.delete(dl.id);
    this.#byTid.delete(dl.tid);
  }

  // --- holder side (serving) ----------------------------------------------

  async #serve(to: string, tid: string, id: string): Promise<void> {
    if (this.#serving.has(tid)) return;
    this.#serving.add(tid);
    try {
      const file = this.deps.lookup(id);
      if (!file) {
        this.deps.sendRelay(to, {
          tid,
          j: { c: "err", id, message: "not held" },
        });
        return;
      }
      this.deps.sendRelay(to, {
        tid,
        j: {
          c: "begin",
          id,
          size: file.size,
          mime: file.mime,
          name: file.filename,
        },
      });
      const f = await Deno.open(file.path, { read: true });
      try {
        const buf = new Uint8Array(CHUNK);
        while (true) {
          const n = await f.read(buf);
          if (n === null) break;
          this.deps.sendRelay(to, {
            tid,
            b: bytesToBase64(buf.subarray(0, n)),
          });
          // Yield so a large file doesn't monopolize the socket / event loop.
          await new Promise((r) => setTimeout(r, 0));
        }
      } finally {
        f.close();
      }
      this.deps.sendRelay(to, { tid, j: { c: "end", id } });
      this.deps.log(`↑ ${file.filename} → ${short(to)}`);
    } catch (err) {
      this.deps.sendRelay(to, {
        tid,
        j: { c: "err", id, message: (err as Error).message },
      });
    } finally {
      this.#serving.delete(tid);
    }
  }
}
