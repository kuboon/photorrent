/**
 * RoomPage — the single interactive `clientEntry` for a room.
 *
 * Server renders an empty gallery + dropzone skeleton (roomId injected as a
 * prop); the client hydrates, opens the room WebSocket, and fills the gallery
 * live. Upload flow per file: content hash → thumbnail → save own body to OPFS
 * → POST the thumbnail → WS `add`. Incoming `snapshot`/`added`/`removed`/
 * `presence` events keep the gallery in sync across guests.
 *
 * Setup runs on both server and client; all browser-only work (WebSocket,
 * localStorage, OPFS) is gated on `isClientEnv`.
 */

import {
  clientEntry,
  type Handle,
  on,
  type SerializableValue,
} from "@remix-run/ui";

import type { FileMeta, ServerMsg } from "../server/lib/protocol.ts";
import { contentHash } from "./lib/hash.ts";
import { generateThumbnail } from "./lib/thumbnail.ts";
import { isAvailable as opfsAvailable, saveOwnFile } from "./lib/opfs.ts";
import { UnwantedSet } from "./lib/unwanted.ts";
import { type ConnStatus, WsClient } from "./lib/ws_client.ts";

export interface RoomPageProps {
  roomId: string;
  [key: string]: SerializableValue;
}

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

    const files = new Map<string, FileMeta>();
    let peers: string[] = [];
    let status: ConnStatus = "connecting";
    let uploading = 0;
    let opfsOk = true;

    let peerId = "";
    let unwanted: UnwantedSet | null = null;
    let ws: WsClient | null = null;

    const onServerMsg = (msg: ServerMsg) => {
      switch (msg.t) {
        case "snapshot":
          files.clear();
          for (const f of msg.files) files.set(f.id, f);
          peers = msg.peers;
          break;
        case "added":
          files.set(msg.file.id, msg.file);
          break;
        case "removed":
          files.delete(msg.id);
          break;
        case "presence":
          peers = msg.peers;
          break;
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
      });
    }

    const processFile = async (file: File) => {
      const id = await contentHash(file);
      if (files.has(id)) return; // dedup by content hash
      uploading++;
      handle.update();
      try {
        const thumb = await generateThumbnail(file);
        await saveOwnFile(id, file); // keep our own body locally (Phase 1)

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
      unwanted?.toggle(id);
      handle.update();
    };

    return () => {
      const list = [...files.values()].sort((a, b) =>
        a.createdAt - b.createdAt
      );
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
              <h1 class="text-2xl font-bold">📸 アルバム</h1>
              <p class="text-sm text-base-content/60">
                この URL を参加者に配ってください。
              </p>
            </div>
            <div class="flex items-center gap-2">
              <span class={`badge ${statusBadge} badge-sm`}>{statusLabel}</span>
              {!opfsOk && (
                <span class="badge badge-outline badge-warning badge-sm">
                  OPFS 非対応
                </span>
              )}
            </div>
          </div>

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
                  const mine = f.uploader === peerId;
                  const isUnwanted = unwanted?.has(f.id) ?? false;
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
                        <div class="flex items-center justify-between text-xs text-base-content/60">
                          <span>{humanSize(f.size)}</span>
                          {mine && (
                            <span class="badge badge-ghost badge-xs">自分</span>
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
