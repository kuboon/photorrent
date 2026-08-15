/**
 * Local room→content-id attribution for OPFS-stored bodies.
 *
 * OPFS is content-addressed and shared across all rooms (a file downloaded in
 * two rooms is stored once), so the bodies themselves carry no room label. To
 * offer per-room storage management ("show what this browser holds for each
 * room, clear one room"), we keep a small localStorage index mapping each room
 * to the ids it contributed, plus its album name for display.
 *
 * The index is best-effort metadata, not the source of truth: actual bytes are
 * always read from OPFS, and ids present in OPFS but not in any room are shown
 * as an "other" bucket, so nothing becomes unclearable if the index drifts.
 */

const KEY = "photorrent:storage";

interface RoomRecord {
  albumName: string;
  ids: string[];
}
type Index = Record<string, RoomRecord>; // roomId → record

function load(): Index {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Index) : {};
  } catch {
    return {};
  }
}

function save(ix: Index): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(ix));
  } catch { /* private mode / full — attribution just won't persist */ }
}

/** Note that `id` is held for `roomId` (idempotent); records the album name. */
export function recordHeld(
  roomId: string,
  albumName: string,
  id: string,
): void {
  const ix = load();
  const rec = ix[roomId] ?? { albumName: "", ids: [] };
  if (albumName) rec.albumName = albumName;
  if (!rec.ids.includes(id)) rec.ids.push(id);
  ix[roomId] = rec;
  save(ix);
}

export interface RoomEntry {
  roomId: string;
  albumName: string;
  ids: string[];
}

/** All rooms known to the index, with their attributed ids. */
export function listRooms(): RoomEntry[] {
  const ix = load();
  return Object.entries(ix).map(([roomId, rec]) => ({
    roomId,
    albumName: rec.albumName,
    ids: rec.ids,
  }));
}

/** Drop a room from the index and return the ids it had attributed. */
export function forgetRoom(roomId: string): string[] {
  const ix = load();
  const ids = ix[roomId]?.ids ?? [];
  delete ix[roomId];
  save(ix);
  return ids;
}

/** Whether any room still references `id` (for safe cross-room deletion). */
export function isReferenced(id: string): boolean {
  const ix = load();
  return Object.values(ix).some((rec) => rec.ids.includes(id));
}

/** Forget the entire index (used alongside an OPFS clear-all). */
export function clear(): void {
  try {
    localStorage.removeItem(KEY);
  } catch { /* ignore */ }
}
