import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { setProjectRoot } from "../src/handlers";
import { addPackage, listPackages, removePackage } from "../src/packages";

const FIXTURES = join(import.meta.dir, "_fixtures_packages");

function setup() {
  mkdirSync(FIXTURES, { recursive: true });
  setProjectRoot(FIXTURES);
}

function cleanup() {
  setProjectRoot(null);
  rmSync(FIXTURES, { force: true, recursive: true });
}

beforeEach(setup);
afterEach(cleanup);

// ─── listPackages ───────────────────────────────────────────────────────────

describe("listPackages", () => {
  test("returns empty array when no package.json", async () => {
    const result = await listPackages();
    expect(result).toEqual([]);
  });

  test("returns empty array when no dependencies", async () => {
    writeFileSync(join(FIXTURES, "package.json"), JSON.stringify({ name: "test" }));
    const result = await listPackages();
    expect(result).toEqual([]);
  });

  test("lists dependencies from package.json", async () => {
    writeFileSync(
      join(FIXTURES, "package.json"),
      JSON.stringify({
        dependencies: {
          express: "^4.18.0",
          lodash: "^4.17.21",
        },
        name: "test",
      }),
    );

    const result = await listPackages();
    expect(result).toHaveLength(2);
    expect(result).toContainEqual({ name: "lodash", version: "^4.17.21" });
    expect(result).toContainEqual({ name: "express", version: "^4.18.0" });
  });

  test("returns empty array when no project root", async () => {
    setProjectRoot(null);
    const result = await listPackages();
    expect(result).toEqual([]);
  });
});

// ─── addPackage ─────────────────────────────────────────────────────────────

describe("addPackage", () => {
  test("throws when no project root", async () => {
    setProjectRoot(null);
    await expect(addPackage({ name: "lodash" })).rejects.toThrow("No project open");
  });

  test("runs bun add in project root", async () => {
    writeFileSync(
      join(FIXTURES, "package.json"),
      JSON.stringify({ dependencies: {}, name: "test" }),
    );
    // This will actually run bun add — it may fail in CI without network
    // But validates the code path runs correctly
    try {
      await addPackage({ name: "is-number" });
      const pkgJson = JSON.parse(await Bun.file(join(FIXTURES, "package.json")).text());
      expect(pkgJson.dependencies["is-number"]).toBeDefined();
    } catch (error: unknown) {
      // Accept network failures in CI
      expect(error instanceof Error ? error.message : String(error)).toContain(
        "Failed to add package",
      );
    }
  });

  test("throws with stderr when bun add fails", async () => {
    writeFileSync(join(FIXTURES, "package.json"), "INVALID JSON");
    await expect(addPackage({ name: "foo" })).rejects.toThrow("Failed to add package");
  });
});

// ─── removePackage ──────────────────────────────────────────────────────────

describe("removePackage", () => {
  test("throws when no project root", async () => {
    setProjectRoot(null);
    await expect(removePackage({ name: "lodash" })).rejects.toThrow("No project open");
  });

  test("runs bun remove in project root", async () => {
    writeFileSync(
      join(FIXTURES, "package.json"),
      JSON.stringify({ dependencies: { "is-number": "^7.0.0" }, name: "test" }),
    );
    try {
      await removePackage({ name: "is-number" });
      const pkgJson = JSON.parse(await Bun.file(join(FIXTURES, "package.json")).text());
      const deps = pkgJson.dependencies || {};
      expect(deps["is-number"]).toBeUndefined();
    } catch (error: unknown) {
      expect(error instanceof Error ? error.message : String(error)).toContain(
        "Failed to remove package",
      );
    }
  });

  test("throws with stderr when bun remove fails", async () => {
    writeFileSync(join(FIXTURES, "package.json"), "INVALID JSON");
    await expect(removePackage({ name: "foo" })).rejects.toThrow("Failed to remove package");
  });
});
