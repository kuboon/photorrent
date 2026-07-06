/**
 * Client-side JS/TSX bundling via `Deno.bundle` (unstable).
 *
 * Each entrypoint under `app/client/` is compiled to a same-named `.js`
 * (with linked sourcemap) under `app/bundled/`, which the server then serves
 * through `staticFiles`.
 *
 * Only genuinely-interactive `clientEntry` components (plus the `mod.ts` boot)
 * need to be entrypoints; everything they import (`lib/*`, the WS protocol
 * types) is inlined by the bundler.
 */

const CLIENT_ENTRIES = [
  "mod.ts",
  "room_page.tsx",
] as const;

export async function buildJs(
  { minify = false, write = true }: { minify?: boolean; write?: boolean } = {},
) {
  const entrypoints = CLIENT_ENTRIES.map((p) =>
    import.meta.resolve(`../client/${p}`)
  );
  return await Deno.bundle({
    entrypoints,
    outputDir: new URL("../bundled", import.meta.url).pathname,
    platform: "browser",
    sourcemap: "linked",
    minify,
    write,
  });
}
