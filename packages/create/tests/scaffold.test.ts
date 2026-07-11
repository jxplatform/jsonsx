/**
 * Pure scaffolding helpers: wrangler.jsonc generation and adapter-shape patching (no filesystem
 * involved).
 */
import { describe, expect, test } from "bun:test";
import {
  adapterNeedsWrangler,
  applyBindingFragments,
  buildWranglerJsonc,
  updateWranglerConfig,
} from "../scaffold";

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

describe("applyBindingFragments", () => {
  test("merges d1/hyperdrive fragments into a fresh config, keyed by binding", () => {
    const existing = buildWranglerJsonc({ adapter: "cloudflare-workers", slug: "site" });
    const { content, patched } = applyBindingFragments(existing, [
      { d1_databases: [{ binding: "DB", database_id: "uuid-1", database_name: "main" }] },
      { hyperdrive: [{ binding: "HYPERDRIVE", id: "hd-1" }] },
    ]);
    expect(patched).toBe(true);
    const config = JSON.parse(content);
    expect(config.name).toBe("site");
    expect(config.d1_databases).toEqual([
      { binding: "DB", database_id: "uuid-1", database_name: "main" },
    ]);
    expect(config.hyperdrive).toEqual([{ binding: "HYPERDRIVE", id: "hd-1" }]);
  });

  test("same-binding entries merge (fragment wins, user extras survive); others append", () => {
    const existing = JSON.stringify({
      d1_databases: [
        { binding: "DB", database_id: "old-uuid", preview_database_id: "user-added" },
        { binding: "OTHER", database_id: "keep" },
      ],
      name: "site",
    });
    const { content } = applyBindingFragments(existing, [
      { d1_databases: [{ binding: "DB", database_id: "new-uuid", database_name: "main" }] },
    ]);
    const config = JSON.parse(content);
    expect(config.d1_databases).toEqual([
      {
        binding: "DB",
        database_id: "new-uuid",
        database_name: "main",
        preview_database_id: "user-added",
      },
      { binding: "OTHER", database_id: "keep" },
    ]);
  });

  test("scalar and nested-object keys never clobber user values", () => {
    const existing = JSON.stringify({
      compatibility_date: "2020-01-01",
      vars: { MINE: "keep" },
    });
    const { content } = applyBindingFragments(existing, [
      { compatibility_date: "2026-01-01", vars: { ADDED: "new", MINE: "clobber" } },
    ]);
    const config = JSON.parse(content);
    expect(config.compatibility_date).toBe("2020-01-01");
    expect(config.vars).toEqual({ ADDED: "new", MINE: "keep" });
  });

  test("non-binding array values dedupe by equality; null starts a fresh config", () => {
    const fresh = applyBindingFragments(null, [
      { compatibility_flags: ["nodejs_compat"] },
      { compatibility_flags: ["nodejs_compat", "other"] },
    ]);
    expect(JSON.parse(fresh.content).compatibility_flags).toEqual(["nodejs_compat", "other"]);
  });

  test("nested objects land wholesale when the user config lacks the key", () => {
    const { content } = applyBindingFragments("{}", [{ vars: { FROM_FRAGMENT: "v" } }]);
    expect(JSON.parse(content).vars).toEqual({ FROM_FRAGMENT: "v" });
    // A scalar under the same key blocks the object (user value wins, whatever its shape).
    const blocked = applyBindingFragments('{"vars": "user-scalar"}', [{ vars: { X: "y" } }]);
    expect(JSON.parse(blocked.content).vars).toBe("user-scalar");
  });

  test("empty fragments and comment-bearing JSONC are left untouched", () => {
    expect(applyBindingFragments("{}", [])).toEqual({ content: "{}", patched: false });
    const jsonc = '// hand-tuned\n{\n\t"name": "keep"\n}\n';
    const result = applyBindingFragments(jsonc, [{ d1_databases: [{ binding: "DB" }] }]);
    expect(result).toEqual({ content: jsonc, patched: false });
  });
});
