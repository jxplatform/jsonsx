/**
 * LoadAjv's failure path in validate-command.ts: when the optional ajv dependency cannot be
 * imported, validateProjectTree throws its install-instruction error. The project.json walk that
 * precedes it is mocked to succeed (it dynamically imports ajv itself and would fail first).
 */
import { expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const validateProjectFile = mock(() => Promise.resolve({ valid: true }));
void mock.module("@jxsuite/schema/validate-project", () => ({ validateProjectFile }));
void mock.module("ajv/dist/2020", () => {
  throw new Error("ajv unavailable");
});

const { validateProjectTree } = await import("../src/site/validate-command.ts");

test("throws an install hint when ajv cannot be loaded", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jx-validate-noajv-"));
  try {
    // oxlint-disable-next-line typescript/await-thenable -- rejects.toThrow resolves a Promise at runtime.
    await expect(validateProjectTree(dir)).rejects.toThrow(
      "Project validation requires ajv and ajv-formats: bun add ajv ajv-formats",
    );
    expect(validateProjectFile).toHaveBeenCalled();
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
