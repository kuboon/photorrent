import { assertEquals, assertMatch, assertThrows } from "@std/assert";
import { newRoomId, newRoomUrl, parseRoomUrl } from "./room_url.ts";

Deno.test("parseRoomUrl derives ws + thumb endpoints", () => {
  const r = parseRoomUrl("https://example.com/room/MO94MyA7k4MbZxjO");
  assertEquals(r.origin, "https://example.com");
  assertEquals(r.roomId, "MO94MyA7k4MbZxjO");
  assertEquals(r.wsUrl, "wss://example.com/ws/MO94MyA7k4MbZxjO");
  assertEquals(
    r.thumbPath("abc"),
    "/api/room/MO94MyA7k4MbZxjO/thumb?id=abc",
  );
  assertEquals(
    r.thumbUrl("abc"),
    "https://example.com/api/room/MO94MyA7k4MbZxjO/thumb?id=abc",
  );
});

Deno.test("parseRoomUrl uses ws:// for http and ignores query", () => {
  const r = parseRoomUrl("http://localhost:8000/room/xyz?name=Party");
  assertEquals(r.wsUrl, "ws://localhost:8000/ws/xyz");
  assertEquals(r.roomId, "xyz");
});

Deno.test("parseRoomUrl rejects non-room URLs", () => {
  assertThrows(() => parseRoomUrl("https://example.com/"));
  assertThrows(() => parseRoomUrl("https://example.com/room/"));
});

Deno.test("newRoomId is url-safe and has no padding", () => {
  const id = newRoomId();
  assertMatch(id, /^[A-Za-z0-9_-]+$/);
});

Deno.test("newRoomUrl uses only the server origin", () => {
  const url = newRoomUrl("https://example.com/some/path?q=1");
  assertMatch(url, /^https:\/\/example\.com\/room\/[A-Za-z0-9_-]+$/);
});
