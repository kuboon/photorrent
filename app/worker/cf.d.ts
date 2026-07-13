/**
 * Minimal Cloudflare Workers ambient types — just the subset this worker uses,
 * so `deno check` passes without pulling in `@cloudflare/workers-types`. The
 * real types come from the workerd runtime at deploy/`wrangler dev` time.
 */

export {};

declare global {
  interface DurableObjectId {
    readonly name?: string;
  }
  interface DurableObjectStub {
    fetch(request: Request): Promise<Response>;
  }
  interface DurableObjectNamespace {
    idFromName(name: string): DurableObjectId;
    get(id: DurableObjectId): DurableObjectStub;
  }
  // deno-lint-ignore no-empty-interface
  interface DurableObjectState {}

  interface Fetcher {
    fetch(request: Request): Promise<Response>;
  }

  interface CFWebSocket {
    accept(): void;
    send(data: string | ArrayBuffer): void;
    close(code?: number, reason?: string): void;
    readyState: number;
    addEventListener(
      type: "message" | "close" | "error",
      listener: (event: { data?: unknown; code?: number }) => void,
    ): void;
  }

  class WebSocketPair {
    0: CFWebSocket;
    1: CFWebSocket;
  }

  // Allow returning an upgraded socket from a Response (CF extension).
  interface ResponseInit {
    webSocket?: CFWebSocket;
  }
}
