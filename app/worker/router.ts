/**
 * Cloudflare Workers fetch-router: SSR pages + REST API, minus the WebSocket
 * (handled by the Durable Object) and minus static-file middleware (the Workers
 * Assets binding serves `bundled/` before the Worker).
 *
 * The SSR controllers (`home`, `room`) and the render/shell helpers are reused
 * verbatim from the Deno server — they're storage-agnostic. The API handlers
 * here mirror the Deno controllers but read/write through the edge Turso/R2
 * store instead of the Deno hub singleton.
 */

import { createRouter } from "@remix-run/fetch-router";
import { routes } from "../server/routes.ts";
import { homeAction } from "../server/controllers/home.tsx";
import { roomAction } from "../server/controllers/room.tsx";
import { edgeRoomStore } from "./edge_deps.ts";

const MAX_THUMB_BYTES = 200 * 1024;

const router = createRouter();

router.get(routes.home, homeAction);
router.get(routes.room, roomAction);

router.get(routes.roomIndex, {
  async handler(context) {
    const files = await edgeRoomStore(context.params.roomId).listFiles();
    return Response.json(files);
  },
});

router.get(routes.thumbGet, {
  async handler(context) {
    const id = new URL(context.request.url).searchParams.get("id");
    if (!id) return new Response("id required", { status: 400 });
    const thumb = await edgeRoomStore(context.params.roomId).getThumb(id);
    if (!thumb) return new Response("not found", { status: 404 });
    return new Response(thumb.bytes, {
      headers: {
        "content-type": thumb.ct,
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  },
});

router.post(routes.thumbPut, {
  async handler(context) {
    const { request } = context;
    const id = new URL(request.url).searchParams.get("id");
    if (!id) return new Response("id required", { status: 400 });
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength === 0) {
      return new Response("empty body", { status: 400 });
    }
    if (bytes.byteLength > MAX_THUMB_BYTES) {
      return new Response("thumbnail too large", { status: 413 });
    }
    const ct = request.headers.get("content-type") ?? "image/jpeg";
    await edgeRoomStore(context.params.roomId).putThumb(id, { bytes, ct });
    return new Response(null, { status: 204 });
  },
});

export default router;
