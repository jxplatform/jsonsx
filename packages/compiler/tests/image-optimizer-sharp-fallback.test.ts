/**
 * GetSharp's CJS fallback in image-optimizer.ts: when the primary dynamic `import("sharp")` fails
 * (symlinked monorepo/NixOS installs), sharp resolves through a project-local require built via
 * node:module's createRequire. Both seams are mocked: the sharp factory throws on the first import
 * and createRequire hands back a require returning a fake sharp.
 */
import { expect, mock, test } from "bun:test";

const mockMetadata = mock(() => Promise.resolve({ format: "png", height: 480, width: 640 }));
const fakeSharp = mock(() => ({ metadata: mockMetadata }));
const requireIds: string[] = [];

void mock.module("sharp", () => {
  throw new Error("primary sharp import blocked");
});
void mock.module("node:module", () => ({
  createRequire: () => (id: string) => {
    requireIds.push(id);
    return fakeSharp;
  },
}));

const { getImageMetadata } = await import("../src/site/image-optimizer.ts");

test("falls back to project-local CJS resolution when the import path fails", async () => {
  const meta = await getImageMetadata("/nowhere/pic.png");
  expect(meta).toEqual({ format: "png", height: 480, width: 640 });
  expect(requireIds).toEqual(["sharp"]);
  expect(fakeSharp).toHaveBeenCalledWith("/nowhere/pic.png");

  // The resolved module is cached: further calls skip both loaders entirely.
  const again = await getImageMetadata("/nowhere/pic2.png");
  expect(again.width).toBe(640);
  expect(requireIds).toEqual(["sharp"]);
});
