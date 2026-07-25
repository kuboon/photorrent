/**
 * Minimal self-made ZIP writer (STORE / no compression).
 *
 * Photos and videos are already compressed, so deflate wouldn't shrink them —
 * STORE keeps the code tiny and CPU-free. The archive is assembled as a Blob
 * whose file bodies are the original (OPFS-backed) Blobs, not copies in RAM, so
 * memory stays roughly constant regardless of total size. Each file is read
 * once, streamed, only to compute its CRC-32 (which STORE must put in the local
 * header, ahead of the data).
 *
 * No ZIP64: callers must keep the total under 4 GiB (the classic 32-bit ZIP
 * limit). The gallery enforces this before offering a bulk download.
 */

export interface ZipEntry {
  name: string;
  blob: Blob;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

/** Streaming CRC-32; feed chunks, read `.value` at the end. */
class Crc32 {
  #crc = 0xffffffff;
  update(bytes: Uint8Array): void {
    let c = this.#crc;
    for (let i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    this.#crc = c >>> 0;
  }
  get value(): number {
    return (this.#crc ^ 0xffffffff) >>> 0;
  }
}

/** CRC-32 of a whole byte array (used by tests). */
export function crc32(bytes: Uint8Array): number {
  const c = new Crc32();
  c.update(bytes);
  return c.value;
}

async function crc32OfBlob(blob: Blob): Promise<number> {
  const crc = new Crc32();
  const reader = blob.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) crc.update(value);
  }
  return crc.value;
}

/** DOS date/time fields for a Date (MS-DOS epoch, 2-second resolution). */
function dosDateTime(d: Date): { time: number; date: number } {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) |
    (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) |
    d.getDate();
  return { time, date };
}

/** Disambiguate repeated names as "name (n).ext", matching the CLI export. */
function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 1;; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

/**
 * Build a STORE zip of `entries` as an `application/zip` Blob. File bodies are
 * referenced from their source Blobs; only headers live in memory.
 */
export async function makeZip(entries: ZipEntry[]): Promise<Blob> {
  const enc = new TextEncoder();
  const { time, date } = dosDateTime(new Date());

  const parts: Array<Uint8Array<ArrayBuffer> | Blob> = [];
  const central: Uint8Array<ArrayBuffer>[] = [];
  const usedNames = new Set<string>();
  let offset = 0;

  for (const entry of entries) {
    const name = uniqueName(entry.name, usedNames);
    // Copy into an ArrayBuffer-backed view so it satisfies BlobPart.
    const nameBytes = new Uint8Array(enc.encode(name));
    const size = entry.blob.size;
    const crc = await crc32OfBlob(entry.blob);

    const localBytes = new Uint8Array(30);
    const local = new DataView(localBytes.buffer);
    local.setUint32(0, 0x04034b50, true); // local file header signature
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0x0800, true); // flags: UTF-8 name
    local.setUint16(8, 0, true); // method: store
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true); // compressed size
    local.setUint32(22, size, true); // uncompressed size
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true); // extra length

    parts.push(localBytes, nameBytes, entry.blob);

    const cdHeader = new Uint8Array(46);
    const cd = new DataView(cdHeader.buffer);
    cd.setUint32(0, 0x02014b50, true); // central directory signature
    cd.setUint16(4, 20, true); // version made by
    cd.setUint16(6, 20, true); // version needed
    cd.setUint16(8, 0x0800, true); // flags: UTF-8
    cd.setUint16(10, 0, true); // method: store
    cd.setUint16(12, time, true);
    cd.setUint16(14, date, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, size, true);
    cd.setUint32(24, size, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint16(30, 0, true); // extra length
    cd.setUint16(32, 0, true); // comment length
    cd.setUint16(34, 0, true); // disk number start
    cd.setUint16(36, 0, true); // internal attrs
    cd.setUint32(38, 0, true); // external attrs
    cd.setUint32(42, offset, true); // local header offset

    const cdRecord = new Uint8Array(46 + nameBytes.length);
    cdRecord.set(cdHeader, 0);
    cdRecord.set(nameBytes, 46);
    central.push(cdRecord);

    offset += 30 + nameBytes.length + size;
  }

  const centralSize = central.reduce((n, r) => n + r.length, 0);
  const eocdBytes = new Uint8Array(22);
  const eocd = new DataView(eocdBytes.buffer);
  eocd.setUint32(0, 0x06054b50, true); // end of central directory signature
  eocd.setUint16(4, 0, true); // disk number
  eocd.setUint16(6, 0, true); // disk with central directory
  eocd.setUint16(8, entries.length, true); // records on this disk
  eocd.setUint16(10, entries.length, true); // total records
  eocd.setUint32(12, centralSize, true);
  eocd.setUint32(16, offset, true); // central directory offset
  eocd.setUint16(20, 0, true); // comment length

  return new Blob([...parts, ...central, eocdBytes], {
    type: "application/zip",
  });
}
