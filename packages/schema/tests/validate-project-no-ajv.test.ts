/**
 * Covers validateProjectFile's missing-dependency branch. Mirrors schema-validate-no-ajv.test.ts:
 * the dynamic ajv import is forced to fail (ajv may be present transitively, so we can't rely on it
 * being absent) and the helper must surface the install hint. Isolated in its own file because
 * mock.module poisons ajv for every subsequent import in the process.
 */
import { describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

void mock.module("ajv/dist/2020", () => {
  throw new Error("Cannot find package 'ajv'");
});

const { validateProjectFile } = await import("../src/validate-project");

const ROOT = resolve(tmpdir(), `jx-validate-project-no-ajv-${Date.now()}`);
mkdirSync(ROOT, { recursive: true });
writeFileSync(join(ROOT, "project.json"), "{}\n");
writeFileSync(join(ROOT, "project.schema.json"), "{}\n");

describe("validateProjectFile without ajv installed", () => {
  test("throws an actionable install hint", async () => {
    try {
      // oxlint-disable-next-line typescript/await-thenable -- Bun types `.rejects.toThrow` as void, but it resolves a Promise at runtime; the await is required.
      await expect(validateProjectFile(ROOT)).rejects.toThrow(
        "Project validation requires ajv: bun add ajv",
      );
    } finally {
      rmSync(ROOT, { force: true, recursive: true });
    }
  });
});
