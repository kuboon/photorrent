/**
 * Peer-to-peer file transfer over {@link DataSink} channels.
 *
 * Download flow (requester): try a direct WebRTC connection to a holder; if the
 * data channel doesn't open within a timeout (or the connection fails), fall
 * back to the server WS byte-relay. Either way the same chunk protocol runs:
 *
 *   requester → holder:  {c:"req", id}
 *   holder → requester:  {c:"begin", id, size, mime, name}
 *                        <binary chunks…>
 *                        {c:"end", id}         (or {c:"err", id, message})
 *
 * Received bodies are written to OPFS and the peer announces `have` so it can
 * serve them onward. The server never sees file bytes on the P2P path and only
 * blind-forwards them on the relay fallback.
 */

import {
  type DataSink,
  RelaySink,
  RtcConnection,
  type RtcSignalData,
} from "./peer.ts";
import { getFile, save } from "./opfs.ts";

export type FileState = "downloading" | "have" | "error";

const CHUNK = 16 * 1024;
const RTC_HIGH_WATER = 4 * 1024 * 1024;
const RTC_OPEN_TIMEOUT = 8000;

interface Download {
  id: string;
  mime: string;
  holder: string;
  chunks: ArrayBuffer[];
  receiving: boolean;
  done: boolean;
  tid?: string; // active RTC transfer id
  relayTid?: string; // active relay transfer id
  conn?: RtcConnection;
  sink?: DataSink;
  timer?: ReturnType<typeof setTimeout>;
}

export interface TransferIO {
  myPeerId: string;
  signal: (to: string, data: RtcSignalData) => void;
  relay: (to: string, data: unknown) => void;
  announceHave: (id: string) => void;
}

export class TransferManager {
  private conns = new Map<string, RtcConnection>(); // tid → conn (both roles)
  private relays = new Map<string, RelaySink>(); // tid → relay sink (both roles)
  private downloads = new Map<string, Download>(); // fileId → in-flight download

  constructor(
    private io: TransferIO,
    private onState: (fileId: string, state: FileState) => void,
  ) {}

  /** Whether a download for this file is already in flight. */
  isDownloading(fileId: string): boolean {
    return this.downloads.has(fileId);
  }

  // --- requester side -----------------------------------------------------

  /** Start downloading `fileId` (mime for the reassembled Blob) from `holder`. */
  download(fileId: string, mime: string, holder: string): void {
    if (this.downloads.has(fileId) || holder === this.io.myPeerId) return;
    const dl: Download = {
      id: fileId,
      mime,
      holder,
      chunks: [],
      receiving: false,
      done: false,
    };
    this.downloads.set(fileId, dl);
    this.onState(fileId, "downloading");
    this.attemptRtc(dl);
  }

  private attemptRtc(dl: Download): void {
    const tid = crypto.randomUUID();
    dl.tid = tid;
    const conn = new RtcConnection(
      tid,
      dl.holder,
      this.io.signal,
      (sink) => {
        clearTimeout(dl.timer);
        this.wireReceiver(dl, sink);
        sink.sendJson({ c: "req", id: dl.id });
      },
      () => {
        this.conns.delete(tid);
        this.fallbackRelay(dl);
      },
    );
    this.conns.set(tid, conn);
    dl.conn = conn;
    dl.timer = setTimeout(() => this.fallbackRelay(dl), RTC_OPEN_TIMEOUT);
    conn.offer().catch(() => this.fallbackRelay(dl));
  }

  private fallbackRelay(dl: Download): void {
    if (dl.done || dl.receiving || dl.relayTid) return;
    clearTimeout(dl.timer);
    if (dl.tid) {
      this.conns.get(dl.tid)?.close();
      this.conns.delete(dl.tid);
    }
    const tid = crypto.randomUUID();
    dl.relayTid = tid;
    const sink = new RelaySink(tid, dl.holder, this.io.relay);
    this.relays.set(tid, sink);
    dl.sink = sink;
    this.wireReceiver(dl, sink);
    sink.sendJson({ c: "req", id: dl.id });
  }

  private wireReceiver(dl: Download, sink: DataSink): void {
    dl.sink = sink;
    sink.onJson = (msg) => {
      if (msg.c === "begin") {
        dl.receiving = true;
        dl.mime = (msg.mime as string) || dl.mime;
        dl.chunks = [];
      } else if (msg.c === "end") {
        void this.finish(dl);
      } else if (msg.c === "err") {
        this.fail(dl);
      }
    };
    sink.onBytes = (buf) => dl.chunks.push(buf);
  }

  private async finish(dl: Download): Promise<void> {
    if (dl.done) return;
    dl.done = true;
    const blob = new Blob(dl.chunks, { type: dl.mime });
    const ok = await save(dl.id, blob);
    this.cleanupDownload(dl);
    if (ok) {
      this.io.announceHave(dl.id);
      this.onState(dl.id, "have");
    } else {
      this.onState(dl.id, "error");
    }
  }

  private fail(dl: Download): void {
    if (dl.done) return;
    dl.done = true;
    this.cleanupDownload(dl);
    this.onState(dl.id, "error");
  }

  private cleanupDownload(dl: Download): void {
    clearTimeout(dl.timer);
    if (dl.tid) {
      this.conns.get(dl.tid)?.close();
      this.conns.delete(dl.tid);
    }
    if (dl.relayTid) this.relays.delete(dl.relayTid);
    dl.chunks = [];
    this.downloads.delete(dl.id);
  }

  // --- holder side (serving) ----------------------------------------------

  private serve(sink: DataSink): void {
    sink.onJson = async (msg) => {
      if (msg.c !== "req") return;
      const id = msg.id as string;
      const file = await getFile(id);
      if (!file) {
        sink.sendJson({ c: "err", id, message: "not held" });
        return;
      }
      sink.sendJson({
        c: "begin",
        id,
        size: file.size,
        mime: file.type,
        name: file.name,
      });
      await streamFile(sink, file);
      sink.sendJson({ c: "end", id });
    };
  }

  // --- routing of inbound WS messages -------------------------------------

  /** Route an inbound `signal` (from ServerMsg) to the right connection. */
  onSignal(from: string, data: RtcSignalData): void {
    if (!data || !data.tid) return;
    let conn = this.conns.get(data.tid);
    if (!conn) {
      // A new incoming transfer — I'm the holder/answerer.
      conn = new RtcConnection(
        data.tid,
        from,
        this.io.signal,
        (sink) => this.serve(sink),
        () => this.conns.delete(data.tid),
      );
      this.conns.set(data.tid, conn);
    }
    void conn.onSignal(data);
  }

  /** Route an inbound `relay` (from ServerMsg) to the right relay sink. */
  onRelay(from: string, data: { tid?: string; j?: unknown; b?: string }): void {
    if (!data || !data.tid) return;
    let sink = this.relays.get(data.tid);
    if (!sink) {
      // A new incoming relay transfer — I'm the holder.
      sink = new RelaySink(data.tid, from, this.io.relay);
      this.relays.set(data.tid, sink);
      this.serve(sink);
    }
    sink.feed(data);
  }
}

async function streamFile(sink: DataSink, file: File): Promise<void> {
  const buf = await file.arrayBuffer();
  let off = 0;
  while (off < buf.byteLength) {
    while (sink.bufferedAmount() > RTC_HIGH_WATER) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const end = Math.min(off + CHUNK, buf.byteLength);
    sink.sendBytes(buf.slice(off, end));
    off = end;
    if (sink.kind === "relay") await new Promise((r) => setTimeout(r, 0));
  }
}
