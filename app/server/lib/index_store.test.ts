import { assertEquals } from "@std/assert";
import { createClient } from "@libsql/client";
import { createRoomStore, type RoomStore } from "./index_store.ts";
import { makeDeps } from "./db.ts";
import type { ObjectStore } from "./object_store.ts";
import type { FileMeta } from "./protocol.ts";

class MemObjectStore implements ObjectStore {
  map = new Map<string, Uint8Array>();
  put(key: string, bytes: Uint8Array): Promise<void> {
    this.map.set(key, bytes);
    return Promise.resolve();
  }
  get(key: string): Promise<Uint8Array | null> {
    return Promise.resolve(this.map.get(key) ?? null);
  }
}

/** Fresh in-memory store factory (shared db + object store across its rooms). */
function fixture() {
  const deps = makeDeps(createClient({ url: ":memory:" }));
  const objectStore = new MemObjectStore();
  return {
    room: (id: string): RoomStore => createRoomStore(id, { deps, objectStore }),
    objectStore,
  };
}

function file(id: string, over: Partial<FileMeta> = {}): FileMeta {
  return {
    id,
    filename: `${id}.jpg`,
    size: 100,
    mime: "image/jpeg",
    width: 256,
    height: 256,
    thumbUrl: `ignored`,
    uploader: "p1",
    createdAt: 1,
    ...over,
  };
}

Deno.test("addFile then listFiles returns the file (derived thumbUrl)", async () => {
  const s = fixture().room("r1");
  await s.addFile(file("aa"));
  const list = await s.listFiles();
  assertEquals(list.length, 1);
  assertEquals(list[0].id, "aa");
  assertEquals(list[0].thumbUrl, "/api/room/r1/thumb?id=aa");
});

Deno.test("listFiles is ordered by createdAt and scoped to the room", async () => {
  const f = fixture();
  const r1 = f.room("r1");
  await r1.addFile(file("bb", { createdAt: 2 }));
  await r1.addFile(file("aa", { createdAt: 1 }));
  await f.room("r2").addFile(file("cc", { createdAt: 3 }));

  assertEquals((await r1.listFiles()).map((x) => x.id), ["aa", "bb"]);
  assertEquals((await f.room("r2").listFiles()).map((x) => x.id), ["cc"]);
});

Deno.test("addFile upserts (same id refreshes metadata, no duplicate)", async () => {
  const s = fixture().room("r1");
  await s.addFile(file("aa", { filename: "old.jpg" }));
  await s.addFile(file("aa", { filename: "new.jpg" }));
  const list = await s.listFiles();
  assertEquals(list.length, 1);
  assertEquals(list[0].filename, "new.jpg");
});

Deno.test("removeFile deletes the row", async () => {
  const s = fixture().room("r1");
  await s.addFile(file("aa"));
  await s.removeFile("aa");
  assertEquals(await s.listFiles(), []);
});

Deno.test("thumbnail put/get round-trips bytes and content-type", async () => {
  const s = fixture().room("r1");
  const bytes = new Uint8Array([1, 2, 3, 4]);
  await s.putThumb("aa", { bytes, ct: "image/png" });
  const got = await s.getThumb("aa");
  assertEquals(got?.ct, "image/png");
  assertEquals(got?.bytes, bytes);
  assertEquals(await s.getThumb("missing"), null);
});
