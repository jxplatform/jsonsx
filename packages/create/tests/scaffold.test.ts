/**
 * Pure scaffolding helpers: wrangler.jsonc generation and adapter-shape patching (no filesystem
 * involved).
 */
import { describe, expect, test } from "bun:test";
import { adapterNeedsWrangler, buildWranglerJsonc, updateWranglerConfig } from "../scaffold";

describe("adapterNeedsWrangler", () => {
  test("true only for the Cloudflare adapters", () => {
    expect(adapterNeedsWrangler("cloudflare-pages")).toBe(true);
    expect(adapterNeedsWrangler("cloudflare-workers")).toBe(true);
    expect(adapterNeedsWrangler("node")).toBe(false);
    expect(adapterNeedsWrangler("static")).toBe(false);
    expect(adapterNeedsWrangler("")).toBe(false);
  });
});

describe("buildWranglerJsonc", () => {
  test("pages config carries the build output dir and the project name", () => {
    const config = JSON.parse(buildWranglerJsonc({ adapter: "cloudflare-pages", slug: "my-site" }));
    expect(config.name).toBe("my-site");
    expect(config.pages_build_output_dir).toBe("./dist");
    expect(config.compatibility_flags).toEqual(["nodejs_compat"]);
    expect(config.main).toBeUndefined();
  });

  test("workers config carries main + assets binding instead", () => {
    const config = JSON.parse(buildWranglerJsonc({ adapter: "cloudflare-workers", slug: "api" }));
    expect(config.main).toBe("./dist/worker.js");
    expect(config.assets).toEqual({ binding: "ASSETS", directory: "./dist" });
    expect(config.pages_build_output_dir).toBeUndefined();
  });
});

describe("updateWranglerConfig", () => {
  test("regenerates from scratch when no config exists", () => {
    const { content, patched } = updateWranglerConfig(null, {
      adapter: "cloudflare-pages",
      slug: "fresh",
    });
    expect(patched).toBe(true);
    expect(JSON.parse(content).name).toBe("fresh");
  });

  test("patches pages → workers, preserving user-added keys", () => {
    const existing = buildWranglerJsonc({ adapter: "cloudflare-pages", slug: "site" });
    const withExtras = JSON.stringify({ ...JSON.parse(existing), vars: { FOO: "bar" } });
    const { content, patched } = updateWranglerConfig(withExtras, {
      adapter: "cloudflare-workers",
      slug: "site",
    });
    expect(patched).toBe(true);
    const config = JSON.parse(content);
    expect(config.main).toBe("./dist/worker.js");
    expect(config.pages_build_output_dir).toBeUndefined();
    expect(config.vars).toEqual({ FOO: "bar" });
  });

  test("patches workers → pages and renames the project", () => {
    const existing = buildWranglerJsonc({ adapter: "cloudflare-workers", slug: "old-name" });
    const { content } = updateWranglerConfig(existing, {
      adapter: "cloudflare-pages",
      slug: "new-name",
    });
    const config = JSON.parse(content);
    expect(config.name).toBe("new-name");
    expect(config.pages_build_output_dir).toBe("./dist");
    expect(config.main).toBeUndefined();
    expect(config.assets).toBeUndefined();
  });

  test("leaves comment-bearing JSONC untouched (patched: false)", () => {
    const jsonc = '// hand-tuned\n{\n\t"name": "keep"\n}\n';
    const { content, patched } = updateWranglerConfig(jsonc, {
      adapter: "cloudflare-pages",
      slug: "ignored",
    });
    expect(patched).toBe(false);
    expect(content).toBe(jsonc);
  });
});
