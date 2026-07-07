/**
 * WebRTC plumbing for peer-to-peer file transfer.
 *
 * A {@link DataSink} is a direction-agnostic bytes+JSON channel. Two backends
 * implement it: {@link RtcSink} (an RTCDataChannel) and {@link RelaySink} (the
 * server WS byte-relay fallback used when a direct connection can't be made).
 * The transfer protocol in `transfer.ts` is written against `DataSink` and
 * doesn't care which one it's using.
 *
 * Each transfer gets its own short-lived {@link RtcConnection}, keyed by a
 * transfer id (`tid`), so concurrent transfers never glare: the requester is
 * always the offerer and creates the data channel; the holder answers.
 */

const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
];

/** A bidirectional JSON+bytes channel, backed by RTC or the WS relay. */
export interface DataSink {
  readonly kind: "rtc" | "relay";
  sendJson(obj: unknown): void;
  sendBytes(buf: ArrayBuffer): void;
  /** Bytes still queued in the underlying channel (0 for relay). */
  bufferedAmount(): number;
  close(): void;
  onJson?: (obj: Record<string, unknown>) => void;
  onBytes?: (buf: ArrayBuffer) => void;
}

class RtcSink implements DataSink {
  readonly kind = "rtc";
  onJson?: (obj: Record<string, unknown>) => void;
  onBytes?: (buf: ArrayBuffer) => void;

  constructor(private dc: RTCDataChannel) {
    dc.binaryType = "arraybuffer";
    dc.onmessage = (e) => {
      if (typeof e.data === "string") this.onJson?.(JSON.parse(e.data));
      else this.onBytes?.(e.data as ArrayBuffer);
    };
  }
  sendJson(obj: unknown): void {
    this.dc.send(JSON.stringify(obj));
  }
  sendBytes(buf: ArrayBuffer): void {
    this.dc.send(buf);
  }
  bufferedAmount(): number {
    return this.dc.bufferedAmount;
  }
  close(): void {
    try {
      this.dc.close();
    } catch { /* already closed */ }
  }
}

/** Fallback channel that tunnels frames through the server WS `relay`. */
export class RelaySink implements DataSink {
  readonly kind = "relay";
  onJson?: (obj: Record<string, unknown>) => void;
  onBytes?: (buf: ArrayBuffer) => void;

  constructor(
    private tid: string,
    private remote: string,
    private sendRelay: (to: string, data: unknown) => void,
  ) {}

  sendJson(obj: unknown): void {
    this.sendRelay(this.remote, { tid: this.tid, j: obj });
  }
  sendBytes(buf: ArrayBuffer): void {
    this.sendRelay(this.remote, { tid: this.tid, b: bufToB64(buf) });
  }
  bufferedAmount(): number {
    return 0;
  }
  close(): void {}

  /** Feed an incoming relay payload addressed to this transfer. */
  feed(data: { j?: unknown; b?: string }): void {
    if (data.j !== undefined) this.onJson?.(data.j as Record<string, unknown>);
    else if (data.b !== undefined) this.onBytes?.(b64ToBuf(data.b));
  }
}

/** Signaling payload exchanged over the WS `signal` relay. */
export interface RtcSignalData {
  tid: string;
  sdp?: RTCSessionDescriptionInit;
  ice?: RTCIceCandidateInit;
}

/**
 * One RTCPeerConnection dedicated to a single transfer. The requester calls
 * {@link offer}; the holder just processes incoming signals and receives the
 * data channel via `ondatachannel`.
 */
export class RtcConnection {
  private pc: RTCPeerConnection;
  private pendingIce: RTCIceCandidateInit[] = [];
  private done = false;

  constructor(
    private tid: string,
    private remote: string,
    private sendSignal: (to: string, data: RtcSignalData) => void,
    private onOpen: (sink: DataSink) => void,
    private onFail: () => void,
  ) {
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.sendSignal(this.remote, { tid, ice: e.candidate.toJSON() });
      }
    };
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (s === "failed" || s === "disconnected" || s === "closed") this.fail();
    };
    this.pc.ondatachannel = (e) => this.attach(e.channel);
  }

  private attach(dc: RTCDataChannel): void {
    const sink = new RtcSink(dc);
    if (dc.readyState === "open") this.onOpen(sink);
    else dc.onopen = () => this.onOpen(sink);
  }

  private fail(): void {
    if (this.done) return;
    this.done = true;
    this.onFail();
    this.close();
  }

  /** Requester side: create the data channel and send an offer. */
  async offer(): Promise<void> {
    this.attach(this.pc.createDataChannel("file"));
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.sendSignal(this.remote, {
      tid: this.tid,
      sdp: this.pc.localDescription!,
    });
  }

  /** Process an incoming signaling payload for this transfer. */
  async onSignal(data: RtcSignalData): Promise<void> {
    if (data.sdp) {
      if (data.sdp.type === "offer") {
        await this.pc.setRemoteDescription(data.sdp);
        await this.drainIce();
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this.sendSignal(this.remote, {
          tid: this.tid,
          sdp: this.pc.localDescription!,
        });
      } else if (data.sdp.type === "answer") {
        await this.pc.setRemoteDescription(data.sdp);
        await this.drainIce();
      }
    } else if (data.ice) {
      if (this.pc.remoteDescription) await this.pc.addIceCandidate(data.ice);
      else this.pendingIce.push(data.ice);
    }
  }

  private async drainIce(): Promise<void> {
    while (this.pendingIce.length) {
      await this.pc.addIceCandidate(this.pendingIce.shift()!);
    }
  }

  close(): void {
    try {
      this.pc.close();
    } catch { /* already closed */ }
  }
}

// --- base64 helpers for the relay fallback --------------------------------

function bufToB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function b64ToBuf(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
