import { assertEquals } from "@std/assert";
import { createClient } from "@libsql/client";
import { RoomHub, type Sink } from "./room_hub.ts";
import { createRoomStore } from "./index_store.ts";
import { makeDeps } from "./db.ts";
import type { ObjectStore } from "./object_store.ts";
import type { FileMeta, ServerMsg } from "./protocol.ts";

/** In-memory thumbnail store so hub tests never touch the filesystem. */
class MemObjectStore implements ObjectStore {
  private map = new Map<string, Uint8Array>();
  put(key: string, bytes: Uint8Array): Promise<void> {
    this.map.set(key, bytes);
    return Promise.resolve();
  }
  get(key: string): Promise<Uint8Array | null> {
    return Promise.resolve(this.map.get(key) ?? null);
  }
}

/** A hub backed by a fresh in-memory libSQL db, isolated per test. */
function newHub(): RoomHub {
  const deps = makeDeps(createClient({ url: ":memory:" }));
  const objectStore = new MemObjectStore();
  return new RoomHub((roomId) =>
    createRoomStore(roomId, { deps, objectStore })
  );
}

/** Fake WebSocket that records the messages sent to it. */
class FakeSocket implements Sink {
  readyState = 1; // OPEN
  sent: ServerMsg[] = [];
  send(data: string): void {
    this.sent.push(JSON.parse(data) as ServerMsg);
  }
  close(): void {
    this.readyState = 3; // CLOSED
  }
  ofType<T extends ServerMsg["t"]>(t: T): Extract<ServerMsg, { t: T }>[] {
    return this.sent.filter((m) => m.t === t) as Extract<
      ServerMsg,
      { t: T }
    >[];
  }
}

function file(id: string, uploader = "p1"): FileMeta {
  return {
    id,
    filename: `${id}.jpg`,
    size: 1234,
    mime: "image/jpeg",
    width: 256,
    height: 256,
    thumbUrl: `/api/room/r1/thumb?id=${id}`,
    uploader,
    createdAt: id.length, // stable, avoids Date.now in tests
  };
}

Deno.test("join returns a snapshot and registers the peer", async () => {
  const hub = newHub();
  const a = new FakeSocket();
  const snap = await hub.join("r1", "p1", a);

  assertEquals(snap.files, []);
  assertEquals(snap.peers, ["p1"]);
  const snapshots = a.ofType("snapshot");
  assertEquals(snapshots.length, 1);
  assertEquals(snapshots[0].peers, ["p1"]);
});

Deno.test("add broadcasts 'added' to every socket in the room", async () => {
  const hub = newHub();
  const a = new FakeSocket();
  const b = new FakeSocket();
  await hub.join("r1", "p1", a);
  await hub.join("r1", "p2", b);

  await hub.addFile("r1", file("aa"));

  assertEquals(a.ofType("added").length, 1);
  assertEquals(b.ofType("added").length, 1);
  assertEquals(a.ofType("added")[0].file.id, "aa");
});

Deno.test("rooms are isolated: files do not leak across rooms", async () => {
  const hub = newHub();
  const a = new FakeSocket();
  await hub.join("r1", "p1", a);
  await hub.addFile("r1", file("aa"));

  const b = new FakeSocket();
  const snap = await hub.join("r2", "p2", b);
  assertEquals(snap.files, []); // r2 sees nothing from r1
  assertEquals(b.ofType("added").length, 0);
});

Deno.test("snapshot on join reflects prior adds (no race)", async () => {
  const hub = newHub();
  const a = new FakeSocket();
  await hub.join("r1", "p1", a);
  await hub.addFile("r1", file("aa"));
  await hub.addFile("r1", file("bb"));

  const b = new FakeSocket();
  const snap = await hub.join("r1", "p2", b);
  const ids = snap.files.map((f) => f.id).sort();
  assertEquals(ids, ["aa", "bb"]);
});

Deno.test("relaySignal reaches only the addressed peer", async () => {
  const hub = newHub();
  const a = new FakeSocket();
  const b = new FakeSocket();
  const c = new FakeSocket();
  await hub.join("r1", "p1", a);
  await hub.join("r1", "p2", b);
  await hub.join("r1", "p3", c);

  hub.relaySignal("r1", "p1", "p2", { sdp: "offer" });

  assertEquals(b.ofType("signal").length, 1);
  assertEquals(b.ofType("signal")[0].from, "p1");
  assertEquals(a.ofType("signal").length, 0);
  assertEquals(c.ofType("signal").length, 0);
});

