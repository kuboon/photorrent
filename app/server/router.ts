/**
 * photorrent server — Remix v3 + Deno.
 *
 * Route definitions live in `./routes.ts`, each page/endpoint has a controller
 * under `./controllers/`, and this module wires middleware + maps routes to
 * controllers. `deno serve` runs the default export directly.
 */

import { createRouter } from "@remix-run/fetch-router";
import { staticFiles } from "@remix-run/static-middleware";

import { routes } from "./routes.ts";
import { homeAction } from "./controllers/home.tsx";
import { roomAction } from "./controllers/room.tsx";
import { wsAction } from "./controllers/ws.ts";
import { roomIndexAction } from "./controllers/api/room_index.ts";
import { thumbGetAction, thumbPutAction } from "./controllers/api/thumb.ts";

const router = createRouter({
  middleware: [
    staticFiles(new URL("../bundled", import.meta.url).pathname),
  ],
});

router.get(routes.home, homeAction);
router.get(routes.room, roomAction);
router.get(routes.ws, wsAction);
router.get(routes.roomIndex, roomIndexAction);
router.get(routes.thumbGet, thumbGetAction);
router.post(routes.thumbPut, thumbPutAction);

export default router;
