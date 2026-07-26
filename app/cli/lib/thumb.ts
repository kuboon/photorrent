/**
 * Thumbnail bytes for the shared index.
 *
 * The browser generates real thumbnails with a canvas; Deno has no DOM, and a
 * real image/video thumbnail would need a native image lib or ffmpeg — which
 * would break the dependency-free single-binary build. So the CLI POSTs a
 * neutral SVG placeholder (a type icon + extension label) so its files still
 * appear in everyone's gallery and sync/transfer normally.
 */

/** Placeholder edge length, mirroring the web client's fallback. */
export const THUMB_EDGE = 256;

export interface Thumb {
  bytes: Uint8Array<ArrayBuffer>;
  contentType: string;
  width: number;
  height: number;
}

/** An emoji icon representing a file's kind, from its MIME type. */
export function iconForMime(mime: string): string {
  if (mime.startsWith("image/")) return "🖼️";
  if (mime.startsWith("video/")) return "🎬";
  if (mime.startsWith("audio/")) return "🎵";
  if (mime === "application/pdf") return "📕";
  if (
    /zip|tar|gzip|compressed|7z|rar|x-xz|zstd/.test(mime)
  ) return "🗜️";
  return "📄";
}

/** Escape text for safe inclusion in the SVG placeholder. */
function esc(s: string): string {
  return s.replace(
    /[&<>]/g,
    (c) => c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;",
  );
}

/** A tiny neutral SVG thumbnail: a type icon plus the file's extension. */
export function placeholderThumb(mime: string, filename = ""): Thumb {
  const icon = iconForMime(mime);
  const dot = filename.lastIndexOf(".");
  const ext = dot > 0 ? filename.slice(dot + 1).toUpperCase().slice(0, 5) : "";
  const label = ext
    ? `<text x="50%" y="72%" font-size="40" fill="#6b7280" text-anchor="middle" font-family="sans-serif">${
      esc(ext)
    }</text>`
    : "";
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${THUMB_EDGE}" height="${THUMB_EDGE}">` +
    `<rect width="100%" height="100%" fill="#e5e7eb"/>` +
    `<text x="50%" y="46%" font-size="96" text-anchor="middle" dominant-baseline="central">${icon}</text>` +
    label +
    `</svg>`;
  // Copy into a fresh ArrayBuffer-backed view so it satisfies BlobPart/BodyInit.
  return {
    bytes: new Uint8Array(new TextEncoder().encode(svg)),
    contentType: "image/svg+xml",
    width: THUMB_EDGE,
    height: THUMB_EDGE,
  };
}
