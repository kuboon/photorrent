import { assert, assertEquals } from "@std/assert";
import { FolderStore } from "./body_store.ts";
import { contentHash } from "./hash.ts";

/** In-memory fake of the File System Access directory handle we use. */
class FakeFileHandle {
  kind = "file" as const;
  constructor(public name: string, public data: Uint8Array) {}
  getFile(): Promise<File> {
    return Promise.resolve(
      new File([new Uint8Array(this.data)], this.name, {
        type: guessType(this.name),
      }),
    );
  }
  createWritable() {
    const chunks: BlobPart[] = [];
    return Promise.resolve({
      write: (d: Blob | BufferSource) => {
        chunks.push(d as BlobPart);
        return Promise.resolve();
      },
      close: async () => {
        this.data = new Uint8Array(await new Blob(chunks).arrayBuffer());
      },
    });
  }
}

function guessType(name: string): string {
  return name.endsWith(".jpg") ? "image/jpeg" : "";
}

class FakeDirHandle {
  files = new Map<string, FakeFileHandle>();
  add(name: string, data: Uint8Array) {
    this.files.set(name, new FakeFileHandle(name, data));
  }
  async *entries(): AsyncIterableIterator<[string, { kind: string }]> {
    for (const [name, h] of this.files) yield [name, h];
  }
  async *keys(): AsyncIterableIterator<string> {
    for (const name of this.files.keys()) yield name;
  }
  getFileHandle(
    name: string,
    opts?: { create?: boolean },
  ): Promise<FakeFileHandle> {
    let h = this.files.get(name);
    if (!h) {
      if (!opts?.create) return Promise.reject(new Error("not found"));
      h = new FakeFileHandle(name, new Uint8Array());
      this.files.set(name, h);
    }
    return Promise.resolve(h);
  }
}

// deno-lint-ignore no-explicit-any
const asDir = (d: FakeDirHandle) => d as any;

Deno.test("FolderStore.open scans and content-addresses existing media", async () => {
  const dir = new FakeDirHandle();
  const a = new TextEncoder().encode("photo-a");
  const b = new TextEncoder().encode("photo-b");
  dir.add("a.jpg", a);
  dir.add("b.jpg", b);
  dir.add("notes.txt", new TextEncoder().encode("skip me")); // non-media

  const { store, held } = await FolderStore.open(asDir(dir));
  assertEquals(held.length, 2); // txt skipped
  const idA = await contentHash(new Blob([a]));
  assert(held.some((h) => h.id === idA && h.name === "a.jpg"));
  assertEquals((await store.get(idA))?.size, a.length);
  assert(await store.has(idA));
});

Deno.test("FolderStore.save writes a new body and can read it back", async () => {
  const dir = new FakeDirHandle();
  const { store } = await FolderStore.open(asDir(dir));
  const bytes = new TextEncoder().encode("downloaded");
  const id = await contentHash(new Blob([bytes]));

  assertEquals(await store.save(id, new Blob([bytes]), "dl.jpg"), true);
  assert(await store.has(id));
  const got = await store.get(id);
  assertEquals(new Uint8Array(await got!.arrayBuffer()), bytes);
});

Deno.test("FolderStore.save de-dupes filenames on collision", async () => {
  const dir = new FakeDirHandle();
  dir.add("pic.jpg", new TextEncoder().encode("existing"));
  const { store } = await FolderStore.open(asDir(dir));

  const bytes = new TextEncoder().encode("new one");
  const id = await contentHash(new Blob([bytes]));
  await store.save(id, new Blob([bytes]), "pic.jpg");

  // Written under a disambiguated name, both present in the directory.
  assert(dir.files.has("pic.jpg"));
  assert(dir.files.has("pic (1).jpg"));
});

Deno.test("FolderStore.save is a no-op when the id is already held", async () => {
  const dir = new FakeDirHandle();
  const bytes = new TextEncoder().encode("same");
  dir.add("orig.jpg", bytes);
  const { store } = await FolderStore.open(asDir(dir));
  const id = await contentHash(new Blob([bytes]));

  assertEquals(await store.save(id, new Blob([bytes]), "copy.jpg"), true);
  assert(!dir.files.has("copy.jpg")); // not rewritten
});
