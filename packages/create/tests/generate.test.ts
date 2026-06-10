import { describe, test, expect, afterEach } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { generateProject } from "../generate";

const TMP = resolve(tmpdir(), "jx-create-test-" + Date.now());

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("generateProject — wrangler.jsonc", () => {
  test("static adapter does not emit wrangler.jsonc or wrangler dep", async () => {
    await generateProject(TMP, { name: "My Site", adapter: "static" });

    expect(existsSync(join(TMP, "wrangler.jsonc"))).toBe(false);
    const pkg = JSON.parse(readFileSync(join(TMP, "package.json"), "utf8"));
    expect(pkg.devDependencies.wrangler).toBeUndefined();
    expect(pkg.scripts.deploy).toBeUndefined();
  });

  test("cloudflare-pages emits wrangler.jsonc with the Images binding", async () => {
    await generateProject(TMP, {
      name: "My Site",
      adapter: "cloudflare-pages",
    });

    const wrangler = JSON.parse(readFileSync(join(TMP, "wrangler.jsonc"), "utf8"));
    expect(wrangler.name).toBe("my-site");
    expect(wrangler.pages_build_output_dir).toBe("./dist");
    expect(wrangler.images).toEqual({ binding: "IMAGES" });
    expect(wrangler.compatibility_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const pkg = JSON.parse(readFileSync(join(TMP, "package.json"), "utf8"));
    expect(pkg.devDependencies.wrangler).toBe("^4");
    expect(pkg.scripts.deploy).toBe("wrangler pages deploy dist");
  });

  test("cloudflare-workers emits wrangler.jsonc with assets and Images bindings", async () => {
    await generateProject(TMP, {
      name: "My Site",
      adapter: "cloudflare-workers",
    });

    const wrangler = JSON.parse(readFileSync(join(TMP, "wrangler.jsonc"), "utf8"));
    expect(wrangler.main).toBe("./dist/worker.js");
    expect(wrangler.assets).toEqual({ directory: "./dist", binding: "ASSETS" });
    expect(wrangler.images).toEqual({ binding: "IMAGES" });

    const pkg = JSON.parse(readFileSync(join(TMP, "package.json"), "utf8"));
    expect(pkg.devDependencies.wrangler).toBe("^4");
    expect(pkg.scripts.deploy).toBe("wrangler deploy");

    const project = JSON.parse(readFileSync(join(TMP, "project.json"), "utf8"));
    expect(project.build.adapter).toBe("cloudflare-workers");
  });
});
