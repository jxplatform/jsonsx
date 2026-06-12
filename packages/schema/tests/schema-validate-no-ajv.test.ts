/**
 * Covers validateDocument's missing-dependency branch. ajv / ajv-formats are optional peer
 * dependencies that are not installed in this repo, so the dynamic import fails and the helper must
 * surface the install hint.
 */
import { describe, expect, test } from "bun:test";

import { validateDocument } from "../src/schema";

describe("validateDocument without ajv installed", () => {
  test("throws an actionable install hint", async () => {
    await expect(validateDocument({ tagName: "div" })).rejects.toThrow(
      "Schema validation requires ajv and ajv-formats: bun add ajv ajv-formats",
    );
  });
});
