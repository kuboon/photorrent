/**
 * RoomPage — the single interactive `clientEntry` for a room.
 *
 * Server renders an empty gallery + dropzone skeleton (roomId injected as a
 * prop); the client hydrates, opens the room WebSocket, and fills the gallery
 * live.
 *
 * Phase 1: upload → content hash → thumbnail → save own body to OPFS → POST
 * thumbnail → WS `add`; live index sync across guests.
 *
 * Phase 2: file BODIES move peer-to-peer. Seeing a wanted file it lacks, a
 * guest fetches it from a holder over a WebRTC data channel (falling back to
 * the server byte-relay), saves it to the active {@link BodyStore}, and
 * announces `have` so it can serve it onward.
 *
 * Two sync modes back the store: "ブラウザ上で同期" (OPFS + per-file/zip
 * download) and "フォルダを同期" (a real directory via File System Access —
 * existing media shared, downloads written back, Chromium only).
 *
 * Setup runs on both server and client; browser-only work is gated on
 * `isClientEnv`.
 */

import {
  clientEntry,
  type Handle,
  on,
  type SerializableValue,
} from "@remix-run/ui";

import type { FileMeta, ServerMsg } from "../server/lib/protocol.ts";
import type { RtcSignalData } from "./lib/peer.ts";
import { contentHash } from "./lib/hash.ts";
import { generateThumbnail } from "./lib/thumbnail.ts";
import { isAvailable as opfsAvailable } from "./lib/opfs.ts";
import {
  type BodyStore,
  FolderStore,
  isFolderSyncSupported,
  OpfsStore,
  pickDirectory,
} from "./lib/body_store.ts";
import { type ConnStatus, WsClient } from "./lib/ws_client.ts";
import { type FileState, TransferManager } from "./lib/transfer.ts";
import { makeZip } from "./lib/zip.ts";

/** Sync mode: OPFS (browser storage) or a real folder (File System Access). */
type SyncMode = "opfs" | "folder";

/** Classic (non-ZIP64) zip caps sizes/offsets at 32 bits; stay under 4 GB.
 * Below 4 GiB with margin, so the bulk-download zip never needs ZIP64. */
const MAX_ZIP_BYTES = 4_000_000_000;

/** Trigger a browser "save as" for a Blob via a transient object URL. */
function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after the download has surely started.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export interface RoomPageProps {
  roomId: string;
  /** Album title from the shared URL's `?name=` (may be empty). */
  albumName?: string;
  [key: string]: SerializableValue;
}

/** localStorage key for the participant's display name (shared across rooms). */
const NAME_KEY = "photorrent:name";
/** localStorage key for the chosen sync mode (shared across rooms). */
const MODE_KEY = "photorrent:mode";

const isClientEnv = typeof globalThis !== "undefined" &&
  typeof (globalThis as { document?: unknown }).document !== "undefined";

const FILE_INPUT_ID = "photorrent-file-input";

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

