/**
 * Gap coverage for generate.ts: the non-empty-destination guard and the description meta tag in the
 * generated project.json (lines not exercised by the wrangler-focused suite).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { generateProject } from "../generate";

const TMP = resolve(tmpdir(), `jx-create-gaps-test-${Date.now()}`);

afterEach(() => {
  rmSync(TMP, { force: true, recursive: true });
});

describe("generateProject — destination guard", () => {
  test("throws when the destination exists and is not empty", async () => {
    mkdirSync(TMP, { recursive: true });
    writeFileSync(join(TMP, "existing.txt"), "occupied");

    await expect(generateProject(TMP, { name: "Busy" })).rejects.toThrow(
      `Directory "${TMP}" is not empty`,
    );
    // Nothing was scaffolded into the occupied directory
    expect(existsSync(join(TMP, "project.json"))).toBe(false);
  });

  test("scaffolds into an existing but empty directory", async () => {
    mkdirSync(TMP, { recursive: true });

    await generateProject(TMP, { name: "Empty Ok" });

    expect(existsSync(join(TMP, "project.json"))).toBe(true);
    expect(existsSync(join(TMP, ".gitignore"))).toBe(true);
    expect(existsSync(join(TMP, "layouts"))).toBe(true);
    expect(existsSync(join(TMP, "pages"))).toBe(true);
  });
});

describe("generateProject — project.json contents", () => {
  test("adds a description meta tag to $head when a description is given", async () => {
    await generateProject(TMP, { description: "A fine site", name: "Described" });

    const project = JSON.parse(readFileSync(join(TMP, "project.json"), "utf8"));
    expect(project.$head).toContainEqual({
      attributes: { content: "A fine site", name: "description" },
      tagName: "meta",
    });

    const pkg = JSON.parse(readFileSync(join(TMP, "package.json"), "utf8"));
    expect(pkg.description).toBe("A fine site");
  });

  test("omits the description meta tag and defaults the url when not given", async () => {
    await generateProject(TMP, { name: "Bare" });

    const project = JSON.parse(readFileSync(join(TMP, "project.json"), "utf8"));
    expect(project.$head).toHaveLength(1);
    expect(project.$head[0].attributes.name).toBe("viewport");
    expect(project.url).toBe("https://example.com");
    expect(project.build.adapter).toBeUndefined();
  });

  test("node adapter records build.adapter and adds the hono dependency", async () => {
    await generateProject(TMP, { adapter: "node", name: "Server Site" });

    const project = JSON.parse(readFileSync(join(TMP, "project.json"), "utf8"));
    expect(project.build.adapter).toBe("node");

    const pkg = JSON.parse(readFileSync(join(TMP, "package.json"), "utf8"));
    expect(pkg.dependencies.hono).toBe("^4");
    expect(pkg.devDependencies.wrangler).toBeUndefined();
    expect(existsSync(join(TMP, "wrangler.jsonc"))).toBe(false);
  });
});
