/**
 * Thumbnail bytes for the shared index.
 *
 * The browser generates real thumbnails with a canvas; Deno has no DOM, and a
 * real image/video thumbnail would need a native image lib or ffmpeg — which
 * would break the dependency-free single-binary build. So the CLI POSTs the
 * same neutral SVG placeholder the web client falls back to, so its files still
 * appear in everyone's gallery (with a 🖼️/🎬 icon) and sync/transfer normally.
 */

/** Placeholder edge length, mirroring the web client's fallback. */
export const THUMB_EDGE = 256;

export interface Thumb {
  bytes: Uint8Array<ArrayBuffer>;
  contentType: string;
  width: number;
  height: number;
}

/** A tiny neutral SVG thumbnail, keyed to image vs video by MIME. */
export function placeholderThumb(mime: string): Thumb {
  const icon = mime.startsWith("video/") ? "🎬" : "🖼️";
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${THUMB_EDGE}" height="${THUMB_EDGE}">` +
    `<rect width="100%" height="100%" fill="#e5e7eb"/>` +
    `<text x="50%" y="50%" font-size="96" text-anchor="middle" dominant-baseline="central">${icon}</text>` +
    `</svg>`;
  // Copy into a fresh ArrayBuffer-backed view so it satisfies BlobPart/BodyInit.
  return {
    bytes: new Uint8Array(new TextEncoder().encode(svg)),
    contentType: "image/svg+xml",
    width: THUMB_EDGE,
    height: THUMB_EDGE,
  };
}
