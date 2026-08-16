/**
 * CreateAlbum — the landing page's "name it + create" control (clientEntry).
 *
 * The album name is not stored server-side; it rides in the shared URL as
 * `?name=…`, so handing out `/room/<id>?name=<album>` is all a host needs — the
 * name travels with the one URL, matching the product's "share one link" model.
 *
 * The button does a full navigation (`location.href`) rather than a frame swap:
 * entering a room is a hard page transition, which reliably replaces the shell
 * content (a frame-targeted link left the URL changed but the frame stale).
 */

import { clientEntry, type Handle, on } from "@remix-run/ui";
import {
  clearAll as opfsClearAll,
  getFile,
  isAvailable as opfsAvailable,
  listIds,
  remove as opfsRemove,
} from "./lib/opfs.ts";
import {
  clear as clearIndex,
  forgetRoom,
  isReferenced,
  listRooms,
} from "./lib/storage_index.ts";

const isClientEnv = typeof globalThis !== "undefined" &&
  typeof (globalThis as { document?: unknown }).document !== "undefined";

/** URL-friendly random room id (~16 base64url chars), minted in the browser. */
function newRoomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

export const CreateAlbum = clientEntry(
  "/home.js#CreateAlbum",
  function CreateAlbum(_handle: Handle<Record<string, never>>) {
    let name = "";

    const create = () => {
      const id = newRoomId();
      const trimmed = name.trim();
      const query = trimmed ? `?name=${encodeURIComponent(trimmed)}` : "";
      globalThis.location.href = `/room/${id}${query}`;
    };

    return () => (
      <div class="join w-full max-w-md">
        <input
          type="text"
          class="input input-bordered join-item flex-1"
          placeholder="アルバム名（任意）"
          maxlength={80}
          mix={[
            on<HTMLInputElement, "input">("input", (e) => {
              name = (e.currentTarget as HTMLInputElement).value;
            }),
            on<HTMLInputElement, "keydown">("keydown", (e) => {
              if ((e as KeyboardEvent).key === "Enter") create();
            }),
          ]}
        />
        <button
          type="button"
          class="btn btn-primary join-item"
          mix={[on("click", () => create())]}
        >
          アルバムを作成
        </button>
      </div>
    );
  },
);

interface RoomUsage {
  roomId: string;
  albumName: string;
  count: number;
  bytes: number;
}

/**
 * StorageManager — lists what "ブラウザ上で同期" has cached in OPFS on this
 * device, grouped by room (with album names), and lets the user clear a single
 * room or everything. Room ids need not be known: they come from the local
 * attribution index, and any body not attributed to a room shows in an "other"
 * bucket so it's still clearable.
 */
