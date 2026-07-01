import { get, route } from "@remix-run/fetch-router/routes";

/**
 * HTTP routes. The control-plane WebSocket (`/ws`) is handled outside the
 * router (Deno's `Deno.upgradeWebSocket`, or the Worker's Durable Object),
 * since fetch-router deals in Request/Response, not socket upgrades.
 */
export const routes = route({
  home: get("/"),
  ice: get("/api/ice"),
});
