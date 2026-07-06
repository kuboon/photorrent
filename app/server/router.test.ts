import { assertEquals, assertStringIncludes } from "@std/assert";
import router from "./router.ts";
import { hub } from "./lib/room_hub.ts";
import type { FileMeta } from "./lib/protocol.ts";

const FRAME = { "rmx-frame": "1" };

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, init);
}

function sampleFile(id: string): FileMeta {
  return {
    id,
    filename: `${id}.jpg`,
    size: 42,
    mime: "image/jpeg",
    width: 256,
    height: 256,
    thumbUrl: `/api/room/x/thumb?id=${id}`,
    uploader: "tester",
    createdAt: 1,
  };
}

Deno.test("GET / renders the shell", async () => {
  const res = await router.fetch(req("/"));
  assertEquals(res.status, 200);
  const html = await res.text();
  assertStringIncludes(html, "photorrent");
});

Deno.test("GET / (frame) renders the create-album fragment", async () => {
  const res = await router.fetch(req("/", { headers: FRAME }));
  assertEquals(res.status, 200);
  const html = await res.text();
  assertStringIncludes(html, "アルバムを作成");
  // A fresh, shareable roomId is minted into the link.
  assertStringIncludes(html, 'href="/room/');
});

Deno.test("GET /room/:roomId (frame) renders the RoomPage client entry", async () => {
  const res = await router.fetch(req("/room/testroom", { headers: FRAME }));
  assertEquals(res.status, 200);
  const html = await res.text();
  assertStringIncludes(html, "/room_page.js");
  assertStringIncludes(html, "アルバム");
});

Deno.test("GET /api/room/:roomId/index reflects the hub", async () => {
  const room = "router-index-test";
  let res = await router.fetch(req(`/api/room/${room}/index`));
  assertEquals(res.status, 200);
  assertEquals(await res.json(), []);

  await hub.addFile(room, sampleFile("deadbeef"));

  res = await router.fetch(req(`/api/room/${room}/index`));
  const files = await res.json() as FileMeta[];
  assertEquals(files.length, 1);
  assertEquals(files[0].id, "deadbeef");
});

Deno.test("thumbnail POST then GET round-trips the bytes", async () => {
  const room = "router-thumb-test";
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);

  const post = await router.fetch(
    req(`/api/room/${room}/thumb?id=abc`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: bytes,
    }),
  );
  assertEquals(post.status, 204);

  const get = await router.fetch(req(`/api/room/${room}/thumb?id=abc`));
  assertEquals(get.status, 200);
  assertEquals(get.headers.get("content-type"), "image/png");
  assertEquals(new Uint8Array(await get.arrayBuffer()), bytes);
});

Deno.test("GET unknown thumbnail is 404", async () => {
  const res = await router.fetch(req(`/api/room/nope/thumb?id=missing`));
  assertEquals(res.status, 404);
});

Deno.test("GET /ws/:roomId without an upgrade header is 426", async () => {
  const res = await router.fetch(req("/ws/testroom"));
  assertEquals(res.status, 426);
  await res.body?.cancel();
});
