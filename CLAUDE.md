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

- **Phase 1（現状）— 基盤**: 部屋ごとの index を WebSocket
  でリアルタイム同期する。 アップロード → content hash → サムネ生成 →
  自分の本体を OPFS 保存 → サムネを POST → WS で `add` 送信。他タブに index
  イベントが届きギャラリーがライブ更新される。
- **Phase 2 以降**: WebRTC 本体転送 / サーババイト中継フォールバック /
  受信本体の OPFS 保存 / 外部 FS への一括エクスポート。

## 構造

- `app/server/` — Remix v3 fetch-router
  - `routes.ts` / `router.ts` —
    ルート定義とコントローラ紐付け（`export default router`）
  - `controllers/` — `home` / `room` / `ws`（WebSocket upgrade）/
    `api/room_index` / `api/thumb`
  - `lib/protocol.ts` — WS メッセージの型（server/client 共用、型のみ）
  - `lib/room_hub.ts` —
    部屋ごとの接続レジストリ＋ブロードキャスト＋シグナリング中継（シングルトン）
  - `lib/index_store.ts` — `@kuboon/kv` の `KvRepo` を使う index
    ＋サムネのストア
  - `utils/render.tsx` / `ui/document.tsx` — SSR shell + `<Frame>` パターン
- `app/client/` — ブラウザ TS/TSX（`Deno.bundle` で `app/bundled/` に出力）
  - `room_page.tsx` — 部屋ページの唯一の
    `clientEntry`（ドロップゾーン＋ライブギャラリー）
  - `lib/` — `ws_client` / `thumbnail` / `hash` / `opfs` / `unwanted`
- `app/bundler/` — `Deno.bundle`（JS）＋ Tailwind v4（CSS）ビルド
- `app/assets/style.css` — Tailwind + daisyUI 入力

## ルーティング

部屋は **パス方式** `GET /room/:roomId`。`roomId` はページ GET
時点でサーバが知れるので、 SSR で `RoomPage` に prop として渡す。WS/REST
も同様にパスで受ける （`/ws/:roomId`, `/api/room/:roomId/index`,
`/api/room/:roomId/thumb`）。

## 開発

```bash
deno task dev      # 開発サーバー起動（bundle してから deno serve --watch）
deno task test     # テスト実行
deno task check    # 型チェック + lint + fmt
```

`http://localhost:8000/` を開き「アルバムを作成」で `/room/<roomId>` へ。同じ
URL を複数タブ/端末で 開くと、片方のアップロードがもう片方に自動で現れる。

## コーディング規約

- Deno ファースト（Web API 優先、Node.js API は必要最小限）
- TypeScript strict mode
- テストは `Deno.test()` + `@std/assert`
- ファイル名はスネークケース（例: `room_hub.test.ts`）
