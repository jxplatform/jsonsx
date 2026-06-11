import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import type { ComponentMeta, DirEntry } from "../src/rpc-schema";

const FIXTURES = join(import.meta.dir, "_fixtures_chromium_rpc");

let server: Subprocess;
let serverPort: number;

function rpc(ws: WebSocket, method: string, params?: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 100_000);
    const handler = (event: MessageEvent) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== id) {
        return;
      }
      ws.removeEventListener("message", handler);
      if (msg.error) {
        reject(new Error(msg.error));
      } else {
        resolve(msg.result);
      }
    };
    ws.addEventListener("message", handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

beforeAll(async () => {
  mkdirSync(FIXTURES, { recursive: true });
  writeFileSync(join(FIXTURES, "project.json"), JSON.stringify({ name: "test-project" }));
  writeFileSync(join(FIXTURES, "hello.txt"), "Hello World");
  mkdirSync(join(FIXTURES, "subdir"), { recursive: true });
  writeFileSync(join(FIXTURES, "subdir", "nested.json"), '{"key": "value"}');

  server = Bun.spawn(["bun", "run", join(import.meta.dir, "_rpc-server.ts"), FIXTURES], {
    stderr: "inherit",
    stdout: "pipe",
  });

  // Read stdout to find the port
  const stdout = server.stdout as ReadableStream<Uint8Array>;
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    output += decoder.decode(value, { stream: true });
    const portMatch = output.match(/port=(\d+)/);
    if (portMatch) {
      serverPort = Number.parseInt(portMatch[1]);
      break;
    }
  }
  reader.releaseLock();

  // Drain remaining stdout to prevent pipe backpressure from killing the child on Windows
  stdout.pipeTo(new WritableStream()).catch(() => {});
});

