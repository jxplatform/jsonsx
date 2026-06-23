/**
 * Covers validateDocument's missing-dependency branch. ajv / ajv-formats are optional peer
 * dependencies; here we force the dynamic import to fail (ajv may be present transitively, so we
 * can't rely on it being absent) and assert the helper surfaces the install hint.
 */
import { describe, expect, mock, test } from "bun:test";

void mock.module("ajv/dist/2020", () => {
  throw new Error("Cannot find package 'ajv'");
});

const { validateDocument } = await import("../src/schema");

describe("validateDocument without ajv installed", () => {
  test("throws an actionable install hint", async () => {
    // oxlint-disable-next-line typescript/await-thenable -- Bun types `.rejects.toThrow` as void, but it resolves a Promise at runtime; the await is required.
    await expect(validateDocument({ tagName: "div" })).rejects.toThrow(
      "Schema validation requires ajv and ajv-formats: bun add ajv ajv-formats",
    );
  });
});
