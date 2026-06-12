import { afterAll, describe, expect, test } from "bun:test";
import { createWatcher } from "../src/watch";
import { join, resolve } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

const FIXTURES = resolve(import.meta.dir, "_watch_gaps_fixtures");

function setup(name: string) {
  const dir = join(FIXTURES, name);
  rmSync(dir, { force: true, recursive: true });
  mkdirSync(join(dir, "out"), { recursive: true });
  writeFileSync(join(dir, "entry.js"), "export const v = 1;");
  return dir;
}

function waitReady(watcher: { on: (ev: string, cb: () => void) => unknown }) {
  return new Promise<void>((done) => {
    watcher.on("ready", () => done());
  });
}

function sleep(ms: number) {
  return new Promise((r) => {
    setTimeout(r, ms);
  });
}

afterAll(() => {
  rmSync(FIXTURES, { force: true, recursive: true });
});

describe("createWatcher — rebuild integration", () => {
  test("rebuilds matching entries and broadcasts on success", async () => {
    const dir = setup("rebuild-ok");
    try {
      const builds = [
        {
          entrypoints: [join(dir, "entry.js")],
          label: "app",
          match: /\.js$/,
          outdir: join(dir, "out"),
        },
      ];
      const { handleSSE, watcher } = createWatcher(dir, builds, { debounce: 10 });
      const reader = (handleSSE().body as ReadableStream).getReader();
      await waitReady(watcher);

      writeFileSync(join(dir, "entry.js"), `export const v = ${Date.now()};`);

      const { value } = (await Promise.race([
        reader.read(),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error("timeout waiting for reload")), 3000);
        }),
      ])) as ReadableStreamReadResult<Uint8Array>;
      expect(new TextDecoder().decode(value)).toContain("data: reload");

      // The rebuild actually produced output
      const outputs = [...new Bun.Glob("*.js").scanSync({ cwd: join(dir, "out") })];
      expect(outputs.length).toBeGreaterThan(0);
      reader.cancel();
      await watcher.close();
      await sleep(100);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("does not broadcast when the rebuild fails", async () => {
    const dir = setup("rebuild-fail");
    const originalBuild = Bun.build;
    let buildCalls = 0;
    // @ts-expect-error — intentional stub returning a failed BuildResult
    Bun.build = async () => {
      buildCalls += 1;
      return { logs: [], success: false };
    };
    try {
      const builds = [
        {
          entrypoints: [join(dir, "entry.js")],
          label: "app",
          match: /\.js$/,
          outdir: join(dir, "out"),
        },
      ];
      const { handleSSE, watcher } = createWatcher(dir, builds, { debounce: 10 });
      const reader = (handleSSE().body as ReadableStream).getReader();
      await waitReady(watcher);

      writeFileSync(join(dir, "entry.js"), "export const broken = 1;");

      // Wait for the watcher to process the change
      const start = Date.now();
      for (;;) {
        if (buildCalls > 0 || Date.now() - start >= 3000) {
          break;
        }
        await sleep(25);
      }
      expect(buildCalls).toBeGreaterThan(0);

      // No reload broadcast should arrive
      const raced = await Promise.race([
        reader.read(),
        new Promise<"silent">((r) => {
          setTimeout(() => r("silent"), 300);
        }),
      ]);
      expect(raced).toBe("silent");
      reader.cancel();
      await watcher.close();
      // Drain any pending debounce timer before restoring Bun.build
      await sleep(150);
    } finally {
      Bun.build = originalBuild;
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("does not broadcast when builds exist but none match", async () => {
    const dir = setup("no-match");
    try {
      const builds = [
        {
          entrypoints: [join(dir, "entry.js")],
          label: "css-only",
          match: /\.css$/,
          outdir: join(dir, "out"),
        },
      ];
      const { handleSSE, watcher } = createWatcher(dir, builds, { debounce: 10 });
      const reader = (handleSSE().body as ReadableStream).getReader();
      await waitReady(watcher);

      writeFileSync(join(dir, "entry.js"), "export const again = 2;");

      const raced = await Promise.race([
        reader.read(),
        new Promise<"silent">((r) => {
          setTimeout(() => r("silent"), 400);
        }),
      ]);
      expect(raced).toBe("silent");
      reader.cancel();
      await watcher.close();
      await sleep(100);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});
