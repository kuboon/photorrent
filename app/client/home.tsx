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

/** URL-friendly random room id (~16 base64url chars), minted in the browser. */
function newRoomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
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