export const RoomPage = clientEntry(
  "/room_page.js#RoomPage",
  function RoomPage(handle: Handle<RoomPageProps>) {
    const roomId = handle.props.roomId;
    const albumName = (handle.props.albumName ?? "").trim();

    const files = new Map<string, FileMeta>();
    const holders = new Map<string, Set<string>>();
    const held = new Set<string>(); // file ids whose body I hold locally
    const dlState = new Map<string, FileState>(); // downloading | error (transient)
    const selected = new Set<string>(); // file ids checked for download
    let peers: string[] = [];
    let status: ConnStatus = "connecting";
    let uploading = 0;
    let opfsOk = true;
    let zipMsg: string | null = null;
    let zipping = false;

    let mode: SyncMode = "opfs";
    let store: BodyStore | null = null;
    let folderName: string | null = null; // picked directory name (folder mode)
    let folderMsg: string | null = null; // scan / status message (folder mode)

    let peerId = "";
    let myName = "";
    let ws: WsClient | null = null;
    let transfer: TransferManager | null = null;

    // Pick an online holder (other than me) for a file, or null.
    const pickHolder = (id: string): string | null => {
      const set = holders.get(id);
      if (!set) return null;
      for (const h of set) {
        if (h !== peerId && peers.includes(h)) return h;
      }
      return null;
    };

    // Fetch a wanted, not-yet-held file from a holder if one is available.
    // No-op until a store is ready (folder mode: after the user picks a folder).
    const maybeDownload = (id: string) => {
      if (!transfer || !store) return;
      const file = files.get(id);
      if (!file) return;
      if (file.uploader === peerId || held.has(id)) return;
      if (transfer.isDownloading(id)) return;
      const holder = pickHolder(id);
      if (holder) transfer.download(id, file.mime, file.filename, holder);
    };

    const retryDownloads = () => {
      for (const id of files.keys()) maybeDownload(id);
    };

    // Mark which known files we already hold locally (from the active store).
    const syncHeldFromStore = async () => {
      if (!store) return;
      for (const id of await store.listIds()) {
        if (files.has(id)) held.add(id);
      }
      handle.update();
      retryDownloads();
    };

    const onServerMsg = (msg: ServerMsg) => {
      switch (msg.t) {
        case "snapshot":
          files.clear();
          for (const f of msg.files) files.set(f.id, f);
          holders.clear();
          for (const [id, ps] of Object.entries(msg.holders)) {
            holders.set(id, new Set(ps));
          }
          peers = msg.peers;
          void syncHeldFromStore();
          break;
        case "added":
          files.set(msg.file.id, msg.file);
          maybeDownload(msg.file.id);
          break;
        case "removed":
          files.delete(msg.id);
          holders.delete(msg.id);
          break;
        case "presence":
          peers = msg.peers;
          retryDownloads();
          break;
        case "holders":
          holders.set(msg.id, new Set(msg.peers));
          maybeDownload(msg.id);
          break;
        case "signal":
          transfer?.onSignal(msg.from, msg.data as RtcSignalData);
          return; // no re-render
        case "relay":
          transfer?.onRelay(
            msg.from,
            msg.data as { tid?: string; j?: unknown; b?: string },
          );
          return; // no re-render
        case "error":
          console.warn("[room] server error:", msg.message);
          return;
      }
      handle.update();
    };

    const wsUrl = () => {
      const scheme = location.protocol === "https:" ? "wss:" : "ws:";
      return `${scheme}//${location.host}/ws/${roomId}`;
    };

    if (isClientEnv) {
      peerId = crypto.randomUUID();
      myName = localStorage.getItem(NAME_KEY) ?? "";
      mode = localStorage.getItem(MODE_KEY) === "folder" ? "folder" : "opfs";
      opfsOk = opfsAvailable();
      // OPFS store is ready immediately; the folder store waits for a pick.
      if (mode === "opfs") store = new OpfsStore();
      // Defer opening the socket until after the first render: the WsClient
      // reports status synchronously, and calling handle.update() during the
      // setup phase (before the initial render) is not allowed.
      queueMicrotask(() => {
        ws = new WsClient(wsUrl(), peerId, onServerMsg, (s) => {
          status = s;
          handle.update();
        });
        transfer = new TransferManager(
          {
            myPeerId: peerId,
            signal: (to, data) => ws?.send({ t: "signal", to, data }),
            relay: (to, data) => ws?.send({ t: "relay", to, data }),
            announceHave: (id) => ws?.send({ t: "have", id }),
          },
          (fileId, state) => {
            if (state === "have") {
              held.add(fileId);
              dlState.delete(fileId);
            } else {
              dlState.set(fileId, state);
            }
            handle.update();
          },
        );
        if (store) transfer.setStore(store);
      });
    }

    const processFile = async (file: File) => {
      const id = await contentHash(file);
      if (files.has(id)) return; // dedup by content hash
      uploading++;
      handle.update();
      try {
        const thumb = await generateThumbnail(file);
        // Persist our own body locally to serve to peers (OPFS, or written into
        // the picked folder in folder mode).
        await store?.save(id, file, file.name);
        held.add(id);

        const thumbUrl = `/api/room/${roomId}/thumb?id=${id}`;
        const res = await fetch(thumbUrl, {
          method: "POST",
          headers: { "content-type": thumb.blob.type || "image/jpeg" },
          body: thumb.blob,
        });
        if (!res.ok) throw new Error(`thumb upload failed: ${res.status}`);

        const meta: FileMeta = {
          id,
          filename: file.name,
          size: file.size,
          mime: file.type || "application/octet-stream",
          width: thumb.width,
          height: thumb.height,
          thumbUrl,
          uploader: peerId,
          ...(myName.trim() ? { uploaderName: myName.trim() } : {}),
          createdAt: Date.now(),
        };
        files.set(id, meta);
        ws?.send({ t: "add", file: meta });
      } catch (err) {
        console.error("[room] upload failed for", file.name, err);
      } finally {
        uploading--;
        handle.update();
      }
    };

    const handleFiles = (list: FileList | null | undefined) => {
      if (!list) return;
      for (const file of Array.from(list)) void processFile(file);
    };

    // Selection for download. Only held (downloaded) files can be selected.
    const onToggleSelect = (id: string) => {
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      handle.update();
    };

    // Running totals for the selection toolbar.
    const selectedStats = (): { count: number; bytes: number } => {
      let count = 0, bytes = 0;
      for (const f of files.values()) {
        if (selected.has(f.id) && held.has(f.id)) {
          count++;
          bytes += f.size;
        }
      }
      return { count, bytes };
    };

    // Save one already-downloaded file to the device.
    const onDownloadOne = async (f: FileMeta) => {
      const file = await store?.get(f.id);
      if (file) saveBlob(file, f.filename);
    };

    // Bundle the selected (held) files into a zip and save it.
    const onDownloadZip = async () => {
      const items = [...files.values()]
        .filter((f) => selected.has(f.id) && held.has(f.id));
      if (items.length === 0) return;
      zipping = true;
      zipMsg = "ZIP を作成中…";
      handle.update();
      try {
        const entries: { name: string; blob: Blob }[] = [];
        for (const f of items) {
          const file = await store?.get(f.id);
          if (file) entries.push({ name: f.filename, blob: file });
        }
        const zip = await makeZip(entries);
        saveBlob(zip, `${albumName || "photorrent"}.zip`);
        zipMsg = null;
      } catch (err) {
        console.error("[room] zip failed", err);
        zipMsg = "ZIP の作成に失敗しました";
      } finally {
        zipping = false;
        handle.update();
      }
    };

    // Switch sync mode. Re-initializing mid-session is fiddly (two live stores),
    // so persist the choice and reload into a clean state.
    const onSetMode = (m: SyncMode) => {
      if (m === mode) return;
      try {
        localStorage.setItem(MODE_KEY, m);
      } catch {
        /* private mode — won't persist, but the reload still applies */
      }
      location.reload();
    };

    // Publish a body we already hold (folder mode: existing folder files) to the
    // index — upload a thumbnail + `add` if new, else just announce `have`.
    const publishHeld = async (id: string, file: File): Promise<void> => {
      held.add(id);
      if (files.has(id)) {
        ws?.send({ t: "have", id });
        handle.update();
        return;
      }
      try {
        const thumb = await generateThumbnail(file);
        const thumbUrl = `/api/room/${roomId}/thumb?id=${id}`;
        const res = await fetch(thumbUrl, {
          method: "POST",
          headers: { "content-type": thumb.blob.type || "image/jpeg" },
          body: thumb.blob,
        });
        if (!res.ok) throw new Error(`thumb upload failed: ${res.status}`);
        const meta: FileMeta = {
          id,
          filename: file.name,
          size: file.size,
          mime: file.type || "application/octet-stream",
          width: thumb.width,
          height: thumb.height,
          thumbUrl,
          uploader: peerId,
          ...(myName.trim() ? { uploaderName: myName.trim() } : {}),
          createdAt: Date.now(),
        };
        files.set(id, meta);
        ws?.send({ t: "add", file: meta });
      } catch (err) {
        console.error("[room] publish failed for", file.name, err);
      }
      handle.update();
    };

    // Folder mode: pick a directory, share its existing media, and route
    // downloads back into it (read+write, like the CLI).
    const onPickFolder = async () => {
      const dir = await pickDirectory();
      if (!dir) return;
      folderMsg = "フォルダを読み込み中…";
      handle.update();
      const { store: fs, held: existing } = await FolderStore.open(
        dir,
        (n) => {
          folderMsg = `読み込み中: ${n}`;
          handle.update();
        },
      );
      store = fs;
      folderName = (dir as unknown as { name?: string }).name ?? "フォルダ";
      transfer?.setStore(fs);
      folderMsg = `${existing.length} 件を共有します…`;
      handle.update();
      for (const hf of existing) {
        const f = await fs.get(hf.id);
        if (f instanceof File) await publishHeld(hf.id, f);
      }
      folderMsg = null;
      handle.update();
      retryDownloads();
    };

    // Persist the participant's display name. The input's `value` prop makes
    // it a controlled field, and the framework restores the DOM value to that
    // prop after every native `input` event — so we must re-render on every
    // keystroke to keep the controlled value current, or typing gets wiped.
    const onNameInput = (value: string) => {
      myName = value;
      try {
        localStorage.setItem(NAME_KEY, value);
      } catch {
        // Private mode / storage disabled — name just won't persist.
      }
      handle.update();
    };

    // Who uploaded a file, for display under its thumbnail.
    const uploaderLabel = (f: FileMeta): string =>
      f.uploader === peerId ? "自分" : (f.uploaderName?.trim() || "匿名");

    // Per-file UI state (badge + dim). Returns null when there's no badge.
    const fileBadge = (
      f: FileMeta,
    ): { label: string; cls: string; spin?: boolean } | null => {
      if (f.uploader === peerId) return { label: "自分", cls: "badge-ghost" };
      if (held.has(f.id)) return { label: "同期済み", cls: "badge-success" };
      const s = dlState.get(f.id);
      if (s === "downloading") {
        return { label: "受信中", cls: "badge-info", spin: true };
      }
      if (s === "error") return { label: "失敗", cls: "badge-error" };
      return { label: "未取得", cls: "badge-ghost badge-outline" };
    };

    return () => {
      const list = [...files.values()].sort((a, b) =>
        a.createdAt - b.createdAt
      );
      const sel = selectedStats();
      const overLimit = sel.bytes > MAX_ZIP_BYTES;
      const folderSupported = isFolderSyncSupported();
      // In folder mode, the app is usable only once a folder is chosen.
      const folderReady = mode === "folder" && store !== null;
      const canUpload = mode === "opfs" || folderReady;
      const statusLabel = status === "open"
        ? `接続中 · 参加者 ${peers.length}人`
        : status === "connecting"
        ? "接続しています…"
        : "切断されました";
      const statusBadge = status === "open"
        ? "badge-success"
        : status === "connecting"
        ? "badge-warning"
        : "badge-error";

      return (
        <main class="mx-auto w-full max-w-5xl p-4 sm:p-8 space-y-6">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 class="text-2xl font-bold">
                📸 {albumName || "アルバム"}
              </h1>
              <p class="text-sm text-base-content/60">
                この URL を参加者に配ってください。
              </p>
            </div>
            <div class="flex items-center gap-2">
              <label class="input input-sm input-bordered flex items-center gap-1">
                <span class="text-base-content/50">👤</span>
                <input
                  type="text"
                  class="grow"
                  placeholder="あなたの名前"
                  maxlength={40}
                  value={myName}
                  mix={[
                    on<HTMLInputElement, "input">("input", (e) => {
                      onNameInput((e.currentTarget as HTMLInputElement).value);
                    }),
                  ]}
                />
              </label>
              <span class={`badge ${statusBadge} badge-sm`}>{statusLabel}</span>
              {mode === "opfs" && !opfsOk && (
                <span class="badge badge-outline badge-warning badge-sm">
                  OPFS 非対応
                </span>
              )}
            </div>
          </div>

          <div class="tabs tabs-boxed w-fit">
            <button
              type="button"
              class={`tab ${mode === "opfs" ? "tab-active" : ""}`}
              mix={[on("click", () => onSetMode("opfs"))]}
            >
              ブラウザ上で同期
            </button>
            <button
              type="button"
              class={`tab ${mode === "folder" ? "tab-active" : ""}`}
              mix={[on("click", () => onSetMode("folder"))]}
            >
              フォルダを同期
            </button>
          </div>

          {mode === "folder" && (
            <div class="rounded-box border border-base-300 bg-base-100 p-3 space-y-2">
              {!folderSupported
                ? (
                  <p class="text-sm text-base-content/70">
                    このブラウザはフォルダ同期に非対応です（Chrome / Edge などの
                    Chromium 系で利用できます）。他のブラウザでは
                    「ブラウザ上で同期」をお使いください。
                  </p>
                )
                : store === null
                ? (
                  <div class="flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      class="btn btn-sm btn-primary"
                      mix={[on("click", () => void onPickFolder())]}
                    >
                      📁 フォルダを選択
                    </button>
                    <span class="text-sm text-base-content/60">
                      選んだフォルダ内のメディアを共有し、受信したファイルも
                      そのフォルダに保存します。
                    </span>
                  </div>
                )
                : (
                  <p class="text-sm">
                    <span class="font-medium">📁 {folderName}</span>
                    <span class="text-base-content/60">
                      {" 同期中 — 受信したファイルはこのフォルダに保存されます"}
                    </span>
                  </p>
                )}
              {folderMsg && (
                <p class="text-sm text-base-content/60">{folderMsg}</p>
              )}
            </div>
          )}

          {zipMsg && (
            <div role="alert" class="alert alert-info alert-soft py-2">
              <span class="text-sm">{zipMsg}</span>
            </div>
          )}

          {canUpload && (
            <label
              for={FILE_INPUT_ID}
              class="flex flex-col items-center justify-center gap-2 rounded-box border-2 border-dashed border-base-300 bg-base-200/40 p-8 text-center cursor-pointer hover:border-primary transition-colors"
              mix={[
                on<HTMLElement, "dragover">(
                  "dragover",
                  (e) => e.preventDefault(),
                ),
                on<HTMLElement, "drop">("drop", (e) => {
                  e.preventDefault();
                  handleFiles(e.dataTransfer?.files);
                }),
              ]}
            >
              <span class="text-4xl">⬆️</span>
              <span class="font-medium">
                写真・動画をドロップ、またはクリックして選択
              </span>
              <span class="text-sm text-base-content/50">
                アップしたものは参加者全員に共有されます
              </span>
              {uploading > 0 && (
                <span class="badge badge-primary badge-sm gap-1">
                  <span class="loading loading-spinner loading-xs"></span>
                  アップロード中 {uploading}
                </span>
              )}
            </label>
          )}
          <input
            id={FILE_INPUT_ID}
            type="file"
            accept="image/*,video/*"
            multiple
            class="hidden"
            mix={[
              on<HTMLInputElement, "change">("change", (e) => {
                const input = e.currentTarget as HTMLInputElement;
                handleFiles(input.files);
                input.value = "";
              }),
            ]}
          />

          {mode === "opfs" && (
            <div class="flex flex-wrap items-center justify-between gap-3 rounded-box border border-base-300 bg-base-100 p-3">
              <div class="text-sm">
                <span class="font-medium">{`選択 ${sel.count} 件`}</span>
                <span class="text-base-content/60">
                  {` · 合計 ${humanSize(sel.bytes)}`}
                </span>
                {overLimit && (
                  <span class="text-error">
                    {` · 4GB を超えると一括ダウンロードできません`}
                  </span>
                )}
              </div>
              <button
                type="button"
                class="btn btn-sm btn-primary"
                disabled={sel.count === 0 || overLimit || zipping}
                mix={[on("click", () => void onDownloadZip())]}
              >
                {zipping
                  ? (
                    <>
                      <span class="loading loading-spinner loading-xs"></span>
                      作成中…
                    </>
                  )
                  : `⬇️ まとめてダウンロード (${sel.count})`}
              </button>
            </div>
          )}

          {list.length === 0
            ? (
              <div class="text-center text-base-content/50 py-12">
                まだ写真がありません。最初の1枚をアップしてみましょう。
              </div>
            )
            : (
              <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                {list.map((f) => {
                  const badge = fileBadge(f);
                  const isHeld = held.has(f.id);
                  const isSelected = selected.has(f.id);
                  return (
                    <div class="card card-compact bg-base-100 border border-base-300 overflow-hidden">
                      <figure class="relative aspect-square bg-base-200">
                        <img
                          src={f.thumbUrl}
                          alt={f.filename}
                          loading="lazy"
                          class="h-full w-full object-cover"
                        />
                        {mode === "opfs" && isHeld && (
                          <input
                            type="checkbox"
                            class="checkbox checkbox-sm absolute top-2 left-2 bg-base-100"
                            checked={isSelected}
                            aria-label="選択"
                            mix={[
                              on<HTMLInputElement, "change">(
                                "change",
                                () => onToggleSelect(f.id),
                              ),
                            ]}
                          />
                        )}
                      </figure>
                      <div class="card-body gap-1">
                        <div
                          class="text-xs font-medium truncate"
                          title={f.filename}
                        >
                          {f.filename}
                        </div>
                        <div
                          class="text-xs text-base-content/50 truncate"
                          title={uploaderLabel(f)}
                        >
                          👤 {uploaderLabel(f)}
                        </div>
                        <div class="flex items-center justify-between text-xs text-base-content/60">
                          <span>{humanSize(f.size)}</span>
                          {badge && (
                            <span class={`badge ${badge.cls} badge-xs gap-1`}>
                              {badge.spin && (
                                <span class="loading loading-spinner loading-xs">
                                </span>
                              )}
                              {badge.label}
                            </span>
                          )}
                        </div>
                        {mode === "opfs" && isHeld && (
                          <button
                            type="button"
                            class="btn btn-xs btn-outline"
                            mix={[on("click", () => void onDownloadOne(f))]}
                          >
                            ⬇️ 保存
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
        </main>
      );
    };
  },
);
