import { iceResponse } from "../server/ice.ts";

/**
 * GET /api/ice — STUN plus (when a TURN token is configured) short-lived
 * Cloudflare TURN credentials minted server-side. Deno reads the token from the
 * process env.
 */
export const iceAction = {
  handler() {
    return iceResponse({
      TURN_KEY_ID: Deno.env.get("TURN_KEY_ID"),
      TURN_KEY_API_TOKEN: Deno.env.get("TURN_KEY_API_TOKEN"),
    });
  },
};
