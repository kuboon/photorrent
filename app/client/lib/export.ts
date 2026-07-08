/**
 * Bulk export of downloaded/own bodies from OPFS to an external directory the
 * user picks (File System Access API). Files already present in the target
 * directory (by name) are skipped, so exporting is idempotent — you can plug in
 * a drive, dump everything, and only the new files are written.
 *
 * Requires a user gesture (the picker) and a Chromium-family browser; callers
 * should feature-detect with {@link isExportSupported} and hide the button
 * otherwise.
 */

import { getFile } from "./opfs.ts";

interface ExportItem {
  id: string;
  filename: string;
}

export interface ExportResult {
  written: number;
  skipped: number;
  failed: number;
}

// deno-lint-ignore no-explicit-any
type DirPicker = (opts?: unknown) => Promise<any>;

export function isExportSupported(): boolean {
  return typeof globalThis !== "undefined" &&
    typeof (globalThis as { showDirectoryPicker?: unknown })
        .showDirectoryPicker === "function";
}

/**
 * Prompt for a directory and write every item whose body is in OPFS and whose
 * filename isn't already in the directory. Returns counts. Throws only if the
 * user cancels the picker (AbortError) — callers can treat that as a no-op.
 */
export async function exportAll(items: ExportItem[]): Promise<ExportResult> {
  const picker = (globalThis as { showDirectoryPicker?: DirPicker })
    .showDirectoryPicker;
  if (!picker) throw new Error("directory export not supported");

  const dir = await picker({ mode: "readwrite" });

  // Names already in the target directory — skip these.
  const existing = new Set<string>();
  for await (const name of dir.keys()) existing.add(name as string);

  let written = 0, skipped = 0, failed = 0;
  for (const item of items) {
    if (existing.has(item.filename)) {
      skipped++;
      continue;
    }
    const file = await getFile(item.id);
    if (!file) {
      skipped++; // body not held locally
      continue;
    }
    try {
      const handle = await dir.getFileHandle(item.filename, { create: true });
      const writable = await handle.createWritable();
      await writable.write(file);
      await writable.close();
      written++;
    } catch (err) {
      console.warn("[export] failed to write", item.filename, err);
      failed++;
    }
  }
  return { written, skipped, failed };
}
