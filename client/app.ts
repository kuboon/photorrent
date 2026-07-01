/**
 * Browser app: reads the party key from the URL fragment, joins the room over
 * the control-plane WebSocket, and drives the WebRTC swarm. Framework-free DOM
 * — the whole UI is client-side because the key never reaches the server and
 * transfers need WebRTC + IndexedDB.
 */

import {
  decryptBytes,
  decryptString,
  deriveRoomId,
  encryptBytes,
  encryptString,
  fromBase64Url,
  generatePartyKey,
  keyFromLocation,
  type PartyKey,
  partyLink,
  sha256Hex,
  toBase64Url,
} from "../src/crypto.ts";
import {
  dedupe,
  type ManifestEntry,
  ownedSummary,
  RoomSocket,
  roomSocketUrl,
} from "../src/manifest.ts";
import {
  fetchIceServers,
  LocalStore,
  TransferManager,
} from "../src/transfer.ts";

const THUMB_MAX = 320; // longest thumbnail edge, px.

interface State {
  key: PartyKey;
  peerId: string;
  socket: RoomSocket;
  transfer: TransferManager;
  store: LocalStore;
  manifest: ManifestEntry[];
  owned: Set<string>;
  peers: number;
}

let state: State | null = null;
const thumbUrls = new Map<string, string>(); // hash -> object URL for decrypted thumb

export async function main(): Promise<void> {
  const key = await ensurePartyKey();
  const peerId = randomId();
  const roomId = await deriveRoomId(key);

  const store = new LocalStore();
  const owned = await store.keys();
  const iceServers = await fetchIceServers();

  const socket = new RoomSocket(
    roomSocketUrl(location.origin, roomId),
    peerId,
    {
      onOpen: () => setStatus("connected"),
      onClose: () => setStatus("disconnected"),
      onWelcome: (peers, manifest) => {
        if (!state) return;
        state.manifest = dedupe(manifest);
        state.transfer.connectAll(peers);
        renderGrid();
        updateHeader();
      },
      onManifestEntry: (entry) => {
        if (!state) return;
        state.manifest = dedupe([...state.manifest, entry]);
        renderGrid();
        updateHeader();
      },
      onSignal: (from, data) => state?.transfer.handleSignal(from, data),
      onPeerJoin: (id) => {
        state?.transfer.handlePeerJoin(id);
        updateHeader();
      },
      onPeerLeave: (id) => {
        state?.transfer.handlePeerLeave(id);
        updateHeader();
      },
    },
  );

  const transfer = new TransferManager(socket, store, iceServers, {
    onPeers: () => updateHeader(),
    onStored: (hash) => {
      state?.owned.add(hash);
      renderCell(hash);
      updateHeader();
    },
  });

  state = {
    key,
    peerId,
    socket,
    transfer,
    store,
    manifest: [],
    owned,
    peers: 0,
  };

  renderApp();
  updateHeader();
}

// ---------------------------------------------------------------------------
// party key: reuse the fragment, or mint a fresh party and rewrite the URL
// ---------------------------------------------------------------------------

