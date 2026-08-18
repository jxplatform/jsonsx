import { afterAll, describe, expect, test } from "bun:test";
import { createWatcher, RECONNECT_MS } from "../src/watch";
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

      // Read SSE frames until the reload arrives — a named fs event may be interleaved first.
      const decoder = new TextDecoder();
      let reloaded = false;
      while (!reloaded) {
        const { value } = (await Promise.race([
          reader.read(),
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error("timeout waiting for reload")), 3000);
          }),
        ])) as ReadableStreamReadResult<Uint8Array>;
        if (value && decoder.decode(value).includes("data: reload")) {
          reloaded = true;
        }
      }
      expect(reloaded).toBe(true);

      // The rebuild actually produced output
      const outputs = [...new Bun.Glob("*.js").scanSync({ cwd: join(dir, "out") })];
      expect(outputs.length).toBeGreaterThan(0);
      void reader.cancel();
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
      // The sidebar still receives a (named) fs event, but the preview must NOT be told to reload.
      if (raced !== "silent") {
        const text = new TextDecoder().decode(
          (raced as ReadableStreamReadResult<Uint8Array>).value ?? new Uint8Array(),
        );
        expect(text).not.toContain("data: reload");
      }
      void reader.cancel();
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
      // The sidebar still receives a (named) fs event, but the preview must NOT be told to reload.
      if (raced !== "silent") {
        const text = new TextDecoder().decode(
          (raced as ReadableStreamReadResult<Uint8Array>).value ?? new Uint8Array(),
        );
        expect(text).not.toContain("data: reload");
      }
      void reader.cancel();
      await watcher.close();
      await sleep(100);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("logs a preReload failure and still broadcasts the reload", async () => {
    const dir = setup("prereload-fail");
    try {
      const preReloadCalls: string[] = [];
      const logged: string[] = [];
      const origError = console.error;
      console.error = (...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      };
      try {
        const { handleSSE, watcher } = createWatcher(dir, [], {
          debounce: 10,
          preReload: (filename) => {
            preReloadCalls.push(filename);
            throw new Error("site build exploded");
          },
          reloadOnAnyChange: true,
        });
        const reader = (handleSSE().body as ReadableStream).getReader();
        await waitReady(watcher);

        writeFileSync(join(dir, "entry.js"), "export const changed = 1;");

        const decoder = new TextDecoder();
        let reloaded = false;
        while (!reloaded) {
          const { value } = (await Promise.race([
            reader.read(),
            new Promise((_, reject) => {
              setTimeout(() => reject(new Error("timeout waiting for reload")), 3000);
            }),
          ])) as ReadableStreamReadResult<Uint8Array>;
          if (value && decoder.decode(value).includes("data: reload")) {
            reloaded = true;
          }
        }
        expect(preReloadCalls).toEqual(["entry.js"]);
        expect(logged.some((l) => l.includes("preReload failed: site build exploded"))).toBe(true);
        void reader.cancel();
        await watcher.close();
        await sleep(100);
      } finally {
        console.error = origError;
      }
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("SSE heartbeats keep the stream alive and stop after the client disconnects", async () => {
    const dir = setup("sse-heartbeat");
    const realSetInterval = globalThis.setInterval;
    let heartbeat: (() => void) | undefined;
    globalThis.setInterval = ((cb: () => void, ms?: number) => {
      const timer = realSetInterval(() => {}, ms);
      if (ms === 15_000) {
        heartbeat = cb;
      }
      return timer;
    }) as unknown as typeof setInterval;
    try {
      const { handleSSE, watcher } = createWatcher(dir, [], { debounce: 10 });
      const reader = (handleSSE().body as ReadableStream).getReader();
      expect(heartbeat).toBeDefined();

      // The stream opens with its `retry:` field; the heartbeat is the frame after it.
      const opening = await reader.read();
      expect(new TextDecoder().decode(opening.value)).toBe(`retry: ${RECONNECT_MS}\n\n`);

      // While connected, the heartbeat comment frame reaches the client.
      heartbeat!();
      const { value } = await reader.read();
      expect(new TextDecoder().decode(value)).toContain(": heartbeat");

      // After the client goes away the enqueue fails and the interval clears itself.
      await reader.cancel();
      heartbeat!();

      await watcher.close();
      await sleep(50);
    } finally {
      globalThis.setInterval = realSetInterval;
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("swallows transient EINVAL watch errors but logs the rest", async () => {
    const dir = setup("watch-errors");
    try {
      const { watcher } = createWatcher(dir, [], { debounce: 10 });
      await waitReady(watcher);
      const emit = (watcher as unknown as { emit: (e: string, a: unknown) => void }).emit.bind(
        watcher,
      );

      const logged: unknown[][] = [];
      const origError = console.error;
      console.error = (...args: unknown[]) => {
        logged.push(args);
      };
      try {
        // EINVAL on transient Bun test dirs is expected churn — silently ignored.
        emit("error", new Error("EINVAL: invalid argument, watch"));
        expect(logged).toHaveLength(0);
        // Any other error is surfaced to the console.
        emit("error", new Error("EACCES: permission denied"));
        expect(logged).toHaveLength(1);
      } finally {
        console.error = origError;
      }
      await watcher.close();
      await sleep(50);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});

/*
 * The reconnection half of EventSource — `gap:sse-reconnect`. Everything asserted here is about
 * what the stream SAYS, not about what it buffers: there is no replay, and the third test is the
 * one that would fail if somebody added one.
 */
describe("createWatcher — SSE reconnection", () => {
  const decoder = new TextDecoder();

  async function readFrame(reader: ReadableStreamDefaultReader<Uint8Array>) {
    const { value } = (await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("timeout waiting for a frame")), 3000);
      }),
    ])) as ReadableStreamReadResult<Uint8Array>;
    return value === undefined ? "" : decoder.decode(value);
  }

  test("the stream opens by advertising its reconnection time", async () => {
    const dir = setup("sse-retry");
    try {
      const { handleSSE, watcher } = createWatcher(dir, [], { debounce: 10 });
      const reader = (handleSSE().body as ReadableStream).getReader();
      expect(await readFrame(reader)).toBe(`retry: ${RECONNECT_MS}\n\n`);
      void reader.cancel();
      await watcher.close();
      await sleep(50);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("a reload frame carries an id, which is what arms Last-Event-ID", async () => {
    const dir = setup("sse-id");
    try {
      const { broadcast, handleSSE, watcher } = createWatcher(dir, [], { debounce: 10 });
      const reader = (handleSSE().body as ReadableStream).getReader();
      await readFrame(reader); // The opening retry: field.
      broadcast();
      expect(await readFrame(reader)).toMatch(/^id: \d+\ndata: reload\n\n$/);
      void reader.cancel();
      await watcher.close();
      await sleep(50);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("a reconnecting client is pushed exactly one reload, and nothing is replayed", async () => {
    const dir = setup("sse-resume");
    try {
      const { broadcast, handleSSE, watcher } = createWatcher(dir, [], { debounce: 10 });
      // Three reloads the disconnected client never saw. A replay buffer would send three.
      broadcast();
      broadcast();
      broadcast();
      const reader = (
        handleSSE(new Request("http://127.0.0.1/__reload", { headers: { "Last-Event-ID": "1" } }))
          .body as ReadableStream
      ).getReader();
      expect(await readFrame(reader)).toBe(`retry: ${RECONNECT_MS}\n\n`);
      expect(await readFrame(reader)).toMatch(/^id: \d+\ndata: reload\n\n$/);
      // The next frame is the heartbeat, not a second reload — one reload subsumes all three.
      void reader.cancel();
      await watcher.close();
      await sleep(50);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("a first connection gets no reload — only a reconnection does", async () => {
    const dir = setup("sse-fresh");
    try {
      const { handleSSE, watcher } = createWatcher(dir, [], { debounce: 10 });
      const reader = (
        handleSSE(new Request("http://127.0.0.1/__reload")).body as ReadableStream
      ).getReader();
      expect(await readFrame(reader)).toBe(`retry: ${RECONNECT_MS}\n\n`);
      // Reloading a page that just loaded is a reload loop; an absent Last-Event-ID must be inert.
      const raced = await Promise.race([
        readFrame(reader),
        new Promise((r) => {
          setTimeout(() => r("__none__"), 300);
        }),
      ]);
      expect(raced).toBe("__none__");
      void reader.cancel();
      await watcher.close();
      await sleep(50);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});
