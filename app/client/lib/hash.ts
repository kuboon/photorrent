/**
 * Content addressing — a file's SHA-256 (hex) is its id, giving free dedup
 * across peers (the same photo uploaded twice shares one index entry).
 */

/** SHA-256 of a Blob/File as a lowercase hex string. */
export async function contentHash(file: Blob): Promise<string> {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
