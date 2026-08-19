/**
 * Coverage for the starter-clone path in generate.ts: cloning a template from @jxsuite/starters
 * (mocked with a local fixture), re-stamping project.json identity, rebuilding package.json,
 * excluding build/authoring artifacts, and the unknown-starter guard.
 */
import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import TEMPLATE_VERSIONS from "../template-versions.json";

const FIXTURE = resolve(tmpdir(), `jx-starter-fixture-${Date.now()}`);
const TMP = resolve(tmpdir(), `jx-create-starter-test-${Date.now()}`);

// Stand in for @jxsuite/starters: resolve "fixture" to our local tree, throw for anything else
// (mirroring the real getStarterDir contract).
void mock.module("@jxsuite/starters", () => ({
  getStarterDir: (id: string) => {
    if (id !== "fixture") {
      throw new Error(`Unknown starter: "${id}"`);
    }
    return FIXTURE;
  },
}));

const { generateProject } = await import("../generate");

beforeAll(() => {
  mkdirSync(join(FIXTURE, "pages"), { recursive: true });
  mkdirSync(join(FIXTURE, "components"), { recursive: true });
  mkdirSync(join(FIXTURE, "public", "images"), { recursive: true });
  mkdirSync(join(FIXTURE, "node_modules", "junk"), { recursive: true });

  writeFileSync(
    join(FIXTURE, "project.json"),
    JSON.stringify({
      $head: [
        { attributes: { content: "width=device-width", name: "viewport" }, tagName: "meta" },
        {
          attributes: { content: "Fixture starter description", name: "description" },
          tagName: "meta",
        },
      ],
      build: { format: "directory", outDir: "./dist" },
      name: "Fixture Starter",
      style: { "--color-accent": "#b45309" },
      url: "https://fixture.example",
    }),
  );
  writeFileSync(
    join(FIXTURE, "package.json"),
    JSON.stringify({ name: "fixture-starter", scripts: { build: "jx build" } }),
  );
  writeFileSync(join(FIXTURE, "pages", "index.md"), "# Fixture home\n");
  writeFileSync(join(FIXTURE, "components", "widget.json"), "{}\n");
  writeFileSync(join(FIXTURE, "public", "images", "hero.jpg"), "binary");
  writeFileSync(join(FIXTURE, "images.json"), '{"site":"fixture"}');
  writeFileSync(join(FIXTURE, "node_modules", "junk", "x.js"), "nope");
});

afterEach(() => {
  rmSync(TMP, { force: true, recursive: true });
});

describe("generateProject — starter clone", () => {
  test("clones the starter tree and re-stamps project identity", async () => {
    await generateProject(TMP, {
      description: "Best food in town",
      name: "My Diner",
      starter: "fixture",
      url: "https://diner.example",
    });

    const project = JSON.parse(readFileSync(join(TMP, "project.json"), "utf8"));
    expect(project.name).toBe("My Diner");
    expect(project.url).toBe("https://diner.example");
    // The starter's design tokens survive the re-stamp.
    expect(project.style["--color-accent"]).toBe("#b45309");
    // The description meta is updated in place.
    expect(project.$head).toContainEqual({
      attributes: { content: "Best food in town", name: "description" },
      tagName: "meta",
    });

    const pkg = JSON.parse(readFileSync(join(TMP, "package.json"), "utf8"));
    expect(pkg.name).toBe("my-diner");
    expect(pkg.scripts.build).toBe("jx build");
    // ScaffoldFromStarter REBUILDS package.json rather than copying the starter's, so the ranges
    // Must be the map's — not whatever the in-repo starter happened to pin.
    expect(pkg.devDependencies["@jxsuite/compiler"]).toBe(TEMPLATE_VERSIONS.compiler);
    expect(pkg.devDependencies["@jxsuite/runtime"]).toBe(TEMPLATE_VERSIONS.runtime);
    expect(pkg.dependencies["@jxsuite/parser"]).toBe(TEMPLATE_VERSIONS.parser);

    // Content, components, and public assets are copied verbatim.
    expect(existsSync(join(TMP, "pages", "index.md"))).toBe(true);
    expect(existsSync(join(TMP, "components", "widget.json"))).toBe(true);
    expect(existsSync(join(TMP, "public", "images", "hero.jpg"))).toBe(true);

    // Build artifacts and the authoring-only fetch manifest are excluded.
    expect(existsSync(join(TMP, "images.json"))).toBe(false);
    expect(existsSync(join(TMP, "node_modules"))).toBe(false);
  });

  test("records build.adapter and writes wrangler.jsonc for a cloudflare adapter", async () => {
    await generateProject(TMP, {
      adapter: "cloudflare-pages",
      name: "CF Diner",
      starter: "fixture",
    });

    const project = JSON.parse(readFileSync(join(TMP, "project.json"), "utf8"));
    expect(project.build.adapter).toBe("cloudflare-pages");
    // The starter's other build settings are preserved.
    expect(project.build.outDir).toBe("./dist");

    const pkg = JSON.parse(readFileSync(join(TMP, "package.json"), "utf8"));
    expect(pkg.devDependencies.wrangler).toBe("^4");
    expect(existsSync(join(TMP, "wrangler.jsonc"))).toBe(true);
  });

  test("leaves the description meta untouched when no description is given", async () => {
    await generateProject(TMP, { name: "Kept", starter: "fixture" });

    const project = JSON.parse(readFileSync(join(TMP, "project.json"), "utf8"));
    const desc = project.$head.find(
      (t: { attributes?: { name?: string } }) => t.attributes?.name === "description",
    );
    expect(desc.attributes.content).toBe("Fixture starter description");
  });

  test('treats starter "blank" as the built-in template, not a clone', async () => {
    await generateProject(TMP, { name: "Blanky", starter: "blank" });
    // Blank path builds the default project.json name from opts (not the fixture name).
    const project = JSON.parse(readFileSync(join(TMP, "project.json"), "utf8"));
    expect(project.name).toBe("Blanky");
    expect(existsSync(join(TMP, "images.json"))).toBe(false);
  });

  test("rejects an unknown starter id", async () => {
    // oxlint-disable-next-line typescript/await-thenable -- rejects.toThrow resolves a Promise at runtime.
    await expect(generateProject(TMP, { name: "Ghost", starter: "ghost" })).rejects.toThrow(
      'Unknown starter: "ghost"',
    );
  });
});