export const StorageManager = clientEntry(
  "/home.js#StorageManager",
  function StorageManager(handle: Handle<Record<string, never>>) {
    let loading = true;
    let supported = true;
    let busy = false;
    let totalBytes = 0;
    let rooms: RoomUsage[] = [];
    let other: { count: number; bytes: number; ids: string[] } = {
      count: 0,
      bytes: 0,
      ids: [],
    };

    const refresh = async () => {
      if (!opfsAvailable()) {
        supported = false;
        loading = false;
        handle.update();
        return;
      }
      loading = true;
      handle.update();

      const ids = await listIds();
      const sizes = new Map<string, number>();
      for (const id of ids) {
        const f = await getFile(id);
        if (f) sizes.set(id, f.size);
      }
      totalBytes = [...sizes.values()].reduce((a, b) => a + b, 0);

      const attributed = new Set<string>();
      rooms = listRooms()
        .map((r) => {
          let bytes = 0, count = 0;
          for (const id of r.ids) {
            if (sizes.has(id)) {
              bytes += sizes.get(id)!;
              count++;
              attributed.add(id);
            }
          }
          return { roomId: r.roomId, albumName: r.albumName, count, bytes };
        })
        .filter((r) => r.count > 0)
        .sort((a, b) => b.bytes - a.bytes);

      const otherIds = ids.filter((id) => !attributed.has(id));
      other = {
        count: otherIds.length,
        bytes: otherIds.reduce((a, id) => a + (sizes.get(id) ?? 0), 0),
        ids: otherIds,
      };
      loading = false;
      handle.update();
    };

    const roomLabel = (r: RoomUsage): string =>
      r.albumName || `ルーム ${r.roomId.slice(0, 8)}`;

    const clearRoom = async (r: RoomUsage) => {
      if (busy) return;
      if (
        !globalThis.confirm(`「${roomLabel(r)}」の保存データを削除しますか？`)
      ) {
        return;
      }
      busy = true;
      handle.update();
      const ids = forgetRoom(r.roomId);
      for (const id of ids) {
        if (!isReferenced(id)) await opfsRemove(id); // keep shared-with-other-room bodies
      }
      busy = false;
      await refresh();
    };

    const clearOther = async () => {
      if (busy || other.ids.length === 0) return;
      if (!globalThis.confirm("ルーム不明の保存データを削除しますか？")) return;
      busy = true;
      handle.update();
      for (const id of other.ids) {
        if (!isReferenced(id)) await opfsRemove(id);
      }
      busy = false;
      await refresh();
    };

    const clearEverything = async () => {
      if (busy) return;
      if (
        !globalThis.confirm("このブラウザの保存データをすべて削除しますか？")
      ) {
        return;
      }
      busy = true;
      handle.update();
      await opfsClearAll();
      clearIndex();
      busy = false;
      await refresh();
    };

    if (isClientEnv) queueMicrotask(() => void refresh());

    return () => {
      if (!supported) return null;
      return (
        <div class="card card-border bg-base-100">
          <div class="card-body">
            <div class="flex items-center justify-between gap-2">
              <h2 class="card-title">このブラウザの保存データ</h2>
              {!loading && (
                <span class="text-sm text-base-content/60">
                  {`合計 ${humanSize(totalBytes)}`}
                </span>
              )}
            </div>

            {loading
              ? <p class="text-sm text-base-content/60">読み込み中…</p>
              : totalBytes === 0
              ? (
                <p class="text-sm text-base-content/60">
                  保存データはありません。
                </p>
              )
              : (
                <div class="space-y-3">
                  <ul class="divide-y divide-base-200">
                    {rooms.map((r) => (
                      <li class="flex items-center justify-between gap-2 py-2">
                        <div class="min-w-0">
                          <a
                            class="link link-hover font-medium truncate block"
                            href={`/room/${r.roomId}${
                              r.albumName
                                ? `?name=${encodeURIComponent(r.albumName)}`
                                : ""
                            }`}
                          >
                            {roomLabel(r)}
                          </a>
                          <span class="text-xs text-base-content/50">
                            {`${r.count} 件 · ${humanSize(r.bytes)}`}
                          </span>
                        </div>
                        <button
                          type="button"
                          class="btn btn-xs btn-outline btn-error"
                          disabled={busy}
                          mix={[on("click", () => void clearRoom(r))]}
                        >
                          削除
                        </button>
                      </li>
                    ))}
                    {other.count > 0 && (
                      <li class="flex items-center justify-between gap-2 py-2">
                        <div class="min-w-0">
                          <span class="font-medium">その他（ルーム不明）</span>
                          <span class="block text-xs text-base-content/50">
                            {`${other.count} 件 · ${humanSize(other.bytes)}`}
                          </span>
                        </div>
                        <button
                          type="button"
                          class="btn btn-xs btn-outline btn-error"
                          disabled={busy}
                          mix={[on("click", () => void clearOther())]}
                        >
                          削除
                        </button>
                      </li>
                    )}
                  </ul>
                  <div class="card-actions justify-end">
                    <button
                      type="button"
                      class="btn btn-sm btn-error btn-outline"
                      disabled={busy}
                      mix={[on("click", () => void clearEverything())]}
                    >
                      {busy ? "処理中…" : "すべて削除"}
                    </button>
                  </div>
                </div>
              )}
          </div>
        </div>
      );
    };
  },
);