Deno.test("presence fires for others on join and leave", async () => {
  const hub = newHub();
  const a = new FakeSocket();
  await hub.join("r1", "p1", a);

  const b = new FakeSocket();
  await hub.join("r1", "p2", b);
  // a should have been told p2 joined
  const aPresence = a.ofType("presence");
  assertEquals(aPresence.at(-1)?.peers.sort(), ["p1", "p2"]);

  hub.leave("r1", "p2");
  assertEquals(a.ofType("presence").at(-1)?.peers, ["p1"]);
});

Deno.test("last peer leaving drops the room", async () => {
  const hub = newHub();
  const a = new FakeSocket();
  await hub.join("r1", "p1", a);
  assertEquals(hub.peerCount("r1"), 1);

  hub.leave("r1", "p1");
  assertEquals(hub.peerCount("r1"), 0);
});

Deno.test("closed sockets are skipped on broadcast", async () => {
  const hub = newHub();
  const a = new FakeSocket();
  const b = new FakeSocket();
  await hub.join("r1", "p1", a);
  await hub.join("r1", "p2", b);
  b.readyState = 3; // CLOSED but still registered

  await hub.addFile("r1", file("aa"));
  assertEquals(a.ofType("added").length, 1);
  assertEquals(b.ofType("added").length, 0);
});

Deno.test("remove broadcasts 'removed'", async () => {
  const hub = newHub();
  const a = new FakeSocket();
  await hub.join("r1", "p1", a);
  await hub.addFile("r1", file("aa"));
  await hub.removeFile("r1", "aa");

  assertEquals(a.ofType("removed").length, 1);
  assertEquals(a.ofType("removed")[0].id, "aa");
  assertEquals((await hub.listFiles("r1")).length, 0);
});

Deno.test("addFile registers the uploader as a holder", async () => {
  const hub = newHub();
  const a = new FakeSocket();
  await hub.join("r1", "p1", a);
  await hub.addFile("r1", file("aa", "uploaderX"));

  const holders = a.ofType("holders");
  assertEquals(holders.at(-1)?.id, "aa");
  assertEquals(holders.at(-1)?.peers, ["uploaderX"]);
});

Deno.test("have adds a holder and broadcasts it", async () => {
  const hub = newHub();
  const a = new FakeSocket();
  const b = new FakeSocket();
  await hub.join("r1", "p1", a);
  await hub.join("r1", "p2", b);
  await hub.addFile("r1", file("aa", "p1"));

  hub.have("r1", "p2", "aa");
  const last = b.ofType("holders").at(-1);
  assertEquals(last?.id, "aa");
  assertEquals(last?.peers.sort(), ["p1", "p2"]);
});

Deno.test("snapshot includes the current holders map", async () => {
  const hub = newHub();
  const a = new FakeSocket();
  await hub.join("r1", "p1", a);
  await hub.addFile("r1", file("aa", "p1"));

  const b = new FakeSocket();
  await hub.join("r1", "p2", b);
  assertEquals(b.ofType("snapshot")[0].holders, { aa: ["p1"] });
});

Deno.test("leaving drops the peer from holder sets", async () => {
  const hub = newHub();
  const a = new FakeSocket();
  const b = new FakeSocket();
  await hub.join("r1", "p1", a);
  await hub.join("r1", "p2", b);
  await hub.addFile("r1", file("aa", "p2")); // p2 is the sole holder

  hub.leave("r1", "p2");
  assertEquals(a.ofType("holders").at(-1)?.peers, []); // p2 removed
});

Deno.test("relay reaches only the addressed peer", async () => {
  const hub = newHub();
  const a = new FakeSocket();
  const b = new FakeSocket();
  const c = new FakeSocket();
  await hub.join("r1", "p1", a);
  await hub.join("r1", "p2", b);
  await hub.join("r1", "p3", c);

  hub.relay("r1", "p1", "p2", { chunk: 1 });
  assertEquals(b.ofType("relay").length, 1);
  assertEquals(b.ofType("relay")[0].from, "p1");
  assertEquals(a.ofType("relay").length, 0);
  assertEquals(c.ofType("relay").length, 0);
});
