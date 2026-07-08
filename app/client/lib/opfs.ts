/**
 * OPFS (Origin Private File System) storage for file bodies, keyed by content
 * id (SHA-256). Holds both the user's own uploads and files downloaded from
 * peers, so anything in here can be served to other peers and bulk-exported.
 *
 * All entrypoints feature-detect and degrade gracefully: if OPFS is
 * unavailable (older browser, some private modes), operations are skipped with
 * a warning rather than throwing — index sync does not depend on it.
 */

const DIR = "files";

/** Whether OPFS is usable in this browser context. */
export function isAvailable(): boolean {
  return typeof navigator !== "undefined" &&
    !!navigator.storage?.getDirectory;
}

async function filesDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return await root.getDirectoryHandle(DIR, { create: true });
}

/** Store a file body under its content id. Returns false if OPFS is off. */
export async function save(id: string, blob: Blob): Promise<boolean> {
  if (!isAvailable()) {
    console.warn("[opfs] unavailable — skipping save of", id);
    return false;
  }
  try {
    const dir = await filesDir();
    const handle = await dir.getFileHandle(id, { create: true });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return true;
  } catch (err) {
    console.warn("[opfs] save failed for", id, err);
    return false;
  }
}

/** Read a stored file body by id, or null if absent/unavailable. */
export async function getFile(id: string): Promise<File | null> {
  if (!isAvailable()) return null;
  try {
    const dir = await filesDir();
    const handle = await dir.getFileHandle(id, { create: false });
    return await handle.getFile();
  } catch {
    return null;
  }
}

/** Whether a file body with this id is already in OPFS. */
export async function has(id: string): Promise<boolean> {
  if (!isAvailable()) return false;
  try {
    const dir = await filesDir();
    await dir.getFileHandle(id, { create: false });
    return true;
  } catch {
    return false;
  }
}

/** All content ids currently stored in OPFS. */
export async function listIds(): Promise<string[]> {
  if (!isAvailable()) return [];
  const ids: string[] = [];
  try {
    const dir = await filesDir();
    // @ts-ignore - keys() exists on FileSystemDirectoryHandle at runtime
    for await (const name of dir.keys()) ids.push(name as string);
  } catch (err) {
    console.warn("[opfs] listIds failed", err);
  }
  return ids;
}
