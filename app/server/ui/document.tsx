/**
 * Document — the persistent HTML shell (nav + `<Frame name="content">`).
 *
 * Client-side, `run()` (bundled from app/client/mod.ts) turns clicks on
 * `<a rmx-target="content">` into frame reloads instead of full navigations.
 */

import { Frame, type Handle } from "@remix-run/ui";
import { routes } from "../routes.ts";

type DocumentProps = {
  initialSrc: string;
};

export function Document(handle: Handle<DocumentProps>) {
  return () => (
    <html lang="ja">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>photorrent</title>
        <link rel="icon" href="data:image/png;base64,iVBORw0KGgo=" />
        <script async type="module" src="/mod.js"></script>
        <link rel="stylesheet" href="/style.css" />
      </head>
      <body class="min-h-screen bg-base-100 text-base-content">
        <header class="navbar bg-base-200 shadow-sm">
          <div class="navbar-start">
            <a
              class="btn btn-ghost text-xl"
              href={routes.home.href()}
              rmx-target="content"
            >
              📸 photorrent
            </a>
          </div>
        </header>
        <Frame
          name="content"
          src={handle.props.initialSrc}
          fallback={
            <main class="mx-auto w-full max-w-3xl p-8">
              <p>Loading…</p>
            </main>
          }
        />
      </body>
    </html>
  );
}
