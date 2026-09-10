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
import { recordHeld } from "./lib/storage_index.ts";

/** Sync mode: OPFS (browser storage) or a real folder (File System Access). */
type SyncMode = "opfs" | "folder";

/** Classic (non-ZIP64) zip caps sizes/offsets at 32 bits; stay under 4 GB.
 * Below 4 GiB with margin, so the bulk-download zip never needs ZIP64. */
const MAX_ZIP_BYTES = 4_000_000_000;

/** Files larger than this are not auto-downloaded; the user fetches them by
 * hand (a "取得" button), to avoid pulling big files onto phones unbidden. */
const MAX_AUTO_BYTES = 10 * 1024 * 1024;

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
    const progress = new Map<string, number>(); // fileId → download percent (0-100)
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

    // Mark a body as locally held, and (OPFS mode only) attribute it to this
    // room so the home-page storage manager can list/clear it per room.
    const noteHeld = (id: string) => {
      held.add(id);
      if (mode === "opfs") recordHeld(roomId, albumName, id);
    };

    // Pick an online holder (other than me) for a file, or null.
    const pickHolder = (id: string): string | null => {
      const set = holders.get(id);
      if (!set) return null;
      for (const h of set) {
        if (h !== peerId && peers.includes(h)) return h;
      }
      return null;
    };

    // Start a download from a holder if one is available. No-op until a store
    // is ready (folder mode: after a folder is picked). `force` bypasses the
    // auto-download size cap (used by the manual "取得" button).
    const startDownload = (id: string, force: boolean) => {
      if (!transfer || !store) return;
      const file = files.get(id);
      if (!file) return;
      if (file.uploader === peerId || held.has(id)) return;
      if (transfer.isDownloading(id)) return;
      if (!force && file.size > MAX_AUTO_BYTES) return; // large: manual only
      const holder = pickHolder(id);
      if (holder) transfer.download(id, file.mime, file.filename, holder);
    };

    // Auto-download path (respects the size cap).
    const maybeDownload = (id: string) => startDownload(id, false);

    // Manual fetch (from the per-card "取得" button) — ignores the size cap.
    const onFetch = (id: string) => {
      startDownload(id, true);
      handle.update();
    };

    const retryDownloads = () => {
      for (const id of files.keys()) maybeDownload(id);
    };

    // Mark which known files we already hold locally (from the active store)
    // and re-announce `have` for each. The server tracks holders per live
    // socket, so on every (re)connect — including WS drops on mobile — we must
    // re-assert what we hold, or the server forgets we can serve these and
    // re-distribution silently stops.
    const syncHeldFromStore = async () => {
      if (!store) return;
      for (const id of await store.listIds()) {
        if (files.has(id)) {
          noteHeld(id);
          ws?.send({ t: "have", id });
        }
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
      opfsOk = opfsAvailable();
      // IMPORTANT: do NOT read the persisted mode here. The server always SSRs
      // the default ("opfs") layout, and the first client render must match it
      // exactly or hydration mismatches (structural diff → broken event
      // wiring). Apply the stored mode after hydration, in the microtask below.
      // Defer opening the socket until after the first render too: the WsClient
      // reports status synchronously, and handle.update() during the setup
      // phase (before the initial render) is not allowed.
      queueMicrotask(() => {
        mode = localStorage.getItem(MODE_KEY) === "folder" ? "folder" : "opfs";
        // OPFS store is ready immediately; the folder store waits for a pick.
        if (mode === "opfs") store = new OpfsStore();
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
              noteHeld(fileId);
              dlState.delete(fileId);
              progress.delete(fileId);
            } else {
              dlState.set(fileId, state);
              if (state === "error") progress.delete(fileId);
            }
            handle.update();
          },
          (fileId, received, total) => {
            // Throttle re-renders to whole-percent changes.
            const pct = total > 0 ? Math.floor((received / total) * 100) : 0;
            if (progress.get(fileId) === pct) return;
            progress.set(fileId, pct);
            handle.update();
          },
        );
        if (store) transfer.setStore(store);
        // Reflect the applied mode now that we're past hydration.
        handle.update();
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
        noteHeld(id);

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

    // Select every held file.
    const onSelectAll = () => {
      for (const f of files.values()) if (held.has(f.id)) selected.add(f.id);
      handle.update();
    };

    // Invert the selection across held files.
    const onInvertSelection = () => {
      for (const f of files.values()) {
        if (!held.has(f.id)) continue;
        if (selected.has(f.id)) selected.delete(f.id);
        else selected.add(f.id);
      }
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

    // Switch sync mode in place (no reload — a reload just re-triggers the
    // SSR→hydrate path). Reset per-mode state and swap the active store.
    const onSetMode = (m: SyncMode) => {
      if (m === mode) return;
      mode = m;
      try {
        localStorage.setItem(MODE_KEY, m);
      } catch {
        /* private mode — won't persist across reloads */
      }
      selected.clear();
      held.clear();
      if (m === "opfs") {
        store = new OpfsStore();
        transfer?.setStore(store);
        void syncHeldFromStore();
      } else {
        // Folder mode needs a fresh pick; stop serving/downloading until then.
        store = null;
        folderName = null;
        folderMsg = null;
        transfer?.setStore(null);
      }
      handle.update();
    };

    // Publish a body we already hold (folder mode: existing folder files) to the
    // index — upload a thumbnail + `add` if new, else just announce `have`.
    const publishHeld = async (id: string, file: File): Promise<void> => {
      noteHeld(id);
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

    // Per-file overlay chip shown on the thumbnail. A single dark translucent
    // pill (readable over any photo) whose leading dot carries the colour, so
    // we never depend on a daisyUI `*-content` pair for contrast. Returns null
    // for untouched files — an unfetched large file gets the 取得 chip instead.
    const fileTag = (
      f: FileMeta,
    ): { label: string; dot?: string } | null => {
      if (f.uploader === peerId) return { label: "自分" };
      if (held.has(f.id)) return { label: "同期済み", dot: "bg-success" };
      const s = dlState.get(f.id);
      if (s === "downloading") {
        const pct = progress.get(f.id);
        return {
          label: pct != null ? `受信中 ${pct}%` : "受信中",
          dot: "bg-info",
        };
      }
      if (s === "error") return { label: "失敗", dot: "bg-error" };
      return null;
    };

    // Copy the room URL — the one thing every guest needs. Feedback is shown
    // in the button label itself and cleared after a moment.
    let copyMsg: string | null = null;
    let copyTimer: ReturnType<typeof setTimeout> | undefined;
    const onCopyUrl = async () => {
      try {
        await navigator.clipboard.writeText(location.href);
        copyMsg = "コピーしました";
      } catch {
        // Clipboard needs a secure context / permission; say so rather than
        // failing silently.
        copyMsg = "コピーできません";
      }
      handle.update();
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => {
        copyMsg = null;
        handle.update();
      }, 2000);
    };

    return () => {
      const list = [...files.values()].sort((a, b) =>
        a.createdAt - b.createdAt
      );
      const sel = selectedStats();
      const overLimit = sel.bytes > MAX_ZIP_BYTES;
      const heldCount = list.filter((f) => held.has(f.id)).length;
      const folderSupported = isFolderSyncSupported();
      // In folder mode, the app is usable only once a folder is chosen.
      const folderReady = mode === "folder" && store !== null;
      const canUpload = mode === "opfs" || folderReady;
      const statusLabel = status === "open"
        ? `接続中 · 参加者 ${peers.length}人`
        : status === "connecting"
        ? "接続しています…"
        : "切断されました";
      // A neutral pill with a coloured status dot: the colour-on-colour
      // filled badges (e.g. badge-success) had too little text contrast.
      const statusDot = status === "open"
        ? "status-success"
        : status === "connecting"
        ? "status-warning"
        : "status-error";

      return (
        <div class="min-h-screen bg-base-200">
          {/* ── top bar ─────────────────────────────────────────── */}
          <header class="sticky top-0 z-30 border-b border-base-300 bg-base-100">
            <div class="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 sm:px-7 sm:py-3">
              <span class="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-primary text-primary-content">
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z" />
                  <circle cx="12" cy="13" r="3.2" />
                </svg>
              </span>

              <div class="min-w-0 flex-1">
                <h1 class="truncate text-base font-bold sm:text-[17px]">
                  {albumName || "アルバム"}
                </h1>
                <p class="flex flex-wrap items-center gap-1.5 text-xs text-base-content/60">
                  <span class={`status ${statusDot}`}></span>
                  {statusLabel}
                  {mode === "opfs" && !opfsOk && (
                    <span class="badge badge-outline badge-warning badge-xs">
                      OPFS 非対応
                    </span>
                  )}
                </p>
              </div>

              <label class="input input-sm input-bordered flex w-24 min-w-0 shrink items-center gap-1 sm:w-40">
                <span class="text-base-content/50">
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <circle cx="12" cy="8" r="4" />
                    <path d="M4 20c0-4 3.6-6 8-6s8 2 8 6" />
                  </svg>
                </span>
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

              {
                /* Narrow screens stack these full-width (the labels don't fit
                  side by side); one row from `sm` up. */
              }
              <div class="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:flex-nowrap">
                <div class="tabs tabs-box tabs-sm w-full sm:w-auto">
                  <button
                    type="button"
                    class={`tab flex-1 whitespace-nowrap sm:flex-none ${
                      mode === "opfs" ? "tab-active" : ""
                    }`}
                    mix={[on("click", () => onSetMode("opfs"))]}
                  >
                    ブラウザ上で同期
                  </button>
                  <button
                    type="button"
                    class={`tab flex-1 whitespace-nowrap sm:flex-none ${
                      mode === "folder" ? "tab-active" : ""
                    }`}
                    mix={[on("click", () => onSetMode("folder"))]}
                  >
                    フォルダを同期
                  </button>
                </div>

                <button
                  type="button"
                  class="btn btn-sm w-full gap-1.5 whitespace-nowrap border-primary/30 bg-primary/10 text-primary hover:bg-primary/20 sm:w-auto"
                  mix={[on("click", () => void onCopyUrl())]}
                >
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5" />
                    <path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5" />
                  </svg>
                  {copyMsg ?? "URL を配る"}
                </button>
              </div>
            </div>
          </header>

          <main class="mx-auto max-w-[1600px] px-4 pb-32 pt-4 sm:px-7 sm:pt-6">
            {mode === "folder" && (
              <div class="mb-4 space-y-2 rounded-box border border-base-300 bg-base-100 p-3">
                {!folderSupported
                  ? (
                    <p class="text-sm text-base-content/70">
                      このブラウザはフォルダ同期に非対応です（Chrome / Edge
                      などの Chromium 系で利用できます）。他のブラウザでは
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
              <div role="alert" class="alert alert-info alert-soft mb-4 py-2">
                <span class="text-sm">{zipMsg}</span>
              </div>
            )}

            {
              /* Dropping anywhere on the gallery uploads — the dashed tile is
                just the click target. */
            }
            <div
              class="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 md:grid-cols-4 lg:grid-cols-6"
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
              {canUpload && (
                <label
                  for={FILE_INPUT_ID}
                  class="flex aspect-square cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-primary/40 bg-primary/5 text-primary transition-colors hover:bg-primary/10"
                >
                  <svg
                    width="26"
                    height="26"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.8"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M12 15V4" />
                    <path d="m7 9 5-5 5 5" />
                    <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
                  </svg>
                  <span class="text-[13px] font-bold">ファイルを追加</span>
                  <span class="text-[11px] opacity-70">ドロップでも OK</span>
                  {uploading > 0 && (
                    <span class="badge badge-primary badge-sm gap-1">
                      <span class="loading loading-spinner loading-xs"></span>
                      {uploading}
                    </span>
                  )}
                </label>
              )}

              {list.map((f) => {
                const tag = fileTag(f);
                const isHeld = held.has(f.id);
                const isSelected = selected.has(f.id);
                const isDownloading = dlState.get(f.id) === "downloading";
                const pct = progress.get(f.id) ?? 0;
                // Large files aren't auto-fetched — offer a manual chip, but
                // only when it can actually work: a store is ready and an
                // online holder exists (else the fetch would silently no-op).
                const isLargeWanted = !isHeld && !isDownloading &&
                  f.uploader !== peerId && f.size > MAX_AUTO_BYTES;
                const holderOnline = pickHolder(f.id) !== null;
                const canFetch = isLargeWanted && holderOnline &&
                  store !== null;
                return (
                  <div class="relative overflow-hidden rounded-xl border border-base-300 bg-base-100">
                    <div class="relative aspect-square bg-base-200">
                      <img
                        src={f.thumbUrl}
                        alt={f.filename}
                        loading="lazy"
                        class="h-full w-full object-cover"
                      />

                      {/* Status chips stack so they never overlap. */}
                      <div class="absolute left-2 top-2 flex flex-col items-start gap-1">
                        {tag && (
                          <span class="inline-flex items-center gap-1.5 rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-semibold text-white backdrop-blur-sm">
                            {tag.dot && (
                              <span
                                class={`h-1.5 w-1.5 rounded-full ${tag.dot}`}
                              >
                              </span>
                            )}
                            {tag.label}
                          </span>
                        )}
                        {canFetch && (
                          <button
                            type="button"
                            class="inline-flex items-center gap-1 rounded-full bg-warning px-2 py-0.5 text-[11px] font-bold text-black/80"
                            mix={[on("click", () => onFetch(f.id))]}
                          >
                            <svg
                              width="11"
                              height="11"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              stroke-width="2.6"
                              stroke-linecap="round"
                              stroke-linejoin="round"
                            >
                              <path d="M12 4v11" />
                              <path d="m7 10 5 5 5-5" />
                              <path d="M4 20h16" />
                            </svg>
                            {`取得 ${humanSize(f.size)}`}
                          </button>
                        )}
                        {isLargeWanted && !holderOnline && (
                          <span class="rounded-full bg-black/55 px-2 py-0.5 text-[11px] text-white backdrop-blur-sm">
                            配信者オフライン
                          </span>
                        )}
                      </div>

                      {mode === "opfs" && isHeld && (
                        <input
                          type="checkbox"
                          class="checkbox checkbox-sm absolute right-2 top-2 border-base-300 bg-base-100"
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

                      <div
                        class={`absolute inset-x-0 bottom-0 flex items-end gap-1.5 bg-gradient-to-t from-black/75 to-transparent px-2 pt-6 ${
                          isDownloading ? "pb-3" : "pb-1.5"
                        }`}
                      >
                        <div class="min-w-0 flex-1">
                          <div
                            class="truncate text-[11.5px] font-semibold text-white"
                            title={f.filename}
                          >
                            {f.filename}
                          </div>
                          <div class="truncate text-[10.5px] text-white/70">
                            {`${humanSize(f.size)} · ${uploaderLabel(f)}`}
                          </div>
                        </div>
                        {mode === "opfs" && isHeld && (
                          <button
                            type="button"
                            class="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-white/20 text-white hover:bg-white/40"
                            title="保存"
                            aria-label="保存"
                            mix={[on("click", () => void onDownloadOne(f))]}
                          >
                            <svg
                              width="13"
                              height="13"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              stroke-width="2.2"
                              stroke-linecap="round"
                              stroke-linejoin="round"
                            >
                              <path d="M12 4v11" />
                              <path d="m7 10 5 5 5-5" />
                              <path d="M4 20h16" />
                            </svg>
                          </button>
                        )}
                      </div>

                      {isDownloading && (
                        <progress
                          class="progress progress-info absolute inset-x-0 bottom-0 h-1.5 w-full rounded-none"
                          value={pct}
                          max="100"
                        >
                        </progress>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {list.length === 0 && (
              <p class="py-10 text-center text-sm text-base-content/50">
                まだ写真がありません。最初の1枚をアップしてみましょう。
              </p>
            )}
          </main>

          <input
            id={FILE_INPUT_ID}
            type="file"
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

          {/* ── floating action dock ───────────────────────────── */}
          {mode === "opfs" && (
            <div class="fixed inset-x-0 bottom-0 z-40 border-t border-base-300 bg-base-100/90 p-3 backdrop-blur sm:inset-x-auto sm:bottom-6 sm:left-1/2 sm:-translate-x-1/2 sm:rounded-2xl sm:border sm:p-2.5 sm:shadow-xl">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="flex items-center gap-1.5">
                  <button
                    type="button"
                    class="btn btn-ghost btn-xs sm:btn-sm"
                    disabled={heldCount === 0}
                    mix={[on("click", () => onSelectAll())]}
                  >
                    全て選択
                  </button>
                  <button
                    type="button"
                    class="btn btn-ghost btn-xs sm:btn-sm"
                    disabled={heldCount === 0}
                    mix={[on("click", () => onInvertSelection())]}
                  >
                    反転
                  </button>
                  <span class="mx-1 hidden h-6 w-px bg-base-300 sm:block">
                  </span>
                  <span class="text-xs sm:text-sm">
                    <span class="font-bold">{`選択 ${sel.count} 件`}</span>
                    <span class="text-base-content/60">
                      {` · ${humanSize(sel.bytes)}`}
                    </span>
                  </span>
                </div>

                {overLimit && (
                  <span class="w-full text-xs text-error sm:w-auto">
                    4GB を超えると一括ダウンロードできません
                  </span>
                )}

                <button
                  type="button"
                  class="btn btn-primary btn-sm w-full gap-1.5 whitespace-nowrap sm:w-auto"
                  disabled={sel.count === 0 || overLimit || zipping}
                  mix={[on("click", () => void onDownloadZip())]}
                >
                  {zipping && (
                    <span class="loading loading-spinner loading-xs"></span>
                  )}
                  {!zipping && (
                    <svg
                      width="15"
                      height="15"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <path d="M12 4v11" />
                      <path d="m7 10 5 5 5-5" />
                      <path d="M4 20h16" />
                    </svg>
                  )}
                  {zipping ? "作成中…" : "まとめてダウンロード"}
                </button>
              </div>
            </div>
          )}
        </div>
      );
    };
  },
);
