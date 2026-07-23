/**
 * Local media handling: scanning the current directory for shareable files,
 * content-addressing them (SHA-256, matching the web client's `hash.ts`), and
 * the on-disk store of bodies the CLI can serve — both the files it shares from
 * cwd and the ones it downloads into `./shared` (which it then re-seeds).
 */

import { basename, extname, join } from "@std/path";
import { contentType } from "@std/media-types";

/** A body this peer holds and can stream to others. */
export interface OwnedFile {
  /** Content hash (SHA-256, hex) — the shared file id. */
  id: string;
  path: string;
  filename: string;
  mime: string;
  size: number;
}

/** Extensions we treat as shareable media. */
const MEDIA_EXTS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".avif",
  ".heic",
  ".heif",
  ".bmp",
  ".tiff",
  ".mp4",
  ".mov",
  ".webm",
  ".mkv",
  ".avi",
  ".m4v",
]);

/** Directory (relative to cwd) where downloaded bodies are written. */
export const SHARED_DIR = "shared";

/** Best-effort MIME for a filename; defaults to a generic binary type. */
export function mimeFor(filename: string): string {
  const ext = extname(filename);
  return contentType(ext) ?? "application/octet-stream";
}

function isMedia(filename: string): boolean {
  return MEDIA_EXTS.has(extname(filename).toLowerCase());
}

/** SHA-256 (lowercase hex) of a file's bytes. */
export async function hashFile(path: string): Promise<string> {
  // Read fully: `crypto.subtle.digest` needs a single buffer. Fine for the
  // photo/short-video sizes this tool targets.
  const bytes = await Deno.readFile(path);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Scan the top level of `dir` for media files and content-address them.
 * The `shared/` download directory is skipped (those bodies arrive already
 * indexed). Progress is reported per file since hashing large videos is slow.
 */
export async function scanMedia(
  dir: string,
  onProgress?: (filename: string) => void,
): Promise<OwnedFile[]> {
  const owned: OwnedFile[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.isFile) continue;
    if (!isMedia(entry.name)) continue;
    const path = join(dir, entry.name);
    onProgress?.(entry.name);
    const stat = await Deno.stat(path);
    owned.push({
      id: await hashFile(path),
      path,
      filename: entry.name,
      mime: mimeFor(entry.name),
      size: stat.size,
    });
  }
  return owned;
}

/**
 * Streaming writer for a downloaded body. Bytes land in a `.part` file which is
 * atomically renamed into `shared/` on commit, avoiding half-written files.
 */
export class DownloadWriter {
  #file: Deno.FsFile;
  #partPath: string;
  #finalPath: string;

  private constructor(file: Deno.FsFile, partPath: string, finalPath: string) {
    this.#file = file;
    this.#partPath = partPath;
    this.#finalPath = finalPath;
  }

  static async create(
    sharedDir: string,
    id: string,
    filename: string,
  ): Promise<DownloadWriter> {
    await Deno.mkdir(sharedDir, { recursive: true });
    const finalPath = await uniquePath(sharedDir, filename);
    const partPath = join(sharedDir, `.${id}.part`);
    const file = await Deno.open(partPath, {
      write: true,
      create: true,
      truncate: true,
    });
    return new DownloadWriter(file, partPath, finalPath);
  }

  async write(bytes: Uint8Array): Promise<void> {
    let off = 0;
    while (off < bytes.length) {
      off += await this.#file.write(bytes.subarray(off));
    }
  }

  /** Close and publish the file; returns its final path. */
  async commit(): Promise<string> {
    this.#file.close();
    await Deno.rename(this.#partPath, this.#finalPath);
    return this.#finalPath;
  }

  /** Close and discard a partial download. */
  async abort(): Promise<void> {
    try {
      this.#file.close();
    } catch { /* already closed */ }
    await Deno.remove(this.#partPath).catch(() => {});
  }
}

/** Pick `<dir>/<name>`, inserting ` (n)` before the extension on collision. */
async function uniquePath(dir: string, name: string): Promise<string> {
  const ext = extname(name);
  const stem = basename(name, ext);
  for (let n = 0;; n++) {
    const candidate = join(dir, n === 0 ? name : `${stem} (${n})${ext}`);
    if (!(await exists(candidate))) return candidate;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}
