/**
 * GET / — landing page with a "name it + create album" action.
 *
 * The roomId is minted client-side by the {@link CreateAlbum} entry when the
 * button is pressed (so the optional album name can be folded into the target
 * URL as `?name=…`); the page itself is otherwise static.
 */

import type { BuildAction } from "@remix-run/fetch-router";
import type { routes } from "../routes.ts";
import { renderPage } from "../utils/render.tsx";
import { CreateAlbum } from "../../client/home.tsx";

export const homeAction = {
  handler(context) {
    return renderPage(
      context,
      <main class="mx-auto w-full max-w-2xl p-8 space-y-6">
        <div class="hero bg-base-200 rounded-box">
          <div class="hero-content text-center">
            <div class="flex flex-col items-center">
              <h1 class="text-3xl font-bold">📸 photorrent</h1>
              <p class="py-4">
                パーティの写真・動画をみんなで共有。アルバムを作って URL
                を配るだけ。
                アップした写真は参加者全員にリアルタイムで同期されます。
              </p>
              <CreateAlbum />
            </div>
          </div>
        </div>

        <div class="card card-border bg-base-100">
          <div class="card-body">
            <h2 class="card-title">使い方</h2>
            <ol class="list-decimal pl-6 space-y-1">
              <li>「アルバムを作成」で部屋を作る</li>
              <li>
                ブラウザの URL（<code>/room/…</code>）を参加者に配る
              </li>
              <li>各自ブラウザで開いて写真・動画をアップロード</li>
              <li>他の人のアップロードは自動で表示される</li>
            </ol>
          </div>
        </div>
      </main>,
    );
  },
} satisfies BuildAction<"GET", typeof routes.home>;
