/**
 * Client bundling via `Deno.bundle` (unstable). Compiles `client/mod.ts` and
 * its imports (crypto/manifest/transfer) into `public/mod.js`, which the server
 * serves statically alongside the hand-authored `style.css` / `favicon.svg`.
 */

export async function buildJs(
  { minify = false, write = true }: { minify?: boolean; write?: boolean } = {},
) {
  return await Deno.bundle({
    entrypoints: [import.meta.resolve("../client/mod.ts")],
    outputDir: new URL("../public", import.meta.url).pathname,
    platform: "browser",
    sourcemap: "linked",
    minify,
    write,
  });
}

if (import.meta.main) {
  const result = await buildJs({ minify: Deno.args.includes("--minify") });
  console.log(
    "[bundler] built",
    result.outputFiles?.map((f) => f.path) ?? "public/mod.js",
  );
}
