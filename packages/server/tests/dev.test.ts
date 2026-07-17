/** Tests for src/dev.ts — the `jx dev` entry's argument parsing and dist middleware. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createDistMiddleware, parseDevArgs } from "../src/dev.ts";

describe("parseDevArgs", () => {
  test("defaults to cwd and port 3000", () => {
    expect(parseDevArgs([])).toEqual({ port: 3000, root: resolve(".") });
  });

  test("accepts --root and --port", () => {
    expect(parseDevArgs(["--root", "/tmp/site", "--port", "4000"])).toEqual({
      port: 4000,
      root: resolve("/tmp/site"),
    });
  });

  test("accepts a positional root", () => {
    expect(parseDevArgs(["/tmp/other"]).root).toBe(resolve("/tmp/other"));
  });

  test("ignores invalid ports", () => {
    expect(parseDevArgs(["--port", "nope"]).port).toBe(3000);
    expect(parseDevArgs(["--port", "-1"]).port).toBe(3000);
  });

  test("port 0 is allowed (pick a free port)", () => {
    expect(parseDevArgs(["--port", "0"]).port).toBe(0);
  });
});

describe("createDistMiddleware", () => {
  const TMP = resolve(import.meta.dir, "__test-dev-dist__");
  const middleware = createDistMiddleware(TMP);
  const get = (path: string) =>
    middleware(new Request(`http://localhost${path}`), new URL(`http://localhost${path}`));

  beforeAll(() => {
    rmSync(TMP, { force: true, recursive: true });
    mkdirSync(join(TMP, "dist/about"), { recursive: true });
    writeFileSync(join(TMP, "dist/index.html"), "<h1>Home</h1>", "utf8");
    writeFileSync(join(TMP, "dist/about/index.html"), "<h1>About</h1>", "utf8");
    writeFileSync(join(TMP, "dist/app.js"), "console.log(1)", "utf8");
  });

  afterAll(() => {
    rmSync(TMP, { force: true, recursive: true });
  });

  test("serves built pages with the live-reload client injected", async () => {
    const res = await get("/about/");
    expect(res?.status).toBe(200);
    const html = await res!.text();
    expect(html).toContain("<h1>About</h1>");
    expect(html).toContain("EventSource('/__reload')");
  });

  test("maps directory URLs without a trailing slash", async () => {
    const res = await get("/about");
    expect(await res!.text()).toContain("<h1>About</h1>");
  });

  test("serves non-html assets verbatim", async () => {
    const res = await get("/app.js");
    expect(await res!.text()).toBe("console.log(1)");
  });

  test("falls through for missing files, traversal, and non-GET", async () => {
    expect(await get("/nope/")).toBeNull();
    expect(await get("/../secret")).toBeNull();
    const post = await middleware(
      new Request("http://localhost/", { method: "POST" }),
      new URL("http://localhost/"),
    );
    expect(post).toBeNull();
  });
});
