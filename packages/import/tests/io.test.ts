/**
 * The local write sink. The interesting property is that a project-relative, forward-slashed path
 * is what every phase hands it — so nested routes have to create their own parents, and the sink
 * must never be handed (or produce) an absolute one.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalIo } from "../src/io.ts";

async function freshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "jx-import-io-"));
}

describe("createLocalIo", () => {
  test("joins a project-relative path onto its root and creates the parents", async () => {
    const dir = await freshDir();
    try {
      const io = createLocalIo(dir);
      await io.write("pages/blog/deep/post.json", '{"tagName":"div"}\n');

      expect(await readFile(join(dir, "pages", "blog", "deep", "post.json"), "utf8")).toBe(
        '{"tagName":"div"}\n',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("writes binary payloads byte for byte", async () => {
    const dir = await freshDir();
    try {
      const io = createLocalIo(dir);
      await io.write("public/assets/images/hero.png", new Uint8Array([137, 80, 78, 71, 0, 255]));

      const bytes = new Uint8Array(await readFile(join(dir, "public/assets/images/hero.png")));
      expect([...bytes]).toEqual([137, 80, 78, 71, 0, 255]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("mkdir creates an empty directory, which is what the seeded project shape needs", async () => {
    const dir = await freshDir();
    try {
      const io = createLocalIo(dir);
      await io.mkdir?.("components");
      const entry = await stat(join(dir, "components"));
      expect(entry.isDirectory()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an overwrite replaces the file rather than appending to it", async () => {
    const dir = await freshDir();
    try {
      const io = createLocalIo(dir);
      await io.write("project.json", "first");
      await io.write("project.json", "second");
      expect(await readFile(join(dir, "project.json"), "utf8")).toBe("second");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a leading slash or a doubled separator does not escape the root", async () => {
    const dir = await freshDir();
    try {
      const io = createLocalIo(dir);
      await io.write("/pages//index.json", "x");
      expect(await readFile(join(dir, "pages", "index.json"), "utf8")).toBe("x");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
