import { get, post, route } from "@remix-run/fetch-router/routes";

export const routes = route({
  home: get("/"),
  // Room page shell. `:roomId` is known at SSR time and injected into the
  // RoomPage client entry as a prop.
  room: get("/room/:roomId"),
  // WebSocket upgrade endpoint for a room (index sync + signaling relay).
  ws: get("/ws/:roomId"),
  // Full index snapshot (REST) — used by tests and as a no-JS/debug fallback.
  roomIndex: get("/api/room/:roomId/index"),
  // Thumbnail bytes: `?id=<fileId>`.
  thumbGet: get("/api/room/:roomId/thumb"),
  thumbPut: post("/api/room/:roomId/thumb"),
});
