/**
 * ICE server list for `GET /api/ice`. Always includes a public STUN server;
 * when a Cloudflare Realtime TURN token is configured, mints short-lived TURN
 * credentials server-side so the secret never reaches the browser.
 *
 * TURN is fallback only (used when direct/STUN fails). Billing is metered
 * egress with a generous free tier; treat it as metered, not unlimited.
 */

const STUN: RTCIceServer = { urls: "stun:stun.cloudflare.com:3478" };

/** Env vars needed to mint Cloudflare TURN credentials. */
export interface IceEnv {
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
}

const TTL_SECONDS = 12 * 60 * 60; // short-lived; refreshed per fetch.

export async function getIceServers(env: IceEnv): Promise<RTCIceServer[]> {
  const keyId = env.TURN_KEY_ID;
  const token = env.TURN_KEY_API_TOKEN;
  if (!keyId || !token) return [STUN];

  try {
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ttl: TTL_SECONDS }),
      },
    );
    if (!res.ok) return [STUN];
    const body = await res.json() as {
      iceServers?: RTCIceServer | RTCIceServer[];
    };
    const turn = body.iceServers;
    if (!turn) return [STUN];
    return Array.isArray(turn) ? [STUN, ...turn] : [STUN, turn];
  } catch {
    return [STUN];
  }
}

/** Build the JSON response for `GET /api/ice`. */
export async function iceResponse(env: IceEnv): Promise<Response> {
  const iceServers = await getIceServers(env);
  return new Response(JSON.stringify({ iceServers }), {
    headers: {
      "Content-Type": "application/json",
      // Creds are short-lived; let the browser reuse them briefly.
      "Cache-Control": "private, max-age=600",
    },
  });
}
