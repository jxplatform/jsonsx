/**
 * GetSharp's terminal failure in image-optimizer.ts: when both the primary dynamic
 * `import("sharp")` and the project-local CJS fallback fail to load, a descriptive
 * install-instruction error surfaces to the caller.
 */
import { expect, mock, test } from "bun:test";

void mock.module("sharp", () => {
  throw new Error("primary sharp import blocked");
});
void mock.module("node:module", () => ({
  createRequire: () => () => {
    throw new Error("cjs sharp blocked");
  },
}));

const { getImageMetadata } = await import("../src/site/image-optimizer.ts");

test("throws a descriptive error when sharp is unloadable everywhere", async () => {
  // oxlint-disable-next-line typescript/await-thenable -- rejects.toThrow resolves a Promise at runtime.
  await expect(getImageMetadata("/nowhere/pic.png")).rejects.toThrow(
    "Sharp is required for image optimization but failed to load: cjs sharp blocked",
  );
});
