import { describe, expect, test } from "bun:test";
import { RECONNECT_MS, SSE_SCRIPT, createWatcher, injectSSE, shouldIgnore } from "../src/watch";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURES = join(import.meta.dir, "_fixtures_watch");

/**
 * Consume the `retry:` field every stream opens with, so a test that cares about the NEXT frame
 * does not have to know it is there. Asserted rather than skipped: the reconnection contract is
 * cheap to keep true here and expensive to notice broken anywhere else.
 */
async function readOpeningRetry(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const opening = await reader.read();
  expect(new TextDecoder().decode(opening.value)).toBe(`retry: ${RECONNECT_MS}\n\n`);
}

// ─── injectSSE ──────────────────────────────────────────────────────────────

describe("injectSSE", () => {
  test("injects script before </body>", () => {
    const html = "<html><body><p>Hello</p></body></html>";
    const result = injectSSE(html);
    expect(result).toContain(SSE_SCRIPT);
    expect(result).toContain("</body>");
    expect(result.indexOf(SSE_SCRIPT)).toBeLessThan(result.indexOf("</body>"));
  });

  test("appends script when no </body>", () => {
    const html = "<p>Hello</p>";
    const result = injectSSE(html);
    expect(result).toContain(SSE_SCRIPT);
    expect(result).toBe(html + SSE_SCRIPT);
  });

  test("includes EventSource reload script", () => {
    expect(SSE_SCRIPT).toContain("EventSource");
    expect(SSE_SCRIPT).toContain("__reload");
    expect(SSE_SCRIPT).toContain("location.reload()");
  });
});

// ─── SSE_SCRIPT ─────────────────────────────────────────────────────────────

describe("SSE_SCRIPT", () => {
  test("is a valid script tag", () => {
    expect(SSE_SCRIPT).toContain("<script>");
    expect(SSE_SCRIPT).toContain("</script>");
  });
});

// ─── createWatcher ──────────────────────────────────────────────────────────

describe("createWatcher", () => {
  test("returns broadcast and handleSSE functions", () => {
    mkdirSync(FIXTURES, { recursive: true });
    try {
      const { broadcast, handleSSE } = createWatcher(FIXTURES, []);
      expect(typeof broadcast).toBe("function");
      expect(typeof handleSSE).toBe("function");
    } finally {
      rmSync(FIXTURES, { force: true, recursive: true });
    }
  });

  test("handleSSE returns a Response with event-stream content type", () => {
    mkdirSync(FIXTURES, { recursive: true });
    try {
      const { handleSSE } = createWatcher(FIXTURES, []);
      const response = handleSSE();
      expect(response).toBeInstanceOf(Response);
      expect(response.headers.get("Content-Type")).toBe("text/event-stream");
      expect(response.headers.get("Cache-Control")).toBe("no-cache");
    } finally {
      rmSync(FIXTURES, { force: true, recursive: true });
    }
  });

  test("broadcast sends data to SSE clients", async () => {
    mkdirSync(FIXTURES, { recursive: true });
    try {
      const { broadcast, handleSSE } = createWatcher(FIXTURES, []);
      const response = handleSSE();
      const reader = (response.body as ReadableStream).getReader();
      await readOpeningRetry(reader);

      broadcast();

      const { value } = await reader.read();
      const text = new TextDecoder().decode(value);
      expect(text).toContain("data: reload");
      void reader.cancel();
    } finally {
      rmSync(FIXTURES, { force: true, recursive: true });
    }
  });

  test("emits named fs events for file changes", async () => {
    const fsFix = join(import.meta.dir, "_fixtures_watch_fs");
    mkdirSync(fsFix, { recursive: true });
    const { handleSSE, watcher } = createWatcher(fsFix, [], { debounce: 10 });
    try {
      const response = handleSSE();
      const reader = (response.body as ReadableStream).getReader();
      await readOpeningRetry(reader);

      await new Promise<void>((resolve) => {
        watcher.on("ready", () => resolve());
      });

      writeFileSync(join(fsFix, "note.json"), `{"v":${Date.now()}}`);

      const { value } = (await Promise.race([
        reader.read(),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error("timeout")), 3000);
        }),
      ])) as ReadableStreamReadResult<Uint8Array>;
      const text = new TextDecoder().decode(value);
      expect(text).toContain("event: fs");
      expect(text).toContain("note.json");
      void reader.cancel();
    } finally {
      await watcher.close();
      rmSync(fsFix, { force: true, recursive: true });
    }
  });

  test("accepts custom ignore patterns", () => {
    mkdirSync(FIXTURES, { recursive: true });
    try {
      const { broadcast } = createWatcher(FIXTURES, [], {
        debounce: 10,
        ignore: ["**/temp/**"],
      });
      expect(typeof broadcast).toBe("function");
    } finally {
      rmSync(FIXTURES, { force: true, recursive: true });
    }
  });

  test("broadcasts on file change with reloadOnAnyChange", async () => {
    mkdirSync(FIXTURES, { recursive: true });
    try {
      const { handleSSE, watcher } = createWatcher(FIXTURES, [], {
        debounce: 10,
        reloadOnAnyChange: true,
      });
      const response = handleSSE();
      const reader = (response.body as ReadableStream).getReader();
      await readOpeningRetry(reader);

      // Wait for chokidar to be ready before writing
      await new Promise<void>((resolve) => {
        watcher.on("ready", () => resolve());
      });

      // Write a file to trigger the watcher
      writeFileSync(join(FIXTURES, "trigger.txt"), `change-${Date.now()}`);

      // Wait for debounce + watcher to fire
      const { value } = (await Promise.race([
        reader.read(),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error("timeout")), 3000);
        }),
      ])) as ReadableStreamReadResult<Uint8Array>;
      const text = new TextDecoder().decode(value);
      expect(text).toContain("data: reload");
      void reader.cancel();
    } finally {
      rmSync(FIXTURES, { force: true, recursive: true });
    }
  });
});

// ─── shouldIgnore ────────────────────────────────────────────────────────────

describe("shouldIgnore", () => {
  test("matches **/dir/** patterns", () => {
    expect(shouldIgnore("src/node_modules/foo.js", ["**/node_modules/**"])).toBe(true);
    expect(shouldIgnore("src/app.js", ["**/node_modules/**"])).toBe(false);
  });

  test("matches **/suffix patterns", () => {
    expect(shouldIgnore("src/bun.lockb", ["**/bun.lockb"])).toBe(true);
    expect(shouldIgnore("bun.lockb", ["**/bun.lockb"])).toBe(true);
    expect(shouldIgnore("src/other.js", ["**/bun.lockb"])).toBe(false);
  });

  test("falls back to substring includes for plain patterns", () => {
    expect(shouldIgnore("src/temp/file.js", ["temp"])).toBe(true);
    expect(shouldIgnore("src/other/file.js", ["temp"])).toBe(false);
  });
});
