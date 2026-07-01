/**
 * Party crypto for photo-swarm.
 *
 * A party is protected by a single symmetric key `K` (AES-GCM 256) shared
 * out-of-band via a link `#fragment` or QR. Everything that leaves the browser
 * — photo bytes, filenames, thumbnails — is encrypted with `K` first, so the
 * signaling server, the TURN relay, and any uninvited peer only ever see
 * ciphertext.
 *
 * The server is keyed by `roomId = SHA-256(rawKey)` (see {@link deriveRoomId}),
 * an opaque value derived from `K` but from which `K` cannot be recovered. This
 * lets the server route sockets and store the manifest without ever learning
 * `K`.
 *
 * Runs unchanged in the browser and in Deno — only Web Crypto + standard
 * TextEncoder/Decoder are used.
 */

const IV_BYTES = 12; // AES-GCM nonce length.
const KEY_BITS = 256;

/** The party key. AES-GCM, extractable so it can be serialized into a link. */
export type PartyKey = CryptoKey;

// ---------------------------------------------------------------------------
// base64url helpers (URL- and fragment-safe, no padding)
// ---------------------------------------------------------------------------

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}

export function fromBase64Url(text: string): Uint8Array {
  const padded = text.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

// ---------------------------------------------------------------------------
// key generation & (de)serialization
// ---------------------------------------------------------------------------

/** Generate a fresh party key. */
export function generatePartyKey(): Promise<PartyKey> {
  return crypto.subtle.generateKey(
    { name: "AES-GCM", length: KEY_BITS },
    true,
    ["encrypt", "decrypt"],
  );
}

/** Export the raw 32-byte key material. */
export async function exportKeyRaw(key: PartyKey): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.exportKey("raw", key));
}

/** Import raw 32-byte key material back into a {@link PartyKey}. */
export function importKeyRaw(raw: Uint8Array): Promise<PartyKey> {
  return crypto.subtle.importKey(
    "raw",
    raw as BufferSource,
    { name: "AES-GCM" },
    true,
    ["encrypt", "decrypt"],
  );
}

// ---------------------------------------------------------------------------
// link encoding: K lives in the URL fragment (never sent to the server)
// ---------------------------------------------------------------------------

const KEY_FRAGMENT_PREFIX = "k=";

/** Build a shareable party link: `<base>#k=<base64url>`. */
export async function partyLink(
  baseUrl: string,
  key: PartyKey,
): Promise<string> {
  const raw = await exportKeyRaw(key);
  const url = new URL(baseUrl);
  url.hash = KEY_FRAGMENT_PREFIX + toBase64Url(raw);
  return url.toString();
}

/**
 * Recover `K` from a location's fragment (`#k=...`). Returns `null` when no key
 * is present. Accepts a `Location`-like object or a raw hash string.
 */
export async function keyFromLocation(
  location: { hash: string } | string,
): Promise<PartyKey | null> {
  const hash = typeof location === "string" ? location : location.hash;
  const fragment = hash.startsWith("#") ? hash.slice(1) : hash;
  const params = new URLSearchParams(fragment);
  const encoded = params.get("k");
  if (!encoded) return null;
  try {
    return await importKeyRaw(fromBase64Url(encoded));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// room id derivation — opaque, one-way, so the server never sees K
// ---------------------------------------------------------------------------

/**
 * Derive the opaque room id the WebSocket is keyed by: `SHA-256(rawKey)` in
 * hex. One-way, so the server can group peers and persist the manifest without
 * ever learning `K`.
 */
export async function deriveRoomId(key: PartyKey): Promise<string> {
  const raw = await exportKeyRaw(key);
  const digest = await crypto.subtle.digest("SHA-256", raw as BufferSource);
  return toHex(new Uint8Array(digest));
}

// ---------------------------------------------------------------------------
// payload encryption — random IV prepended to the ciphertext
// ---------------------------------------------------------------------------

/**
 * Encrypt bytes. Output layout: `IV (12 bytes) || AES-GCM ciphertext+tag`.
 *
 * Note: the random IV means identical plaintext encrypts to different bytes,
 * so re-encryptions of the same photo do not dedup. That is acceptable here
 * (dedup keys off the stored ciphertext's own hash within a party). Switch to
 * convergent encryption only if cross-encryption dedup becomes important.
 */
export async function encryptBytes(
  key: PartyKey,
  data: Uint8Array,
): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      data as BufferSource,
    ),
  );
  const out = new Uint8Array(iv.length + ciphertext.length);
  out.set(iv, 0);
  out.set(ciphertext, iv.length);
  return out;
}

/** Decrypt bytes produced by {@link encryptBytes}. */
export async function decryptBytes(
  key: PartyKey,
  blob: Uint8Array,
): Promise<Uint8Array> {
  const iv = blob.subarray(0, IV_BYTES) as Uint8Array<ArrayBuffer>;
  const ciphertext = blob.subarray(IV_BYTES);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext as BufferSource,
  );
  return new Uint8Array(plain);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Encrypt a string to a base64url blob (`IV || ciphertext`). */
export async function encryptString(
  key: PartyKey,
  text: string,
): Promise<string> {
  return toBase64Url(await encryptBytes(key, encoder.encode(text)));
}

/** Decrypt a base64url blob produced by {@link encryptString}. */
export async function decryptString(
  key: PartyKey,
  encoded: string,
): Promise<string> {
  return decoder.decode(await decryptBytes(key, fromBase64Url(encoded)));
}

// ---------------------------------------------------------------------------
// content addressing
// ---------------------------------------------------------------------------

/** SHA-256 of `bytes`, hex-encoded — a photo's content-addressed id. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return toHex(new Uint8Array(digest));
}
