/**
 * Client-side thumbnail generation.
 *
 * Images: decode → draw scaled into a canvas → JPEG blob.
 * Videos: grab a frame near the start → same canvas path.
 *
 * Everything is guarded/timed so a weird codec or decode failure yields a
 * generic placeholder rather than blocking the upload — the index entry still
 * syncs, just with a fallback thumbnail.
 */

export interface Thumbnail {
  blob: Blob;
  width: number;
  height: number;
}

/** Longest edge of a generated thumbnail, in pixels. */
const MAX_EDGE = 256;
const VIDEO_TIMEOUT_MS = 5000;

export async function generateThumbnail(file: File): Promise<Thumbnail> {
  try {
    if (file.type.startsWith("image/")) return await fromImage(file);
    if (file.type.startsWith("video/")) return await fromVideo(file);
  } catch (err) {
    console.warn("[thumbnail] generation failed, using placeholder", err);
  }
  return placeholder(file);
}

function scaledSize(w: number, h: number): { width: number; height: number } {
  if (w <= MAX_EDGE && h <= MAX_EDGE) return { width: w, height: h };
  const scale = MAX_EDGE / Math.max(w, h);
  return { width: Math.round(w * scale), height: Math.round(h * scale) };
}

async function drawToBlob(
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
): Promise<Thumbnail> {
  const { width, height } = scaledSize(srcW, srcH);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  ctx.drawImage(source, 0, 0, width, height);
  const blob = await canvasToBlob(canvas);
  return { blob, width, height };
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
      "image/jpeg",
      0.7,
    );
  });
}

async function fromImage(file: File): Promise<Thumbnail> {
  const bitmap = await createImageBitmap(file);
  try {
    return await drawToBlob(bitmap, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

function fromVideo(file: File): Promise<Thumbnail> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "metadata";
    video.src = url;

    const cleanup = () => {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("video thumbnail timeout"));
    }, VIDEO_TIMEOUT_MS);

    video.onloadedmetadata = () => {
      // Seek a little in so we skip a possible black first frame.
      video.currentTime = Math.min(1, (video.duration || 2) / 2);
    };
    video.onseeked = async () => {
      try {
        const thumb = await drawToBlob(
          video,
          video.videoWidth,
          video.videoHeight,
        );
        cleanup();
        resolve(thumb);
      } catch (err) {
        cleanup();
        reject(err);
      }
    };
    video.onerror = () => {
      cleanup();
      reject(new Error("video decode error"));
    };
  });
}

/** A tiny neutral SVG thumbnail used when real generation fails. */
function placeholder(file: File): Thumbnail {
  const icon = file.type.startsWith("video/") ? "🎬" : "🖼️";
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${MAX_EDGE}" height="${MAX_EDGE}">` +
    `<rect width="100%" height="100%" fill="#e5e7eb"/>` +
    `<text x="50%" y="50%" font-size="96" text-anchor="middle" dominant-baseline="central">${icon}</text>` +
    `</svg>`;
  const blob = new Blob([svg], { type: "image/svg+xml" });
  return { blob, width: MAX_EDGE, height: MAX_EDGE };
}
