/**
 * The static HTML shell served for every page. The interactive app is
 * inherently client-side — the party key lives only in the URL fragment (never
 * sent to the server), and transfers need WebRTC + IndexedDB — so the server
 * renders a skeleton and `/mod.js` takes over in the browser.
 *
 * Dependency-free on purpose: both the Deno controller and the Cloudflare
 * Worker import `shellHtml` and wrap it in their own `Response`.
 */

const APP_NAME = "photo-swarm";

export function shellHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="color-scheme" content="dark light" />
  <meta name="theme-color" content="#0b0d10" />
  <title>${APP_NAME}</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <link rel="stylesheet" href="/style.css" />
</head>
<body>
  <div id="app" data-app="${APP_NAME}">
    <header class="topbar">
      <span class="brand">📸 photo-swarm</span>
      <span class="status" id="status">connecting…</span>
    </header>
    <main class="stage">
      <p class="skeleton">Loading party…</p>
    </main>
  </div>
  <script type="module" src="/mod.js"></script>
</body>
</html>`;
}
