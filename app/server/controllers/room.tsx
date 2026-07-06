/**
 * GET /room/:roomId — the room page shell.
 *
 * `roomId` is known here at SSR time, so we inject it straight into the
 * `RoomPage` client entry as a prop; the browser never has to read it back
 * out of `location`. The server renders an empty gallery + dropzone skeleton
 * which the client then hydrates and fills live over the WebSocket.
 */

import type { BuildAction } from "@remix-run/fetch-router";
import type { routes } from "../routes.ts";
import { renderPage } from "../utils/render.tsx";
import { RoomPage } from "../../client/room_page.tsx";

export const roomAction = {
  handler(context) {
    const roomId = context.params.roomId;
    return renderPage(context, <RoomPage roomId={roomId} />);
  },
} satisfies BuildAction<"GET", typeof routes.room>;
