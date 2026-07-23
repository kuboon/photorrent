# photorrent CLI

コマンドラインから部屋に参加し、**カレントディレクトリのメディアを共有**しつつ、
他の参加者のファイルを **`./shared` にダウンロード＆再シード**する。ブラウザ版と
同じ部屋・同じ index にそのまま相乗りできる。

```bash
# 既存の部屋に参加（ブラウザで配られた URL をそのまま渡す）
photorrent https://example.com/room/MO94MyA7k4MbZxjO

# 新しい部屋を作成 → URL を stdout に出力してそのまま共有モードへ
photorrent new https://example.com

# 表示名を付ける（任意）
photorrent --name きゅぼん https://example.com/room/XXXX
```

- カレント直下のメディア（jpg/png/gif/webp/mp4/mov/webm など）を content hash
  （SHA-256）で識別し、`add` で index に載せる。ブラウザ版と id が一致するので
  重複は自動 dedup される。
- 本体転送は **サーバのバイトリレー経由のみ**（Deno にネイティブ WebRTC が
  無いため）。ブラウザとも相互運用できるが、直 P2P より遅い。ブラウザが CLI から
  ダウンロードする方向は、ブラウザ側が先に WebRTC を試すぶん開始が数秒遅れる。
- サムネイルは軽量なプレースホルダ SVG（画像=🖼️ / 動画=🎬）。実サムネ生成には
  画像ライブラリ／ffmpeg が要り単一バイナリ配布と両立しないため、v1 では省略。
- ダウンロードした本体は `./shared/` に保存し、`have`
  を送って自分も配信元になる。

## ビルド

```bash
deno task cli            # ソースから直接実行（開発）
deno task cli:build      # 全 OS 向けに dist/<os-arch>/ へ単一バイナリを生成
deno task cli:build windows   # キーワードで対象を絞る
```

`deno compile` で Linux / Windows / macOS（x64・arm64）向けの自己完結バイナリを
出力する。ネイティブ依存が無いのでクロスコンパイルはそのまま通る。
