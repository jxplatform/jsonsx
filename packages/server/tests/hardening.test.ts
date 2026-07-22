import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createDevServer } from "../src/server.ts";

// Integration tests for the dev-server hardening: loopback bind, Origin/Host gate on privileged
// Routes, activate containment, and $src / static-path traversal containment. No fetch mock here —
// A real server is started in-process and driven with real fetch.

const FIXTURES = resolve(import.meta.dir, "_hardening_fixtures");
const ROOT = join(FIXTURES, "served-root");
const OUTSIDE = join(FIXTURES, "outside");

let server: ReturnType<typeof Bun.serve> | Awaited<ReturnType<typeof createDevServer>>;
let base = "";

beforeAll(async () => {
  rmSync(FIXTURES, { force: true, recursive: true });
  mkdirSync(ROOT, { recursive: true });
  mkdirSync(OUTSIDE, { recursive: true });
  writeFileSync(join(ROOT, "index.html"), "<html>root</html>");
  writeFileSync(join(OUTSIDE, "secret.txt"), "TOP-SECRET");
  server = await createDevServer({
    root: ROOT,
    port: 0,
    builds: [],
    watch: false,
    studio: true,
  });
  base = `http://127.0.0.1:${(server as { port: number }).port}`;
});

afterAll(() => {
  (server as { stop?: () => void }).stop?.();
  rmSync(FIXTURES, { force: true, recursive: true });
});

const status = (path: string, init?: RequestInit) => fetch(base + path, init).then((r) => r.status);

describe("dev-server hardening", () => {
  test("serves a file under the root", async () => {
    const res = await fetch(`${base}/index.html`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("root");
  });

  test("rejects an over-encoded traversal (%252e%252e)", async () => {
    expect(await status("/%252e%252e/%252e%252e/outside/secret.txt")).toBe(404);
  });

  test("does not leak a file outside the root via a normalized ../ path", async () => {
    // New URL() collapses literal ../, so this resolves under the root and 404s — it must never
    // Return the OUTSIDE secret.
    const res = await fetch(`${base}/../outside/secret.txt`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("TOP-SECRET");
  });

  test("gates /__jx_resolve__ against a cross-origin POST", async () => {
    expect(
      await status("/__jx_resolve__", {
        method: "POST",
        headers: { origin: "https://evil.example", "content-type": "application/json" },
        body: JSON.stringify({ $src: "./x.js" }),
      }),
    ).toBe(403);
  });

  test("gates /__jx_server__ against a rebinding Host header", async () => {
    expect(
      await status("/__jx_server__", {
        method: "POST",
        headers: { host: "evil.example", "content-type": "application/json" },
        body: JSON.stringify({ $src: "./x.js", $export: "run" }),
      }),
    ).toBe(403);
  });

  test("allows a same-origin (no Origin) POST past the gate (400 for the missing $src, not 403)", async () => {
    expect(
      await status("/__jx_resolve__", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    ).toBe(400);
  });

  test("rejects a $src that escapes the project root", async () => {
    expect(
      await status("/__jx_resolve__", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ $src: "../../../../etc/passwd", $prototype: "Function" }),
      }),
    ).toBe(403);
  });

  test("refuses /__studio/activate to a directory outside the served root", async () => {
    const res = await fetch(`${base}/__studio/activate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root: OUTSIDE }),
    });
    expect(res.status).toBe(403);
  });

  test("permits /__studio/activate within the served root", async () => {
    const res = await fetch(`${base}/__studio/activate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root: "." }),
    });
    expect(res.status).toBe(200);
  });
});
