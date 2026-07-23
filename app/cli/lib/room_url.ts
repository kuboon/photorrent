/**
 * Room URL parsing and endpoint derivation for the CLI.
 *
 * A guest is handed one URL — `https://host/room/<roomId>` — exactly like the
 * web client. From it the CLI derives everything it needs: the WebSocket URL
 * (`wss://host/ws/<roomId>`) and the thumbnail endpoint. Rooms are implicit:
 * the server creates one lazily on the first WS join, so `new` just mints a
 * random id locally (same scheme as the web landing page) — there is no
 * server-side "create room" call.
 */

/** Endpoints for one room, all derived from the shared room URL. */
export interface RoomEndpoints {
  /** `https://host` — scheme + host, no path. */
  origin: string;
  roomId: string;
  /** `wss://host/ws/<roomId>` (ws for plain http). */
  wsUrl: string;
  /** Relative thumbnail path stored in the index, matching the web client. */
  thumbPath: (fileId: string) => string;
  /** Absolute thumbnail URL to POST/GET bytes. */
  thumbUrl: (fileId: string) => string;
}

/** URL-friendly random room id (~16 base64url chars), matching `home.tsx`. */
export function newRoomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/**
 * Build a fresh room URL under `serverInput` (any URL on the target server;
 * only its origin is used). Returns `https://host/room/<newId>`.
 */
export function newRoomUrl(serverInput: string): string {
  const origin = new URL(serverInput).origin;
  return `${origin}/room/${newRoomId()}`;
}

/**
 * Parse a room URL into its endpoints. Throws if it isn't a `…/room/<id>` URL.
 */
export function parseRoomUrl(input: string): RoomEndpoints {
  const url = new URL(input);
  const segments = url.pathname.split("/").filter(Boolean);
  const roomIdx = segments.indexOf("room");
  const roomId = roomIdx >= 0 ? segments[roomIdx + 1] : undefined;
  if (!roomId) {
    throw new Error(
      `not a room URL (expected …/room/<id>): ${input}`,
    );
  }
  const origin = url.origin;
  const wsScheme = url.protocol === "https:" ? "wss:" : "ws:";
  return {
    origin,
    roomId,
    wsUrl: `${wsScheme}//${url.host}/ws/${roomId}`,
    thumbPath: (id) => `/api/room/${roomId}/thumb?id=${id}`,
    thumbUrl: (id) => `${origin}/api/room/${roomId}/thumb?id=${id}`,
  };
}
