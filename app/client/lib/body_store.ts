/**
 * Body storage abstraction behind the two sync modes.
 *
 * - {@link OpfsStore} ("ブラウザ上で同期"): bodies live in OPFS, keyed by content
 *   id. Works in every browser; downloads are saved/exported via the gallery.
 * - {@link FolderStore} ("フォルダを同期"): bodies live in a real directory the
 *   user picks (File System Access API, Chromium only). Existing media in the
 *   folder are shared, and downloaded bodies are written back into it — the same
 *   read+write model as the CLI (cwd = share source, downloads re-seeded).
 *
 * The transfer manager and gallery talk only to this interface, so they don't
 * care which backend is active.
 */

import { contentHash } from "./hash.ts";
import * as opfs from "./opfs.ts";

/** A body the local peer holds, resolved for serving or download. */
export interface HeldFile {
  id: string;
  name: string;
  size: number;
  mime: string;
}

export interface BodyStore {
  readonly kind: "opfs" | "folder";
  /** Content ids currently held. */
  listIds(): Promise<string[]>;
  has(id: string): Promise<boolean>;
  /** Body for serving/download, or null if not held. */
  get(id: string): Promise<File | Blob | null>;
  /** Persist a body. `filename` is used by the folder backend (OPFS keys by id). */
  save(id: string, blob: Blob, filename: string): Promise<boolean>;
}

/** OPFS-backed store — the default, works in every browser. */
export class OpfsStore implements BodyStore {
  readonly kind = "opfs";
  listIds(): Promise<string[]> {
    return opfs.listIds();
  }
  has(id: string): Promise<boolean> {
    return opfs.has(id);
  }
  get(id: string): Promise<File | null> {
    return opfs.getFile(id);
  }
  save(id: string, blob: Blob, _filename: string): Promise<boolean> {
    return opfs.save(id, blob);
  }
}

// --- Folder (File System Access API) backend ------------------------------

/** Media extensions the folder scan treats as shareable (mirrors the CLI). */
const MEDIA_EXTS = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "avif",
  "heic",
  "heif",
  "bmp",
  "tiff",
  "mp4",
  "mov",
  "webm",
  "mkv",
  "avi",
  "m4v",
]);

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  heic: "image/heic",
  heif: "image/heif",
  bmp: "image/bmp",
  tiff: "image/tiff",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  m4v: "video/x-m4v",
};

function ext(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

function isMedia(name: string): boolean {
  return MEDIA_EXTS.has(ext(name));
}

/** Best-effort MIME from extension for folder files. */
function mimeFor(name: string): string {
  return MIME_BY_EXT[ext(name)] ?? "application/octet-stream";
}

/** Whether this browser can pick a directory (Chromium family). */
export function isFolderSyncSupported(): boolean {
  return typeof globalThis !== "undefined" &&
    typeof (globalThis as { showDirectoryPicker?: unknown })
        .showDirectoryPicker === "function";
}

/** Minimal shapes of the File System Access API we use. */
interface FsFileHandle {
  kind: "file";
  getFile(): Promise<File>;
  createWritable(): Promise<{
    write(data: Blob | BufferSource): Promise<void>;
    close(): Promise<void>;
  }>;
}
interface FsDirHandle {
  entries(): AsyncIterableIterator<[string, { kind: string }]>;
  keys(): AsyncIterableIterator<string>;
  getFileHandle(
    name: string,
    opts?: { create?: boolean },
  ): Promise<FsFileHandle>;
}

/** Prompt for a directory with read+write access, or null if cancelled. */
export async function pickDirectory(): Promise<FsDirHandle | null> {
  const picker = (globalThis as {
    showDirectoryPicker?: (opts?: unknown) => Promise<FsDirHandle>;
  }).showDirectoryPicker;
  if (!picker) return null;
  try {
    return await picker({ mode: "readwrite" });
  } catch {
    return null; // user cancelled
  }
}

/**
 * A directory-backed store. Build with {@link FolderStore.open}, which scans and
 * content-addresses the folder's existing media so they can be shared.
 */
export class FolderStore implements BodyStore {
  readonly kind = "folder";
  #dir: FsDirHandle;
  #byId = new Map<string, string>(); // content id → filename in the directory

  private constructor(dir: FsDirHandle) {
    this.#dir = dir;
  }

  /**
   * Open a store over `dir`, scanning existing media. Returns the store and the
   * list of already-held files (for the caller to publish/share).
   */
  static async open(
    dir: FsDirHandle,
    onProgress?: (name: string) => void,
  ): Promise<{ store: FolderStore; held: HeldFile[] }> {
    const store = new FolderStore(dir);
    const held: HeldFile[] = [];
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind !== "file" || !isMedia(name)) continue;
      onProgress?.(name);
      const fh = await dir.getFileHandle(name);
      const file = await fh.getFile();
      const id = await contentHash(file);
      store.#byId.set(id, name);
      held.push({
        id,
        name,
        size: file.size,
        mime: file.type || mimeFor(name),
      });
    }
    return { store, held };
  }

  listIds(): Promise<string[]> {
    return Promise.resolve([...this.#byId.keys()]);
  }
  has(id: string): Promise<boolean> {
    return Promise.resolve(this.#byId.has(id));
  }
  async get(id: string): Promise<File | null> {
    const name = this.#byId.get(id);
    if (!name) return null;
    try {
      const fh = await this.#dir.getFileHandle(name);
      return await fh.getFile();
    } catch {
      return null;
    }
  }
  async save(id: string, blob: Blob, filename: string): Promise<boolean> {
    if (this.#byId.has(id)) return true; // already on disk
    try {
      const name = await this.#uniqueName(filename);
      const fh = await this.#dir.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(blob);
      await w.close();
      this.#byId.set(id, name);
      return true;
    } catch {
      return false;
    }
  }

  /** A filename not already present in the directory (append " (n)"). */
  async #uniqueName(name: string): Promise<string> {
    const existing = new Set<string>();
    for await (const key of this.#dir.keys()) existing.add(key);
    if (!existing.has(name)) return name;
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const dotExt = dot > 0 ? name.slice(dot) : "";
    for (let n = 1;; n++) {
      const candidate = `${stem} (${n})${dotExt}`;
      if (!existing.has(candidate)) return candidate;
    }
  }
}
