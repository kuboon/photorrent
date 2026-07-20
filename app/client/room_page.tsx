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
 * the server byte-relay), saves it to OPFS, and announces `have` so it can
 * serve it onward. "不要"-marked files are skipped. Held bodies can be
 * bulk-exported to an external directory.
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
import { isAvailable as opfsAvailable, listIds, save } from "./lib/opfs.ts";
import { UnwantedSet } from "./lib/unwanted.ts";
import { type ConnStatus, WsClient } from "./lib/ws_client.ts";
import { type FileState, TransferManager } from "./lib/transfer.ts";
import { exportAll, isExportSupported } from "./lib/export.ts";

export interface RoomPageProps {
  roomId: string;
  /** Album title from the shared URL's `?name=` (may be empty). */
  albumName?: string;
  [key: string]: SerializableValue;
}

/** localStorage key for the participant's display name (shared across rooms). */
const NAME_KEY = "photorrent:name";

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
    const held = new Set<string>(); // file ids whose body is in my OPFS
    const dlState = new Map<string, FileState>(); // downloading | error (transient)
    let peers: string[] = [];
    let status: ConnStatus = "connecting";
    let uploading = 0;
    let opfsOk = true;
    let exportMsg: string | null = null;

    let peerId = "";
    let myName = "";
    let unwanted: UnwantedSet | null = null;
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
    const maybeDownload = (id: string) => {
      if (!transfer) return;
      const file = files.get(id);
      if (!file) return;
      if (file.uploader === peerId || held.has(id)) return;
      if (unwanted?.has(id)) return;
      if (transfer.isDownloading(id)) return;
      const holder = pickHolder(id);
      if (holder) transfer.download(id, file.mime, holder);
    };

    const retryDownloads = () => {
      for (const id of files.keys()) maybeDownload(id);
    };

    // Mark which known files we already have bodies for (from a prior session).
    const syncHeldFromOpfs = async () => {
      for (const id of await listIds()) {
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
          void syncHeldFromOpfs();
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
      unwanted = new UnwantedSet(roomId);
      opfsOk = opfsAvailable();
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
      });
    }

    const processFile = async (file: File) => {
      const id = await contentHash(file);
      if (files.has(id)) return; // dedup by content hash
      uploading++;
      handle.update();
      try {
        const thumb = await generateThumbnail(file);
        await save(id, file); // keep our own body locally to serve to peers
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

    const onToggleUnwanted = (id: string) => {
      const nowUnwanted = unwanted?.toggle(id) ?? false;
      if (!nowUnwanted) maybeDownload(id); // un-marked: fetch it after all
      handle.update();
    };

    const onExport = async () => {
      const items = [...files.values()]
        .filter((f) => held.has(f.id))
        .map((f) => ({ id: f.id, filename: f.filename }));
      if (items.length === 0) return;
      try {
        exportMsg = "エクスポート中…";
        handle.update();
        const r = await exportAll(items);
        exportMsg = `${r.written}件を書き出し・${r.skipped}件スキップ` +
          (r.failed ? `・${r.failed}件失敗` : "");
      } catch (err) {
        exportMsg = (err as Error)?.name === "AbortError"
          ? null
          : "エクスポートに失敗しました";
      }
      handle.update();
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
      if (unwanted?.has(f.id)) return null;
      return { label: "未取得", cls: "badge-ghost badge-outline" };
    };

    return () => {
      const list = [...files.values()].sort((a, b) =>
        a.createdAt - b.createdAt
      );
      const heldCount = list.filter((f) => held.has(f.id)).length;
      const canExport = isExportSupported() && heldCount > 0;
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
              {!opfsOk && (
                <span class="badge badge-outline badge-warning badge-sm">
                  OPFS 非対応
                </span>
              )}
              {canExport && (
                <button
                  type="button"
                  class="btn btn-sm btn-outline"
                  mix={[on("click", () => void onExport())]}
                >
                  ⬇️ 端末に保存 ({heldCount})
                </button>
              )}
            </div>
          </div>

          {exportMsg && (
            <div role="alert" class="alert alert-info alert-soft py-2">
              <span class="text-sm">{exportMsg}</span>
            </div>
          )}

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

          {list.length === 0
            ? (
              <div class="text-center text-base-content/50 py-12">
                まだ写真がありません。最初の1枚をアップしてみましょう。
              </div>
            )
            : (
              <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                {list.map((f) => {
                  const isUnwanted = unwanted?.has(f.id) ?? false;
                  const badge = fileBadge(f);
                  return (
                    <div
                      class={`card card-compact bg-base-100 border border-base-300 overflow-hidden ${
                        isUnwanted ? "opacity-40" : ""
                      }`}
                    >
                      <figure class="aspect-square bg-base-200">
                        <img
                          src={f.thumbUrl}
                          alt={f.filename}
                          loading="lazy"
                          class="h-full w-full object-cover"
                        />
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
                        <button
                          type="button"
                          class={`btn btn-xs ${
                            isUnwanted ? "btn-ghost" : "btn-outline"
                          }`}
                          mix={[on("click", () => onToggleUnwanted(f.id))]}
                        >
                          {isUnwanted ? "不要を解除" : "不要"}
                        </button>
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
