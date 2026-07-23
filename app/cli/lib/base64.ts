/**
 * Byte ↔ base64 helpers over the native `Uint8Array` base64 methods, which are
 * binary-safe and produce the standard alphabet + padding — byte-for-byte
 * compatible with the web client's `btoa`/`atob` relay frames. Typed wrappers
 * because the ambient lib doesn't yet declare these (still a TC39 proposal).
 */

/** Encode bytes to a standard (padded) base64 string. */
export function bytesToBase64(bytes: Uint8Array): string {
  return (bytes as unknown as { toBase64(): string }).toBase64();
}

/** Decode a standard base64 string to bytes. */
export function base64ToBytes(b64: string): Uint8Array {
  return (Uint8Array as unknown as {
    fromBase64(s: string): Uint8Array;
  }).fromBase64(b64);
}
