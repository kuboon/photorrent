/**
 * Typed WebSocket wrapper for a room connection.
 *
 * Sends `join` (with this tab's peerId) on every (re)connect, parses incoming
 * frames into {@link ServerMsg}, and auto-reconnects with capped backoff. The
 * protocol types are shared with the server (`import type` only — erased at
 * build, so nothing server-side is pulled into the browser bundle).
 */

import type { ClientMsg, ServerMsg } from "../../server/lib/protocol.ts";

export type ConnStatus = "connecting" | "open" | "closed";

export class WsClient {
  private ws: WebSocket | null = null;
  private stopped = false;
  private backoff = 500;

  constructor(
    private url: string,
    private peerId: string,
    private onMessage: (msg: ServerMsg) => void,
    private onStatus: (status: ConnStatus) => void = () => {},
  ) {
    this.connect();
  }

  private connect(): void {
    this.onStatus("connecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.backoff = 500;
      this.onStatus("open");
      this.send({ t: "join", peerId: this.peerId });
    };

    ws.onmessage = (event) => {
      try {
        this.onMessage(JSON.parse(event.data) as ServerMsg);
      } catch (err) {
        console.warn("[ws] bad message", err);
      }
    };

    ws.onclose = () => {
      this.onStatus("closed");
      if (this.stopped) return;
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 10000);
    };

    ws.onerror = () => ws.close();
  }

  send(msg: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  close(): void {
    this.stopped = true;
    this.ws?.close();
  }
}
