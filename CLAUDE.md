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
- リアルタイム（WS ハブ・holder）は現状プロセス内。CF Workers 化＝WebSocket を
  Durable Object へ、libSQL を `@libsql/client/web` へ、R2 バインディングを
  `object_store.setThumbBucket()` へ、は後続作業（別 PR）。

### 環境変数

- `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` — Turso 本番 DB。未設定なら
  `TURSO_LOCAL_URL`（既定 `file:./.data/photorrent.db`、テストは `:memory:`）。
- `THUMB_DIR` — dev のサムネ保存先（既定 `./.data/thumbs`）。prod は R2。

## 開発

```bash
deno task dev      # 開発サーバー起動（bundle してから deno serve --watch）
deno task test     # テスト実行
deno task check    # 型チェック + lint + fmt
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
