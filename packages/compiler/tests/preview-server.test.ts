/** Tests for src/site/preview-server.ts — the `jx preview` static server. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { resolvePreviewFile, startPreviewServer } from "../src/site/preview-server.ts";

const TMP = resolve(import.meta.dir, "__test-preview__");
let server: Server;
let base: string;

beforeAll(() => {
  rmSync(TMP, { force: true, recursive: true });
  mkdirSync(join(TMP, "about"), { recursive: true });
  writeFileSync(join(TMP, "index.html"), "<h1>Home</h1>", "utf8");
  writeFileSync(join(TMP, "about/index.html"), "<h1>About</h1>", "utf8");
  writeFileSync(join(TMP, "style.css"), "body{}", "utf8");
  writeFileSync(join(TMP, "404.html"), "<h1>Missing</h1>", "utf8");
  writeFileSync(join(TMP, "readme.md"), "# Hi", "utf8");
  writeFileSync(join(TMP, "data.yaml"), "a: 1\n", "utf8");

  server = startPreviewServer(TMP, 0);
  const { port } = server.address() as AddressInfo;
  base = `http://localhost:${port}`;
});

afterAll(() => {
  server.close();
  rmSync(TMP, { force: true, recursive: true });
});

describe("resolvePreviewFile", () => {
  test("maps / and directory URLs to index.html", () => {
    expect(resolvePreviewFile(TMP, "/")).toBe(join(TMP, "index.html"));
    expect(resolvePreviewFile(TMP, "/about/")).toBe(join(TMP, "about/index.html"));
    expect(resolvePreviewFile(TMP, "/about")).toBe(join(TMP, "about/index.html"));
  });

  test("serves plain files and rejects traversal", () => {
    expect(resolvePreviewFile(TMP, "/style.css")).toBe(join(TMP, "style.css"));
    expect(resolvePreviewFile(TMP, "/../secret")).toBeNull();
    expect(resolvePreviewFile(TMP, "/missing")).toBeNull();
  });

  test("rejects candidates that escape the dist directory", () => {
    // A relative pathname normalizes to a parent-directory candidate outside dist.
    expect(resolvePreviewFile(TMP, "..")).toBeNull();
    expect(resolvePreviewFile(TMP, "../secret")).toBeNull();
    // Windows-style separators only turn into traversal AFTER the normalize step.
    expect(resolvePreviewFile(TMP, String.raw`/..\secret`)).toBeNull();
  });
});

describe("startPreviewServer", () => {
  test("serves pages with html content type", async () => {
    const res = await fetch(`${base}/about/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toBe("<h1>About</h1>");
  });

  test("serves extensionless routes without a trailing slash", async () => {
    const res = await fetch(`${base}/about`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<h1>About</h1>");
  });

  test("serves assets with their mime type", async () => {
    const res = await fetch(`${base}/style.css`);
    expect(res.headers.get("content-type")).toContain("text/css");
  });

  /*
   * The two extensions Jx has an opinion about. `text/markdown` alone does not say WHICH markdown
   * (RFC 7763/7764), and `text/yaml` is the spelling RFC 9512 §5 asks implementations to retire —
   * so neither the platform default nor "no entry, send octet-stream" is the right answer here.
   */
  test("serves markdown with the variant that names its flavour", async () => {
    const res = await fetch(`${base}/readme.md`);
    const type = res.headers.get("content-type") ?? "";
    expect(type).toContain("text/markdown");
    expect(type).toContain("variant=GFM");
  });

  test("serves yaml as application/yaml, not text/yaml or a download", async () => {
    const res = await fetch(`${base}/data.yaml`);
    const type = res.headers.get("content-type") ?? "";
    expect(type).toContain("application/yaml");
    expect(type).not.toContain("octet-stream");
  });

  test("falls back to 404.html", async () => {
    const res = await fetch(`${base}/nope/`);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("<h1>Missing</h1>");
  });

  test("answers a plain-text 404 when the build has no 404.html", async () => {
    const bare = resolve(import.meta.dir, "__test-preview-bare__");
    rmSync(bare, { force: true, recursive: true });
    mkdirSync(bare, { recursive: true });
    writeFileSync(join(bare, "index.html"), "<h1>Bare</h1>", "utf8");
    const bareServer = startPreviewServer(bare, 0);
    try {
      const { port } = bareServer.address() as AddressInfo;
      const res = await fetch(`http://localhost:${port}/nope/`);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("text/plain");
      expect(await res.text()).toBe("Not found");
    } finally {
      bareServer.close();
      rmSync(bare, { force: true, recursive: true });
    }
  });
});
