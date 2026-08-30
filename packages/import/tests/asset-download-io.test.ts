/**
 * The downloader writes through the sink rather than to a directory.
 *
 * `asset-download.test.ts` covers the local sink and the classification rules against a real
 * temporary directory; this asserts the part a Worker depends on — the bytes and the
 * project-relative destination are decided here and handed over, with nothing on disk.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { downloadAssets } from "../src/asset-download.ts";
import { memoryIo } from "./memory-io.ts";
import type { DiscoveredAsset } from "../src/asset-collect.ts";

let server: ReturnType<typeof Bun.serve>;
let origin: string;

beforeEach(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/missing.png") {
        return new Response("nope", { status: 404 });
      }
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        headers: { "Content-Type": "application/octet-stream" },
      });
    },
  });
  origin = `http://localhost:${server.port}`;
});

afterEach(() => {
  void server.stop(true);
});

describe("downloadAssets through a memory sink", () => {
  test("writes each asset under public/assets/<kind>/ and maps it to its served path", async () => {
    const { io, files, dirs } = memoryIo();
    const assets: DiscoveredAsset[] = [
      { url: `${origin}/hero.jpg`, source: "img-src" },
      { url: `${origin}/lato.woff2`, source: "font-face" },
      { url: `${origin}/favicon.ico`, source: "favicon" },
    ];

    const result = await downloadAssets(assets, io, `${origin}/`);

    expect([...files.keys()].toSorted()).toEqual([
      "public/assets/fonts/lato.woff2",
      "public/assets/icons/favicon.ico",
      "public/assets/images/hero.jpg",
    ]);
    expect(files.get("public/assets/images/hero.jpg")).toBeInstanceOf(Uint8Array);
    expect([...(files.get("public/assets/images/hero.jpg") as Uint8Array)]).toEqual([1, 2, 3, 4]);

    /* The rewrite map names the SERVED path, not the written one: `public/` is the compiler's
       static root, so that segment must not survive into a reference. */
    expect(result.rewriteMap.get(`${origin}/hero.jpg`)).toBe("/assets/images/hero.jpg");
    expect(result.totalBytes).toBe(12);
    expect(dirs).toEqual([
      "public/assets/images",
      "public/assets/fonts",
      "public/assets/icons",
      "public/assets/other",
    ]);
  });

  test("a blocked domain is skipped and a 404 is recorded, and neither reaches the sink", async () => {
    const { io, files } = memoryIo();
    const result = await downloadAssets(
      [
        { url: "https://www.google-analytics.com/analytics.js", source: "img-src" },
        { url: `${origin}/missing.png`, source: "img-src" },
      ],
      io,
    );

    expect(result.skipped).toEqual(["https://www.google-analytics.com/analytics.js"]);
    expect(result.failed).toEqual([`${origin}/missing.png`]);
    expect(files.size).toBe(0);
  });

  test("a sink with no directories still receives every file", async () => {
    // A git tree, an object store and a zip all record only files; `mkdir` is optional for them.
    const files = new Map<string, string | Uint8Array>();
    const result = await downloadAssets(
      [{ url: `${origin}/logo.svg`, source: "img-src" }],
      {
        write(relPath, data) {
          files.set(relPath, data);
          return Promise.resolve();
        },
      },
      `${origin}/`,
    );

    expect([...files.keys()]).toEqual(["public/assets/images/logo.svg"]);
    expect(result.rewriteMap.size).toBe(1);
  });
});
