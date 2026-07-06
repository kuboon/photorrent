/**
 * GET /api/room/:roomId/index — the room's full file index as JSON.
 *
 * The live client relies on the WS `snapshot` instead; this endpoint exists for
 * tests and as a no-JS/debug fallback.
 */

import type { BuildAction } from "@remix-run/fetch-router";
import type { routes } from "../../routes.ts";
import { hub } from "../../lib/room_hub.ts";

export const roomIndexAction = {
  async handler(context) {
    const roomId = context.params.roomId;
    const files = await hub.listFiles(roomId);
    return Response.json(files);
  },
} satisfies BuildAction<"GET", typeof routes.roomIndex>;
