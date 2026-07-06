/**
 * Thumbnail bytes for a file, addressed by `?id=<fileId>`.
 *
 *   POST /api/room/:roomId/thumb?id=<fileId>  — store bytes (body = image)
 *   GET  /api/room/:roomId/thumb?id=<fileId>  — fetch bytes
 *
 * Thumbnails are kept out of the index value (Deno KV's 64 KiB cap) and served
 * from here with a long immutable cache — safe because the id is a content hash.
 */

import type { BuildAction } from "@remix-run/fetch-router";
import type { routes } from "../../routes.ts";
import { hub } from "../../lib/room_hub.ts";

/** Reject thumbnails larger than this (they should be small JPEGs). */
const MAX_THUMB_BYTES = 200 * 1024;

export const thumbGetAction = {
  async handler(context) {
    const roomId = context.params.roomId;
    const id = new URL(context.request.url).searchParams.get("id");
    if (!id) return new Response("id required", { status: 400 });

    const thumb = await hub.getThumb(roomId, id);
    if (!thumb) return new Response("not found", { status: 404 });

    return new Response(thumb.bytes, {
      headers: {
        "content-type": thumb.ct,
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  },
} satisfies BuildAction<"GET", typeof routes.thumbGet>;

export const thumbPutAction = {
  async handler(context) {
    const roomId = context.params.roomId;
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
    await hub.putThumb(roomId, id, { bytes, ct });
    return new Response(null, { status: 204 });
  },
} satisfies BuildAction<"POST", typeof routes.thumbPut>;
