import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  decryptBytes,
  decryptString,
  deriveRoomId,
  encryptBytes,
  encryptString,
  fromBase64Url,
  generatePartyKey,
  importKeyRaw,
  keyFromLocation,
  partyLink,
  sha256Hex,
  toBase64Url,
} from "./crypto.ts";

Deno.test("base64url round-trips arbitrary bytes", () => {
  const bytes = crypto.getRandomValues(new Uint8Array(37));
  assertEquals(fromBase64Url(toBase64Url(bytes)), bytes);
  // URL-safe alphabet, no padding.
  assert(!toBase64Url(bytes).includes("+"));
  assert(!toBase64Url(bytes).includes("/"));
  assert(!toBase64Url(bytes).includes("="));
});

Deno.test("encryptBytes/decryptBytes round-trip", async () => {
  const key = await generatePartyKey();
  const data = crypto.getRandomValues(new Uint8Array(1024));
  const blob = await encryptBytes(key, data);
  assertNotEquals(blob, data);
  assertEquals(await decryptBytes(key, blob), data);
});

Deno.test("random IV means identical plaintext encrypts differently", async () => {
  const key = await generatePartyKey();
  const data = new TextEncoder().encode("same bytes");
  const a = await encryptBytes(key, data);
  const b = await encryptBytes(key, data);
  assertNotEquals(a, b);
  assertEquals(await decryptBytes(key, a), await decryptBytes(key, b));
});

Deno.test("encryptString/decryptString round-trip", async () => {
  const key = await generatePartyKey();
  const text = "vacation-photo-01.jpg 🏖️";
  assertEquals(await decryptString(key, await encryptString(key, text)), text);
});

Deno.test("partyLink and keyFromLocation round-trip the key", async () => {
  const key = await generatePartyKey();
  const link = await partyLink("https://example.com/", key);
  assert(new URL(link).hash.startsWith("#k="));

  const recovered = await keyFromLocation(new URL(link));
  assert(recovered);
  // Same key material encrypts+decrypts across the two handles.
  const msg = "hello";
  assertEquals(
    await decryptString(recovered, await encryptString(key, msg)),
    msg,
  );
});

Deno.test("keyFromLocation returns null without a key fragment", async () => {
  assertEquals(await keyFromLocation("#other=1"), null);
  assertEquals(await keyFromLocation(""), null);
});

Deno.test("deriveRoomId is deterministic, opaque, and hex", async () => {
  const raw = new Uint8Array(32).fill(7);
  const key = await importKeyRaw(raw);
  const roomId = await deriveRoomId(key);
  assertEquals(roomId.length, 64);
  assert(/^[0-9a-f]{64}$/.test(roomId));
  // Deterministic for the same key.
  assertEquals(await deriveRoomId(await importKeyRaw(raw)), roomId);
  // Different key -> different room.
  const other = await importKeyRaw(new Uint8Array(32).fill(8));
  assertNotEquals(await deriveRoomId(other), roomId);
});

Deno.test("sha256Hex matches a known vector", async () => {
  // SHA-256("abc")
  assertEquals(
    await sha256Hex(new TextEncoder().encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});