async function ensurePartyKey(): Promise<PartyKey> {
  const existing = await keyFromLocation(location);
  if (existing) return existing;
  const key = await generatePartyKey();
  const link = await partyLink(location.href, key);
  history.replaceState(null, "", new URL(link).hash);
  return key;
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function renderApp(): void {
  const app = document.getElementById("app");
  if (!app) return;
  app.innerHTML = "";

  const topbar = el("header", "topbar");
  topbar.append(
    span("brand", "📸 photo-swarm"),
    (() => {
      const s = span("status", "connecting…");
      s.id = "status";
      return s;
    })(),
  );

  const toolbar = el("div", "toolbar");
  const counts = span("counts", "");
  counts.id = "counts";
  const share = button("share", "🔗 Share party", onShare);
  const upload = button("primary", "＋ Add photos", () => fileInput.click());
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "image/*";
  fileInput.multiple = true;
  fileInput.hidden = true;
  fileInput.addEventListener("change", () => {
    if (fileInput.files) void handleUpload([...fileInput.files]);
    fileInput.value = "";
  });
  toolbar.append(counts, share, upload, fileInput);

  const grid = el("section", "grid");
  grid.id = "grid";

  const main = el("main", "stage");
  main.append(toolbar, grid);

  app.append(topbar, main);
}

function updateHeader(): void {
  if (!state) return;
  const summary = ownedSummary(state.manifest, state.owned);
  const counts = document.getElementById("counts");
  if (counts) {
    counts.textContent =
      `${summary.owned} / ${summary.total} photos · ${state.transfer.peerCount} peers` +
      (summary.missing ? ` · ${summary.missing} missing` : "");
  }
}

function renderGrid(): void {
  const grid = document.getElementById("grid");
  if (!grid || !state) return;
  const entries = state.manifest;
  if (entries.length === 0) {
    grid.innerHTML =
      `<p class="empty">No photos yet. Tap “Add photos” to start the party.</p>`;
    return;
  }
  grid.innerHTML = "";
  for (const entry of entries) grid.append(cell(entry));
}

function cell(entry: ManifestEntry): HTMLElement {
  const fig = el("figure", "cell");
  fig.dataset.hash = entry.hash;
  fig.classList.toggle("missing", state ? !state.owned.has(entry.hash) : true);

  const img = document.createElement("img");
  img.loading = "lazy";
  img.alt = "";
  fig.append(img);
  void decryptThumb(entry).then((url) => {
    if (url) img.src = url;
  });

  const badge = el("figcaption", "badge");
  badge.textContent = state?.owned.has(entry.hash) ? "✓" : "↓";
  fig.append(badge);

  fig.addEventListener("click", () => void onCellClick(entry));
  return fig;
}

/** Re-render a single cell in place (e.g. after it becomes owned). */
function renderCell(hash: string): void {
  const fig = document.querySelector<HTMLElement>(`.cell[data-hash="${hash}"]`);
  if (!fig || !state) return;
  const owned = state.owned.has(hash);
  fig.classList.toggle("missing", !owned);
  const badge = fig.querySelector(".badge");
  if (badge) badge.textContent = owned ? "✓" : "↓";
}

async function decryptThumb(entry: ManifestEntry): Promise<string | null> {
  const cached = thumbUrls.get(entry.hash);
  if (cached) return cached;
  if (!state || !entry.encThumb) return null;
  try {
    const bytes = await decryptBytes(state.key, fromBase64Url(entry.encThumb));
    const url = URL.createObjectURL(
      new Blob([bytes as BlobPart], { type: "image/jpeg" }),
    );
    thumbUrls.set(entry.hash, url);
    return url;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// interactions
// ---------------------------------------------------------------------------

async function onCellClick(entry: ManifestEntry): Promise<void> {
  if (!state) return;
  const fig = document.querySelector<HTMLElement>(
    `.cell[data-hash="${entry.hash}"]`,
  );
  fig?.classList.add("busy");
  try {
    const ciphertext = state.owned.has(entry.hash)
      ? await state.store.get(entry.hash)
      : await state.transfer.fetchPhoto(entry.hash, entry.size);
    if (!ciphertext) throw new Error("not available");
    state.owned.add(entry.hash);
    renderCell(entry.hash);
    updateHeader();
    const plain = await decryptBytes(state.key, ciphertext);
    const name = await decryptString(state.key, entry.encName).catch(() =>
      "photo.jpg"
    );
    openPhoto(plain, name);
  } catch (err) {
    setStatus(`download failed: ${(err as Error).message}`);
  } finally {
    fig?.classList.remove("busy");
  }
}

function openPhoto(bytes: Uint8Array, name: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

async function onShare(): Promise<void> {
  if (!state) return;
  const link = await partyLink(location.href, state.key);
  try {
    if (navigator.share) {
      await navigator.share({ title: "photo-swarm", url: link });
    } else {
      await navigator.clipboard.writeText(link);
      setStatus("party link copied");
    }
  } catch {
    await navigator.clipboard.writeText(link).catch(() => {});
    setStatus("party link copied");
  }
}

async function handleUpload(files: File[]): Promise<void> {
  if (!state) return;
  for (const file of files) {
    if (!file.type.startsWith("image/")) continue;
    try {
      const raw = new Uint8Array(await file.arrayBuffer());
      const ciphertext = await encryptBytes(state.key, raw);
      const hash = await sha256Hex(ciphertext);
      if (state.owned.has(hash)) continue;

      const thumb = await makeThumb(file);
      const encThumb = toBase64Url(await encryptBytes(state.key, thumb));
      const encName = await encryptString(state.key, file.name);

      await state.transfer.addLocal(hash, ciphertext);
      state.owned.add(hash);

      const entry: ManifestEntry = {
        hash,
        owner: state.peerId,
        size: ciphertext.length,
        encName,
        encThumb,
        addedAt: Date.now(),
      };
      state.manifest = dedupe([...state.manifest, entry]);
      state.socket.addManifest(entry);
      renderGrid();
      updateHeader();
    } catch (err) {
      setStatus(`upload failed: ${(err as Error).message}`);
    }
  }
}

/** Downscale an image to a small JPEG thumbnail for the instant grid. */
async function makeThumb(file: File): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, THUMB_MAX / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.7)
  );
  if (!blob) throw new Error("thumbnail failed");
  return new Uint8Array(await blob.arrayBuffer());
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function setStatus(text: string): void {
  const s = document.getElementById("status");
  if (s) s.textContent = text;
}

function el(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function span(className: string, text: string): HTMLElement {
  const node = el("span", className);
  node.textContent = text;
  return node;
}

function button(
  className: string,
  text: string,
  onClick: () => void,
): HTMLButtonElement {
  const node = document.createElement("button");
  node.className = `btn ${className}`;
  node.textContent = text;
  node.addEventListener("click", onClick);
  return node;
}

function randomId(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(9)));
}
