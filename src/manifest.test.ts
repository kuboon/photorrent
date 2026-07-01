import { assertEquals } from "@std/assert";
import {
  dedupe,
  type ManifestEntry,
  missing,
  ownedSummary,
} from "./manifest.ts";

function entry(hash: string, addedAt = 0): ManifestEntry {
  return { hash, owner: "p", size: 10, encName: "n", encThumb: "t", addedAt };
}

Deno.test("missing returns manifest entries not in the owned set", () => {
  const entries = [entry("a"), entry("b"), entry("c")];
  const owned = new Set(["b"]);
  assertEquals(missing(entries, owned).map((e) => e.hash), ["a", "c"]);
});

Deno.test("ownedSummary counts distinct hashes", () => {
  const entries = [entry("a"), entry("b"), entry("c"), entry("a")];
  const owned = new Set(["a", "c"]);
  assertEquals(ownedSummary(entries, owned), {
    total: 3,
    owned: 2,
    missing: 1,
  });
});

Deno.test("dedupe keeps earliest addedAt and sorts ascending", () => {
  const entries = [
    entry("b", 30),
    entry("a", 20),
    entry("b", 10),
    entry("a", 25),
  ];
  const result = dedupe(entries);
  assertEquals(result.map((e) => [e.hash, e.addedAt]), [["b", 10], ["a", 20]]);
});
