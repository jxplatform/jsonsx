/**
 * Packaged-bundle completeness check (scripts/verify-bundle.ts) — guards the class of regression
 * where a static data dir read by the bundled JS (create templates, starter sites) never gets
 * staged by electrobun.config.ts `build.copy`, surfacing only as a runtime ENOENT in the packaged
 * app (e.g. `lstat '.../app/bun/template/pages'` on first project creation).
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { REQUIRED, verifyBundle } from "../scripts/verify-bundle";

const STARTER_IDS = ["alpha", "beta"];

let appDir: string;

/** Lay out a complete fake app dir: every required path plus a registry and its starter trees. */
function stageCompleteBundle(): void {
  for (const rel of REQUIRED) {
    const abs = join(appDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, rel.endsWith(".json") ? "[]" : "content");
  }
  writeFileSync(
    join(appDir, "bun", "registry.json"),
    JSON.stringify(STARTER_IDS.map((id) => ({ id, name: id }))),
  );
  for (const id of STARTER_IDS) {
    const projectFile = join(appDir, "bun", "sites", id, "project.json");
    mkdirSync(dirname(projectFile), { recursive: true });
    writeFileSync(projectFile, "{}");
  }
}

beforeEach(() => {
  appDir = mkdtempSync(join(tmpdir(), "jx-verify-bundle-"));
  stageCompleteBundle();
});

describe("verifyBundle", () => {
  test("a complete bundle reports nothing missing", () => {
    expect(verifyBundle(appDir)).toEqual([]);
  });

  test("a removed required file is reported by exact path", () => {
    rmSync(join(appDir, "bun", "template", "pages", "index.md"));
    expect(verifyBundle(appDir)).toEqual(["bun/template/pages/index.md"]);
  });

  test("a registry starter without a staged project tree is reported", () => {
    rmSync(join(appDir, "bun", "sites", "beta"), { force: true, recursive: true });
    expect(verifyBundle(appDir)).toEqual(["bun/sites/beta/project.json"]);
  });

  test("a missing registry is reported without throwing", () => {
    rmSync(join(appDir, "bun", "registry.json"));
    expect(verifyBundle(appDir)).toEqual(["bun/registry.json"]);
  });
});
