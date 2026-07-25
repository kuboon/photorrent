import { assertEquals } from "@std/assert";
import { crc32, makeZip } from "./zip.ts";

Deno.test("crc32 matches the standard check value", () => {
  // CRC-32 of "123456789" is 0xCBF43926 (the canonical test vector).
  assertEquals(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

Deno.test("makeZip emits a valid STORE archive", async () => {
  const enc = new TextEncoder();
  const a = enc.encode("hello");
  const b = enc.encode("world!!");
  const blob = await makeZip([
    { name: "a.txt", blob: new Blob([a]) },
    { name: "b.txt", blob: new Blob([b]) },
  ]);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);

  // Starts with a local file header.
  assertEquals(view.getUint32(0, true), 0x04034b50);
  // Ends with the End Of Central Directory record.
  const eocd = bytes.length - 22;
  assertEquals(view.getUint32(eocd, true), 0x06054b50);
  // Two entries recorded.
  assertEquals(view.getUint16(eocd + 10, true), 2);
  // First entry stores the correct CRC-32 (offset 14 in the local header).
  assertEquals(view.getUint32(14, true), crc32(a));
  // Method is STORE (0) for the first entry (offset 8).
  assertEquals(view.getUint16(8, true), 0);
});

Deno.test("makeZip de-dupes repeated names", async () => {
  const enc = new TextEncoder();
  const blob = await makeZip([
    { name: "pic.jpg", blob: new Blob([enc.encode("one")]) },
    { name: "pic.jpg", blob: new Blob([enc.encode("two")]) },
  ]);
  const text = await blob.text();
  // The second entry's central/local name is disambiguated.
  assertEquals(text.includes("pic (1).jpg"), true);
});
