# photo-swarm

A party photo-sharing app. Everyone in a party shares one secret key (out of
band, via a link `#fragment` or QR). From that key each participant can:

- upload their own photos,
- see the full index of every photo in the party, instantly,
- see how many photos they don't have yet, and download the missing ones
  peer-to-peer — at the party _and_ after everyone has gone home.

**No server stores photos.** Photo bytes move browser-to-browser over WebRTC.
The server only coordinates (WebRTC signaling + the encrypted index) and, when a
direct connection can't be made, a managed TURN relay carries the (already
encrypted) bytes. Every payload is end-to-end encrypted with the party key, so
neither the server, nor TURN, nor an uninvited peer can read them.

## Architecture

Two planes:

- **Control plane** — one WebSocket per participant, keyed by an opaque `roomId`
  derived from the party key. It carries both WebRTC **signaling** (SDP/ICE
  relayed between peers) and the **manifest** (append + live broadcast of the
  encrypted index). The server holds only the live socket set per room
  (ephemeral) and the append-only encrypted metadata (persisted in Turso). It
  never sees the party key or any photo bytes.
- **Data plane** — a WebRTC mesh. Photos are requested and streamed over
  `RTCDataChannel`. Any peer holding a photo can serve it, so receivers become
  sources automatically — the swarm property, without BitTorrent's machinery.

```
browser ──ws──▶ server (signaling relay + manifest in Turso)
   │  ▲
   │  └────────── manifest fan-out ───────────┐
   ▼                                           │
 WebRTC DataChannel  ◀──have?/want/chunks──▶  other browsers
   (E2E-encrypted photo bytes, TURN only if direct fails)
```

## Layout

```
server.ts              Local Deno entry: Deno.serve + /ws upgrade
deno.json              Tasks, imports, unstable "bundle"
app/
  routes.ts            HTTP routes (Remix v3 fetch-router)
  router.ts            Router + static middleware
  controllers/         home (shell), ice (/api/ice) — Deno
  ui/shell.ts          Dependency-free HTML shell (shared with the Worker)
  server/
    room.ts            RoomLive interface + in-memory impl + registry
    session.ts         Shared control-plane message handling
    manifest-store.ts  ManifestStore: Turso (libSQL) + in-memory fallback
    ice.ts             STUN + server-minted Cloudflare TURN credentials
    store-factory.ts   Pick a store from the Deno env
src/                   Browser domain logic (bundled to public/mod.js)
  crypto.ts            Party key, room-id derivation, payload encryption
  protocol.ts          Wire message types (shared client ⇄ server)
  manifest.ts          Selectors (missing / ownedSummary) + WS client
  transfer.ts          WebRTC mesh, have/want protocol, IndexedDB store
client/                Client boot (mod.ts) + framework-free DOM app (app.ts)
bundler/js.ts          Deno.bundle → public/mod.js
public/                style.css, favicon.svg, (generated) mod.js
worker/                Cloudflare Worker + Durable Object (prod)
```

## Crypto

`src/crypto.ts` is the trust boundary. The party key `K` is an AES-GCM 256 key
that lives **only** in the URL fragment (`#k=<base64url>`), so it never reaches
the server. The server is keyed by `roomId = SHA-256(rawKey)` — derived from `K`
but one-way, so the server can route sockets and store the manifest without
learning `K`. Photo bytes, filenames, and thumbnails are all encrypted with `K`
before they leave the browser. Each photo's id is `SHA-256(ciphertext)`, which
is also the membership/dedup key.

## Run locally (Deno)

```bash
deno task dev      # bundle client + start the server on :44100
deno task test     # unit + session integration tests
deno task check    # bundle + typecheck + lint + fmt --check
```

Open the URL, then use **Share party** to copy the link (including the `#k=...`
fragment) and open it in another browser/device to join the same party. Without
Turso/TURN configured (see `.env.example`) it uses an in-memory manifest and
STUN-only ICE — enough to test on one network.

## Deploy (Cloudflare)

The Worker serves static assets, mints TURN credentials, and routes `/ws` to a
Durable Object per room (one live room each, using the WebSocket Hibernation API
so idle parties are free). Manifest persistence is the same Turso store.

```bash
deno task bundle                      # build public/mod.js (the assets dir)
cd worker && npm install
npx wrangler secret put TURN_KEY_ID
npx wrangler secret put TURN_KEY_API_TOKEN
npx wrangler secret put TURSO_DATABASE_URL
npx wrangler secret put TURSO_AUTH_TOKEN
npx wrangler deploy
```

## Notes & limits

- A peer only serves photos it currently holds; tabs are transient (close =
  leave). A late/home peer can still fetch any photo while ≥1 holder is online.
  There is no always-on seeder unless someone keeps a tab open.
- TURN is fallback only (used when direct/STUN fails) and is metered egress —
  expected to stay within the free tier at party scale, but treat it as metered.
- Random-IV encryption means identical plaintext doesn't dedup across
  re-encryptions; that's acceptable here (dedup keys off the ciphertext hash).
