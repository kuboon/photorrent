/**
 * Bundle the Worker (with its jsr:/npm: deps and the reused server modules)
 * into a single ESM at `dist/worker.js`, which `wrangler` then deploys/serves.
 * This lets the Deno-style imports (jsr:, import map) resolve via Deno's
 * resolver rather than wrangler/esbuild, which can't see them.
 */

if (import.meta.main) {
  const result = await Deno.bundle({
    entrypoints: [import.meta.resolve("./worker.ts")],
    outputDir: new URL("./dist", import.meta.url).pathname,
    platform: "browser",
    format: "esm",
    sourcemap: "linked",
    write: true,
  });
  console.log("[worker] bundle complete", {
    success: result.success,
    errors: result.errors,
  });
  if (!result.success) Deno.exit(1);
}
