/**
 * OPFS (Origin Private File System) storage for file bodies.
 *
 * Phase 1 only saves the uploader's OWN files here (proving the local store
 * works); Phase 2 will also write peer files fetched over WebRTC and add the
 * bulk export to an external directory.
 *
 * All entrypoints feature-detect and degrade gracefully: if OPFS is
 * unavailable (older browser, some private modes), saving is skipped with a
 * warning rather than throwing — index sync does not depend on it.
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

/** Store a file body under its content id. No-op if OPFS is unavailable. */
export async function saveOwnFile(id: string, blob: Blob): Promise<boolean> {
  if (!isAvailable()) {
    console.warn("[opfs] unavailable — skipping local save of", id);
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
