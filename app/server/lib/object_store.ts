/**
 * Blob storage for thumbnail bytes, abstracted so the same code runs against a
 * local directory in Deno dev/test and Cloudflare R2 in production.
 *
 * On Cloudflare Workers the R2 bucket arrives as a binding on the Worker's
 * `env`, which isn't reachable under `deno serve`; the Worker entry (landing
 * with the Durable Object port) calls {@link setThumbBucket} at startup to
 * switch this over. Until then the local backend is used everywhere, so dev and
 * the E2E tests exercise the full thumbnail put/get path.
 */

/** Bytes-only store keyed by an opaque string. */
export interface ObjectStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
}

/** Minimal subset of Cloudflare's `R2Bucket` this app uses. */
export interface R2BucketLike {
  put(key: string, value: ArrayBuffer | Uint8Array): Promise<unknown>;
  get(
    key: string,
  ): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
}

const safeKey = (key: string): string => key.replace(/[^A-Za-z0-9_-]/g, "_");

/** Local-filesystem store for dev/test (one flat file per key). */
export class LocalObjectStore implements ObjectStore {
  constructor(private dir: string) {}

  private path(key: string): string {
    return `${this.dir}/${safeKey(key)}`;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    await Deno.mkdir(this.dir, { recursive: true });
    await Deno.writeFile(this.path(key), bytes);
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return await Deno.readFile(this.path(key));
    } catch {
      return null;
    }
  }
}

/** Cloudflare R2-backed store (production). */
export class R2ObjectStore implements ObjectStore {
  constructor(private bucket: R2BucketLike) {}

  async put(key: string, bytes: Uint8Array): Promise<void> {
    await this.bucket.put(key, bytes);
  }

  async get(key: string): Promise<Uint8Array | null> {
    const obj = await this.bucket.get(key);
    if (!obj) return null;
    return new Uint8Array(await obj.arrayBuffer());
  }
}

let bucket: R2BucketLike | null = null;

/** Register the R2 bucket binding (called by the CF Worker entry). */
export function setThumbBucket(b: R2BucketLike): void {
  bucket = b;
}

let defaultStore: ObjectStore | null = null;

/** The process-wide thumbnail store: R2 if a bucket was registered, else a
 * local directory (`THUMB_DIR`, default `./.data/thumbs`). */
export function defaultObjectStore(): ObjectStore {
  if (!defaultStore) {
    defaultStore = bucket
      ? new R2ObjectStore(bucket)
      : new LocalObjectStore(Deno.env.get("THUMB_DIR") ?? "./.data/thumbs");
  }
  return defaultStore;
}
