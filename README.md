# photorrent

パーティ参加者用の写真・動画共有 Web サービス。参加者に**同じ URL
を1つ配る**だけ。
ブラウザで開いて手元の写真・動画をアップロードすると、他の人のアップロードは自動で同期される。

- ファイル本体は P2P (WebRTC) で配布し、サーバは中継のみ（Phase 2）。
- サーバは各ファイルの index（サムネ・サイズ）だけを保持。
- 「不要」マークしたものは自分の端末にはダウンロードされない。
- OPFS に保存し、後でまとめて外部ファイルシステムへエクスポート（Phase 2）。

Deno + Remix v3 (`@remix-run/fetch-router`) 実装。永続化は Cloudflare Workers
デプロイを見据えて **Turso (libSQL)** を使う（index=`@remix-run/data-table`、
サムネ本体=R2/ローカル、サムネ ct=`@kuboon/kv/turso.ts`）。

## 開発

```bash
deno task dev      # 開発サーバー（http://localhost:8000/）
deno task test     # テスト
deno task check    # 型チェック + lint + fmt
```

トップページの「アルバムを作成」で `/room/<roomId>` に入り、その URL を配る。
同じ URL
を複数タブ/端末で開くと、アップロードしたサムネがリアルタイムで共有される。

## 実装状況

- **Phase 1（完了）**: 部屋ごとの index を WebSocket
  でリアルタイム同期。アップロード・サムネ生成・
  ライブギャラリー・「不要」ローカルトグル・自分の本体の OPFS 保存まで。
- **Phase 2（完了）**: 本体を WebRTC データチャネルで P2P 転送。欲しいファイルを
  holder から自動ダウンロードして OPFS に保存し、以後は自分も配信元になる。 P2P
  が繋がらない時はサーバ WS のバイト中継にフォールバック。OPFS の本体は
  外部ファイルシステムへ一括エクスポート（既存分はスキップ）。
