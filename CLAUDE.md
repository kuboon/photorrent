# photorrent

パーティ参加者用の写真・動画共有 Web サービス。参加者に**同じ URL
を1つ配る**だけで、
ブラウザで開いて手元の写真・動画をアップロードでき、他の人のアップロードは自動同期される。

Deno + Remix v3 (`@remix-run/fetch-router`) 実装。sibling の
[deno-remix-reference](https://github.com/kuboon/deno-remix-reference)
の構成を踏襲。

## 全体設計（最終形）

- ファイル**本体**は P2P (WebRTC データチャネル)
  で配布し、サーバはシグナリング中継＋ （P2P
  不能時の）バイト中継フォールバックのみを担う。
- サーバは各ファイルの **index（サムネ・サイズ等のメタデータ）**
  だけを保持する。
- 参加者が「不要」マークしたものは自分の端末にはダウンロードされない（ローカル設定）。
- ダウンロード/自分のアップした本体は OPFS
  に保存され、後でまとめて外部ファイルシステムへ
  エクスポートできる（対象に既存のものは除外）。

## 実装フェーズ

- **Phase 1 — 基盤（完了）**: 部屋ごとの index を WebSocket
  でリアルタイム同期する。 アップロード → content hash → サムネ生成 →
  自分の本体を OPFS 保存 → サムネを POST → WS で `add` 送信。他タブに index
  イベントが届きギャラリーがライブ更新される。
- **Phase 2 — 本体転送（完了）**: ファイル本体を WebRTC データチャネルで P2P
  配布する。参加者は「欲しい（＝不要でない）が未取得」のファイルを holder
  から自動ダウンロードし、OPFS に保存して `have` を通知（以後は自分も配信元に
  なる）。P2P が繋がらない場合はサーバ WS の `relay` でチャンクを中継する
  フォールバックに切り替わる。OPFS の本体は外部ファイルシステムへ一括
  エクスポートできる（対象ディレクトリに既存の名前はスキップ）。 holder
  追跡（誰がどのファイルを持つか）はサーバが行い `holders` で配信する。

## 構造

- `app/server/` — Remix v3 fetch-router
  - `routes.ts` / `router.ts` —
    ルート定義とコントローラ紐付け（`export default router`）
  - `controllers/` — `home` / `room` / `ws`（WebSocket upgrade）/
    `api/room_index` / `api/thumb`
  - `lib/protocol.ts` — WS メッセージの型（server/client 共用、型のみ）。 index
    同期（add/remove）・presence・holder 追跡（have/holders）・
    シグナリング（signal）・バイト中継（relay）
  - `lib/room_hub.ts` — 部屋ごとの接続レジストリ＋ブロードキャスト＋holder
    追跡＋ signal/relay 中継（シングルトン）
  - `lib/db.ts` — libSQL (Turso) クライアント＋ `@remix-run/data-table` の DB
    （env 駆動・遅延初期化）。`files` テーブル定義とスキーマ作成
  - `lib/object_store.ts` — サムネ本体の保存抽象（dev=ローカルFS / prod=R2）
  - `lib/index_store.ts` — 部屋ごとのストア。index=`@remix-run/data-table`、
    サムネ ct=`@kuboon/kv/turso.ts`、サムネ本体=`object_store`（R2/local）
  - `main.ts` — `deno serve` エントリ。WebSocket upgrade をルータより前で処理
  - `utils/render.tsx` / `ui/document.tsx` — SSR shell + `<Frame>` パターン
- `app/client/` — ブラウザ TS/TSX（`Deno.bundle` で `app/bundled/` に出力）
  - `room_page.tsx` — 部屋ページの唯一の
    `clientEntry`（ドロップゾーン＋ライブギャラリー＋自動DL＋エクスポート）
  - `lib/` — `ws_client` / `thumbnail` / `hash` / `opfs` / `unwanted` /
    `peer`（WebRTC＋relay チャネル）/ `transfer`（本体転送の管理）/
    `export`（外部 FS への書き出し）
- `app/bundler/` — `Deno.bundle`（JS）＋ Tailwind v4（CSS）ビルド
- `app/assets/style.css` — Tailwind + daisyUI 入力
- `app/worker/` — Cloudflare Workers ターゲット（Deno 版と同じ shared
  モジュールを再利用）
  - `worker.ts` — Workers エントリ（`export default { fetch }` ＋
    `export {
    RoomDO }`）。`/ws/:roomId` の upgrade は
    `env.ROOM.get(idFromName(roomId))` へ、その他は fetch-router
    へ。静的アセットは Workers Assets が先に配信
  - `room_do.ts` — `RoomDO`（**部屋ごと1つの Durable Object**）。`RoomHub`
    をそのまま再利用（Cloudflare の WebSocket は `Sink` ダック型を満たす）
  - `router.ts` — edge 用 fetch-router（SSR + REST。WS/staticFiles なし）
  - `edge_deps.ts` — `env` バインディングから `RoomStore`
    を組む（`@libsql/
    client/web` + R2）。libSQL
    クライアントは部屋の初回利用時に遅延生成
  - `cf.d.ts` — 最小の CF 型定義（`DurableObjectNamespace` 等）
  - `build.ts` — `Deno.bundle` で `dist/worker.js` を生成（jsr:/npm: を Deno
    が解決）
  - `wrangler.jsonc` — DO / R2 / Assets バインディングと env

## ルーティング

部屋は **パス方式** `GET /room/:roomId`。`roomId` はページ GET
時点でサーバが知れるので、 SSR で `RoomPage` に prop として渡す。WS/REST
も同様にパスで受ける （`/ws/:roomId`, `/api/room/:roomId/index`,
`/api/room/:roomId/thumb`）。

## 永続化（Turso / libSQL）

デプロイ先は Cloudflare Workers 想定のため Deno KV は使わない。永続化は **Turso
(libSQL)** に統一する。

- **index** は `@remix-run/data-table`（Turso アダプタ
  `@kuboon/remix-data-table-sqlite-turso`） の `files` テーブル。
- **サムネ本体**は R2（prod）/
  ローカルディレクトリ（dev）に置く（`object_store.ts`）。
- **サムネの content-type** は `@kuboon/kv/turso.ts` の `TursoKvRepo` に置く。
- ストレージ層（`db_core` / `index_store` / `object_store` / `room_hub` /
  `protocol`）は**ランタイム非依存**にしてあり、Deno と CF Workers の両方が
  そのまま import できる。Deno ネイティブな配線は `lib/db.ts`（`@libsql/client`
  ネイティブ）＋ `lib/stores.ts`（`hub` シングルトン）に隔離。CF 側の配線は
  `app/worker/`（`@libsql/client/web` ＋ R2 ＋ per-room DO）。

## Cloudflare Workers デプロイ

Deno 版（`deno serve`）と CF Workers 版（`app/worker/`）はストレージ／ハブの
共通モジュールを共有する。差分はランタイム配線のみ。

- **リアルタイム**: 部屋ごとに1つの Durable Object（`RoomDO`,
  `idFromName(roomId)`）が WebSocket と holder/presence を保持。Deno 版の
  `RoomHub` をそのまま再利用（Cloudflare の WebSocket は `Sink`
  ダック型を満たす）。
- **index**: `@libsql/client/web`（HTTP 版）で Turso に接続。ネイティブ版は Deno
  専用（ffi）なので edge では使えない。
- **サムネ本体**: R2（`THUMB_BUCKET` バインディング → `R2ObjectStore`）。
- **静的アセット**: `app/bundled/` を Workers Assets（`ASSETS` バインディング）
  で Worker より前に配信。

```bash
deno task worker:build       # client を bundle → dist/worker.js を生成
npx wrangler dev             # ローカル（DO/Assets は workerd, index は要 Turso）
npx wrangler secret put TURSO_AUTH_TOKEN
npx wrangler deploy
```

`wrangler.jsonc` の `vars.TURSO_DATABASE_URL` に本番 Turso の URL を設定
（`TURSO_AUTH_TOKEN` は secret）。`@libsql/client/web` は HTTP 専用なので、
`wrangler dev` でローカル index 同期まで通すにはローカル libSQL サーバ（sqld）が
必要。DO の WS ハンドシェイク・ページ配信・型チェックはローカルで検証済み。

R2
バケットは初回だけ手動作成する（`npx wrangler r2 bucket create
photorrent-thumbs`）。DO
の SQLite マイグレーションは `wrangler deploy` が自動適用する。

### CI/CD

- **テスト**は GitHub Actions（`.github/workflows/test.yml` — push(main)/PR で
  `deno task check` + `test`）。
- **CLI リリース**は GitHub Actions（`.github/workflows/release-cli.yml` — `cli-v*`
  タグ push で `deno task cli:build` により全 OS バイナリをクロスコンパイルし、
  アーカイブ＋`SHA256SUMS.txt` を GitHub Release に添付）。`deno compile` は単一の
  Linux runner から全ターゲットを吐けるのでビルドマトリックスは不要。
- **デプロイ**は Cloudflare Workers Builds（Git 連携）が担う。GitHub Actions
  では デプロイしない。この Worker は Durable
  Object（`export { RoomDO }`）を持つため、 **Pages ではなく Workers**
  として接続する（Pages Functions は DO クラスを export できない）。Cloudflare
  の GitHub App でリポジトリを接続し、Worker の Builds 設定で以下を指定する:
  - **Root directory**: リポジトリルート（`/`）。ビルドは workspace 全体
    （`app/client`・`app/server`・`app/bundler`）を要するため。
  - **Build command**:
    `curl -fsSL https://deno.land/install.sh | sh -s -- -y && export PATH="$HOME/.deno/bin:$PATH" && deno task worker:build`
    （`app/bundled` と `app/worker/dist/worker.js` を生成。どちらも gitignore
    済みで CI がビルドする）。
  - **Deploy command**: `npx wrangler deploy --config app/worker/wrangler.jsonc`
    （`main`・`assets.directory` は config 位置基準で解決されるので repo
    ルートから 実行して問題ない。DO の SQLite
    マイグレーションもデプロイ時に自動適用）。
- `wrangler.jsonc` がデプロイ設定（name / main / bindings / DO migrations /
  vars） の source of truth。`.json` へのリネームは不要（Workers Builds は jsonc
  対応）。
- 本番 Turso の URL は `vars.TURSO_DATABASE_URL`、`TURSO_AUTH_TOKEN` は Worker
  secret（dashboard の Settings → Variables and Secrets、または
  `npx wrangler secret put TURSO_AUTH_TOKEN`）で設定する。

### 環境変数

- `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` — Turso 本番 DB。未設定なら
  `TURSO_LOCAL_URL`（既定 `file:./.data/photorrent.db`、テストは `:memory:`）。
- `THUMB_DIR` — dev のサムネ保存先（既定 `./.data/thumbs`）。prod は R2。

CF Workers 側は同名の値を `wrangler.jsonc` の `vars`（`TURSO_DATABASE_URL`）／
secret（`TURSO_AUTH_TOKEN`）と R2 バインディング（`THUMB_BUCKET`）で受ける。

## 開発

```bash
deno task dev          # 開発サーバー起動（bundle してから deno serve --watch）
deno task test         # テスト実行
deno task check        # 型チェック + lint + fmt
deno task worker:build # CF Workers 用 bundle（client bundle → dist/worker.js）
```

> ライブラリの一部は公開直後のため、この環境では `--minimum-dependency-age=0`
> が必要な場合がある（`deno.lock` をコミット済みなので通常の CI では不要）。

`http://localhost:8000/` を開き「アルバムを作成」で `/room/<roomId>` へ。同じ
URL を複数タブ/端末で 開くと、片方のアップロードがもう片方に自動で現れる。

## コーディング規約

- Deno ファースト（Web API 優先、Node.js API は必要最小限）
- TypeScript strict mode
- テストは `Deno.test()` + `@std/assert`
- ファイル名はスネークケース（例: `room_hub.test.ts`）
