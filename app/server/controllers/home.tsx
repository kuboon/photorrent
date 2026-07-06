/**
 * GET / — landing page with a "create album" action.
 *
 * A fresh, shareable roomId is minted server-side on each load and linked
 * directly, so entering a room needs no client JS: clicking navigates to
 * `/room/<id>`, whose URL is the thing you hand out to party guests.
 */

import type { BuildAction } from "@remix-run/fetch-router";
import type { routes } from "../routes.ts";
import { renderPage } from "../utils/render.tsx";

/** URL-friendly random room id (~16 base64url chars). */
function newRoomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export const homeAction = {
  handler(context) {
    const roomId = newRoomId();
    return renderPage(
      context,
      <main class="mx-auto w-full max-w-2xl p-8 space-y-6">
        <div class="hero bg-base-200 rounded-box">
          <div class="hero-content text-center">
            <div>
              <h1 class="text-3xl font-bold">📸 photorrent</h1>
              <p class="py-4">
                パーティの写真・動画をみんなで共有。アルバムを作って URL
                を配るだけ。
                アップした写真は参加者全員にリアルタイムで同期されます。
              </p>
              <a class="btn btn-primary btn-lg" href={`/room/${roomId}`}>
                アルバムを作成
              </a>
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
