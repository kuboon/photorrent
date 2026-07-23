/**
 * Cross-compile the CLI to standalone executables via `deno compile`.
 *
 * Emits one binary per target under `dist/`. No native dependencies (relay-only
 * transfer, SVG placeholder thumbnails), so every target compiles cleanly and
 * the result is a single self-contained file per OS.
 *
 *   deno task cli:build            # all targets
 *   deno task cli:build linux      # a subset by keyword
 */

const TARGETS: Record<string, { target: string; out: string }> = {
  "linux-x64": { target: "x86_64-unknown-linux-gnu", out: "photorrent" },
  "linux-arm64": { target: "aarch64-unknown-linux-gnu", out: "photorrent" },
  "windows-x64": { target: "x86_64-pc-windows-msvc", out: "photorrent.exe" },
  "windows-arm64": { target: "aarch64-pc-windows-msvc", out: "photorrent.exe" },
  "macos-x64": { target: "x86_64-apple-darwin", out: "photorrent" },
  "macos-arm64": { target: "aarch64-apple-darwin", out: "photorrent" },
};

const PERMS = ["--allow-read", "--allow-write", "--allow-net"];

async function build(): Promise<void> {
  const filter = Deno.args[0];
  const names = Object.keys(TARGETS).filter((n) =>
    !filter || n.includes(filter)
  );
  if (names.length === 0) {
    console.error(
      `no target matches "${filter}". known: ${
        Object.keys(TARGETS).join(", ")
      }`,
    );
    Deno.exit(1);
  }

  for (const name of names) {
    const { target, out } = TARGETS[name];
    const outPath = `dist/${name}/${out}`;
    console.error(`building ${name} → ${outPath}`);
    const cmd = new Deno.Command(Deno.execPath(), {
      args: [
        "compile",
        ...PERMS,
        "--target",
        target,
        "--output",
        outPath,
        "main.ts",
      ],
      stdout: "inherit",
      stderr: "inherit",
    });
    const { code } = await cmd.output();
    if (code !== 0) {
      console.error(`build failed for ${name} (exit ${code})`);
      Deno.exit(code);
    }
  }
  console.error("done.");
}

if (import.meta.main) {
  await build();
}
