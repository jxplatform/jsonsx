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

  test("falls back to 404.html", async () => {
    const res = await fetch(`${base}/nope/`);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("<h1>Missing</h1>");
  });
});
