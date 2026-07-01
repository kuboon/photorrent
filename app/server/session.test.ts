import { assert, assertEquals } from "@std/assert";
import type { ManifestEntry, ServerMessage } from "../../src/protocol.ts";
import { MemoryManifestStore } from "./manifest-store.ts";
import { MemoryRoom } from "./room.ts";
import { createSession, sanitizeEntry } from "./session.ts";

const ROOM = "a".repeat(64);
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function collector() {
  const sent: ServerMessage[] = [];
  return { conn: { send: (m: ServerMessage) => sent.push(m) }, sent };
}

function entry(hash: string): ManifestEntry {
  return {
    hash,
    owner: "alice",
    size: 42,
    encName: "n",
    encThumb: "t",
    addedAt: 1,
  };
}

Deno.test("join replies with welcome and announces to existing peers", async () => {
  const room = new MemoryRoom();
  const store = new MemoryManifestStore();
  await store.append(ROOM, entry(HASH_A));

  const alice = collector();
  const aliceSession = createSession(ROOM, room, store, alice.conn);
  await aliceSession.onMessage(JSON.stringify({ t: "join", peerId: "alice" }));

  // Alice's welcome: no existing peers, one persisted manifest entry.
  assertEquals(alice.sent, [{
    t: "welcome",
    peers: [],
    manifest: [entry(HASH_A)],
  }]);

  const bob = collector();
  const bobSession = createSession(ROOM, room, store, bob.conn);
  await bobSession.onMessage(JSON.stringify({ t: "join", peerId: "bob" }));

  // Bob sees alice already present.
  assertEquals(bob.sent[0], {
    t: "welcome",
    peers: ["alice"],
    manifest: [entry(HASH_A)],
  });
  // Alice is told bob joined.
  assertEquals(alice.sent.at(-1), { t: "peer-join", peerId: "bob" });
});

Deno.test("manifest-add persists and broadcasts to everyone", async () => {
  const room = new MemoryRoom();
  const store = new MemoryManifestStore();
  const alice = collector();
  const bob = collector();
  const aliceSession = createSession(ROOM, room, store, alice.conn);
  const bobSession = createSession(ROOM, room, store, bob.conn);
  await aliceSession.onMessage(JSON.stringify({ t: "join", peerId: "alice" }));
  await bobSession.onMessage(JSON.stringify({ t: "join", peerId: "bob" }));

  await aliceSession.onMessage(
    JSON.stringify({ t: "manifest-add", entry: entry(HASH_B) }),
  );

  const msg: ServerMessage = { t: "manifest-entry", entry: entry(HASH_B) };
  assertEquals(alice.sent.at(-1), msg);
  assertEquals(bob.sent.at(-1), msg);
  assertEquals(await store.list(ROOM), [entry(HASH_B)]);
});

Deno.test("signal is relayed verbatim only to the addressed peer", async () => {
  const room = new MemoryRoom();
  const store = new MemoryManifestStore();
  const alice = collector();
  const bob = collector();
  const aliceSession = createSession(ROOM, room, store, alice.conn);
  const bobSession = createSession(ROOM, room, store, bob.conn);
  await aliceSession.onMessage(JSON.stringify({ t: "join", peerId: "alice" }));
  await bobSession.onMessage(JSON.stringify({ t: "join", peerId: "bob" }));

  const before = bob.sent.length;
  const sdp = { type: "sdp", description: { type: "offer", sdp: "..." } };
  await aliceSession.onMessage(
    JSON.stringify({ t: "signal", to: "bob", from: "x", data: sdp }),
  );

  // `from` is set by the server to the authenticated sender, not the client.
  assertEquals(bob.sent.at(-1), {
    t: "signal",
    to: "bob",
    from: "alice",
    data: sdp,
  });
  assertEquals(alice.sent.filter((m) => m.t === "signal").length, 0);
  assert(bob.sent.length === before + 1);
});

Deno.test("leave announces peer-leave", async () => {
  const room = new MemoryRoom();
  const store = new MemoryManifestStore();
  const alice = collector();
  const bob = collector();
  await createSessionAndJoin(ROOM, room, store, alice.conn, "alice");
  const bobSession = createSession(ROOM, room, store, bob.conn);
  await bobSession.onMessage(JSON.stringify({ t: "join", peerId: "bob" }));
  bobSession.onClose();
  assertEquals(alice.sent.at(-1), { t: "peer-leave", peerId: "bob" });
});

async function createSessionAndJoin(
  roomId: string,
  room: MemoryRoom,
  store: MemoryManifestStore,
  conn: { send: (m: ServerMessage) => void },
  peerId: string,
) {
  const s = createSession(roomId, room, store, conn);
  await s.onMessage(JSON.stringify({ t: "join", peerId }));
  return s;
}

Deno.test("sanitizeEntry rejects malformed entries", () => {
  assertEquals(sanitizeEntry({} as ManifestEntry), null);
  assertEquals(sanitizeEntry({ ...entry(HASH_A), hash: "nothex" }), null);
  assertEquals(sanitizeEntry({ ...entry(HASH_A), size: -1 }), null);
  assertEquals(sanitizeEntry(entry(HASH_A)), entry(HASH_A));
});
