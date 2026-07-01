/** Client boot: bundled to `public/mod.js` and loaded by the shell. */
import { main } from "./app.ts";

main().catch((err) => {
  console.error("[photo-swarm] failed to start", err);
  const s = document.getElementById("status");
  if (s) s.textContent = "failed to start";
});
