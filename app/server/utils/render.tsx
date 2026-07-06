/**
 * Render helpers for the shell + frame content (mirrors the reference app).
 *
 * `renderPage(context, fragment)` emits:
 *   - just the fragment, when the request carries the `rmx-frame: 1` header
 *     (set by the server-side `resolveFrame` below and the client `run()`);
 *   - the full {@link Document} shell otherwise, with the current URL as the
 *     initial frame src.
 */

import type { RemixNode } from "@remix-run/ui";
import { renderToStream } from "@remix-run/ui/server";
import type { RequestContext, Router } from "@remix-run/fetch-router";
import { createHtmlResponse } from "@remix-run/response/html";

import { Document } from "../ui/document.tsx";

export const FRAME_HEADER = "rmx-frame";

export const isFrameRequest = (request: Request): boolean =>
  request.headers.get(FRAME_HEADER) === "1";

export function renderFragment(body: RemixNode, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "text/html; charset=utf-8");
  }
  return new Response(renderToStream(body), { ...init, headers });
}

export function renderPage(
  context: RequestContext,
  fragment: RemixNode,
): Response {
  if (isFrameRequest(context.request)) {
    return renderFragment(fragment);
  }
  return renderShell(context);
}

export function renderShell(context: RequestContext): Response {
  const { request, router } = context;
  const url = new URL(request.url);
  const initialSrc = url.pathname + url.search;

  const stream = renderToStream(<Document initialSrc={initialSrc} />, {
    frameSrc: request.url,
    resolveFrame: (src, target, frameContext) =>
      resolveFrameViaRouter(router, request, src, target, frameContext),
  });
  return createHtmlResponse(stream);
}

async function resolveFrameViaRouter(
  router: Router,
  request: Request,
  src: string,
  target?: string,
  frameContext?: { currentFrameSrc?: string },
) {
  const base = frameContext?.currentFrameSrc ?? request.url;
  const url = new URL(src, base);

  const headers = new Headers({
    accept: "text/html",
    [FRAME_HEADER]: "1",
  });
  if (target) headers.set("rmx-target", target);

  const response = await router.fetch(
    new Request(url, { method: "GET", headers, signal: request.signal }),
  );
  return response.body!;
}
