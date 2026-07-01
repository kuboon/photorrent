/**
 * Deno HTTP router (Remix v3 fetch-router). Serves static assets from
 * `public/` (hand-authored `style.css` / `favicon.svg` plus the bundled
 * `mod.js`) and maps the two HTTP routes to their controllers. The `/ws`
 * upgrade is handled in `server.ts`, ahead of this router.
 */

import { createRouter } from "@remix-run/fetch-router";
import { staticFiles } from "@remix-run/static-middleware";

import { homeAction } from "./controllers/home.ts";
import { iceAction } from "./controllers/ice.ts";
import { routes } from "./routes.ts";

export function createAppRouter() {
  const router = createRouter({
    middleware: [
      staticFiles(new URL("../public", import.meta.url).pathname),
    ],
  });

  router.get(routes.home, homeAction);
  router.get(routes.ice, iceAction);

  return router;
}
