/** Tests for src/dev.ts — the `jx dev` entry: arg parsing, dist middleware, startDev boot. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createDistMiddleware, parseDevArgs, startDev } from "../src/dev.ts";

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
    // A relative pathname survives normalize() with its leading ".." intact
    const sneaky = await middleware(new Request("http://localhost/x"), {
      pathname: "../secret",
    } as URL);
    expect(sneaky).toBeNull();
    const post = await middleware(
      new Request("http://localhost/", { method: "POST" }),
      new URL("http://localhost/"),
    );
    expect(post).toBeNull();
  });
});

describe("startDev", () => {
  const SITE = resolve(import.meta.dir, "__test-dev-site__");
  const PLAIN = resolve(import.meta.dir, "__test-dev-plain__");
  const servers: { stop: () => void }[] = [];

  beforeAll(() => {
    for (const dir of [SITE, PLAIN]) {
      rmSync(dir, { force: true, recursive: true });
    }
    mkdirSync(join(SITE, "pages"), { recursive: true });
    writeFileSync(
      join(SITE, "project.json"),
      JSON.stringify({ build: { outDir: "./dist" }, name: "Dev Site" }),
      "utf8",
    );
    writeFileSync(
      join(SITE, "pages/index.json"),
      JSON.stringify({
        children: [{ children: ["Hello startDev"], tagName: "h1" }],
        title: "Home",
      }),
      "utf8",
    );
    mkdirSync(PLAIN, { recursive: true });
    writeFileSync(join(PLAIN, "readme.txt"), "plain root", "utf8");
  });

  afterAll(() => {
    for (const server of servers) {
      server.stop();
    }
    for (const dir of [SITE, PLAIN]) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("builds a site project and serves its pages with the reload client", async () => {
    const server = await startDev({ port: 0, root: SITE });
    servers.push(server);
    const res = await fetch(`http://localhost:${server.port}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Hello startDev");
    expect(html).toContain("EventSource('/__reload')");
  });

  test("prints build errors but still boots", async () => {
    const BROKEN = resolve(import.meta.dir, "__test-dev-broken__");
    rmSync(BROKEN, { force: true, recursive: true });
    mkdirSync(join(BROKEN, "pages"), { recursive: true });
    writeFileSync(
      join(BROKEN, "project.json"),
      JSON.stringify({ build: { outDir: "./dist" }, name: "Broken" }),
      "utf8",
    );
    writeFileSync(join(BROKEN, "pages/index.json"), "{ not json", "utf8");
    const errors: string[] = [];
    const origError = console.error;
    console.error = (msg: string) => errors.push(String(msg));
    try {
      const server = await startDev({ port: 0, root: BROKEN });
      servers.push(server);
    } finally {
      console.error = origError;
      rmSync(BROKEN, { force: true, recursive: true });
    }
    expect(errors.some((e) => e.includes("build error:"))).toBe(true);
  });

  test("boots a non-site root without the dist middleware", async () => {
    const server = await startDev({ port: 0, root: PLAIN });
    servers.push(server);
    const res = await fetch(`http://localhost:${server.port}/readme.txt`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("plain root");
  });
});