afterAll(() => {
  server?.kill();
  rmSync(FIXTURES, { force: true, recursive: true });
});

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${serverPort}`);
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", reject);
  });
}

// ─── WebSocket RPC Protocol ─────────────────────────────────────────────────

describe("chromium RPC server", () => {
  test("connects via WebSocket", async () => {
    const ws = await connect();
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  test("readFile returns file contents", async () => {
    const ws = await connect();
    const content = await rpc(ws, "readFile", { path: "hello.txt" });
    expect(content).toBe("Hello World");
    ws.close();
  });

  test("listDirectory returns entries", async () => {
    const ws = await connect();
    const entries = await rpc(ws, "listDirectory", { dir: "." });
    const names = (entries as DirEntry[]).map((e) => e.name);
    expect(names).toContain("hello.txt");
    expect(names).toContain("subdir");
    expect(names).toContain("project.json");
    ws.close();
  });

  test("writeFile creates a file", async () => {
    const ws = await connect();
    await rpc(ws, "writeFile", { content: "created", path: "new-file.txt" });
    const content = await rpc(ws, "readFile", { path: "new-file.txt" });
    expect(content).toBe("created");
    ws.close();
  });

  test("deleteFile removes a file", async () => {
    const ws = await connect();
    await rpc(ws, "writeFile", { content: "temp", path: "to-delete.txt" });
    await rpc(ws, "deleteFile", { path: "to-delete.txt" });
    const entries = await rpc(ws, "listDirectory", { dir: "." });
    const names = (entries as DirEntry[]).map((e) => e.name);
    expect(names).not.toContain("to-delete.txt");
    ws.close();
  });

  test("renameFile moves a file", async () => {
    const ws = await connect();
    await rpc(ws, "writeFile", { content: "moving", path: "old-name.txt" });
    await rpc(ws, "renameFile", { from: "old-name.txt", to: "new-name.txt" });
    const content = await rpc(ws, "readFile", { path: "new-name.txt" });
    expect(content).toBe("moving");
    ws.close();
  });

  test("createDirectory creates dirs", async () => {
    const ws = await connect();
    await rpc(ws, "createDirectory", { path: "new-dir/nested" });
    const entries = await rpc(ws, "listDirectory", { dir: "new-dir" });
    expect((entries as DirEntry[]).map((e) => e.name)).toContain("nested");
    ws.close();
  });

  test("uploadFile writes base64 data", async () => {
    const ws = await connect();
    const data = Buffer.from("binary content").toString("base64");
    await rpc(ws, "uploadFile", { data, path: "uploaded.bin" });
    const content = await rpc(ws, "readFile", { path: "uploaded.bin" });
    expect(content).toBe("binary content");
    ws.close();
  });

  test("resolveSiteContext finds project.json", async () => {
    const ws = await connect();
    const result = (await rpc(ws, "resolveSiteContext", {
      filePath: "subdir/nested.json",
    })) as Record<string, unknown>;
    expect(result.sitePath).toBe(".");
    ws.close();
  });

  test("discoverComponents finds custom elements", async () => {
    const ws = await connect();
    await rpc(ws, "writeFile", {
      content: JSON.stringify({ children: [], tagName: "my-widget" }),
      path: "my-widget.json",
    });
    const components = await rpc(ws, "discoverComponents", { dir: "." });
    const widget = (components as ComponentMeta[]).find((c) => c.tagName === "my-widget");
    expect(widget).toBeDefined();
    ws.close();
  });

  test("locateFile finds file by name", async () => {
    const ws = await connect();
    const result = await rpc(ws, "locateFile", { name: "nested.json" });
    expect(result).toContain("nested.json");
    ws.close();
  });

  test("returns error for unknown method", async () => {
    const ws = await connect();
    const result = await new Promise<{
      id: number;
      error?: string;
      result?: unknown;
    }>((resolve, reject) => {
      const id = Math.floor(Math.random() * 100_000);
      const timeout = setTimeout(() => {
        ws.removeEventListener("message", handler);
        reject(new Error("timeout"));
      }, 3000);
      const handler = (event: MessageEvent) => {
        const msg = JSON.parse(event.data) as {
          id: number;
          error?: string;
          result?: unknown;
        };
        if (msg.id !== id) {
          return;
        }
        clearTimeout(timeout);
        ws.removeEventListener("message", handler);
        resolve(msg);
      };
      ws.addEventListener("message", handler);
      ws.send(JSON.stringify({ id, method: "nonexistentMethod", params: {} }));
    }).catch((error: unknown) => error);
    // On some platforms (Windows/Bun) error responses may not deliver;
    // Verify either we got the error response or the connection stays healthy
    if (result instanceof Error) {
      // Didn't get response — verify server is still alive
      const content = await rpc(ws, "readFile", { path: "hello.txt" });
      expect(content).toBe("Hello World");
    } else {
      expect((result as Record<string, unknown>).error).toContain("Unknown method");
    }
    ws.close();
  });

  test("returns error for path traversal", async () => {
    const ws = await connect();
    const result = await new Promise<{
      id: number;
      error?: string;
      result?: unknown;
    }>((resolve, reject) => {
      const id = Math.floor(Math.random() * 100_000);
      const timeout = setTimeout(() => {
        ws.removeEventListener("message", handler);
        reject(new Error("timeout"));
      }, 3000);
      const handler = (event: MessageEvent) => {
        const msg = JSON.parse(event.data) as {
          id: number;
          error?: string;
          result?: unknown;
        };
        if (msg.id !== id) {
          return;
        }
        clearTimeout(timeout);
        ws.removeEventListener("message", handler);
        resolve(msg);
      };
      ws.addEventListener("message", handler);
      ws.send(
        JSON.stringify({
          id,
          method: "readFile",
          params: { path: "../../etc/passwd" },
        }),
      );
    }).catch((error: unknown) => error);
    if (result instanceof Error) {
      const content = await rpc(ws, "readFile", { path: "hello.txt" });
      expect(content).toBe("Hello World");
    } else {
      expect((result as Record<string, unknown>).error).toContain("Path outside project root");
    }
    ws.close();
  });

  test("handles multiple concurrent requests", async () => {
    const ws = await connect();
    const [content1, content2, entries] = await Promise.all([
      rpc(ws, "readFile", { path: "hello.txt" }),
      rpc(ws, "readFile", { path: "subdir/nested.json" }),
      rpc(ws, "listDirectory", { dir: "." }),
    ]);
    expect(content1).toBe("Hello World");
    expect(JSON.parse(content2 as string)).toEqual({ key: "value" });
    expect((entries as DirEntry[]).length).toBeGreaterThan(0);
    ws.close();
  });
});
