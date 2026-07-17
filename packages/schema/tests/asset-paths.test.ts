import { describe, expect, test } from "bun:test";
import {
  isNpmSpecifier,
  NPM_SPECIFIER_PREFIX,
  SIDECAR_ASSET_DIR,
  sidecarAssetPath,
} from "../src/asset-paths.ts";

describe("isNpmSpecifier", () => {
  test("true for npm: specifiers", () => {
    expect(isNpmSpecifier("npm:@jxsuite/search/client")).toBe(true);
    expect(isNpmSpecifier(`${NPM_SPECIFIER_PREFIX}minisearch`)).toBe(true);
  });

  test("false for relative specifiers", () => {
    expect(isNpmSpecifier("./counter.js")).toBe(false);
    expect(isNpmSpecifier("../lib/util.ts")).toBe(false);
  });
});

describe("sidecarAssetPath", () => {
  test("scoped npm package with subpath", () => {
    expect(sidecarAssetPath("npm:@jxsuite/search/client")).toBe("/assets/jxsuite-search-client.js");
  });

  test("unscoped npm package", () => {
    expect(sidecarAssetPath("npm:minisearch")).toBe("/assets/minisearch.js");
  });

  test("relative project file drops extension and ./ prefix", () => {
    expect(sidecarAssetPath("./lib/search-helpers.ts")).toBe("/assets/lib-search-helpers.js");
    expect(sidecarAssetPath("./counter.js")).toBe("/assets/counter.js");
  });

  test("deterministic: same specifier, same path", () => {
    expect(sidecarAssetPath("npm:@myorg/validators")).toBe(
      sidecarAssetPath("npm:@myorg/validators"),
    );
  });

  test("output always lands under the asset dir with a .js extension", () => {
    for (const spec of ["npm:@a/b/c", "./x/y/z.ts", "npm:left-pad", "./a.mjs"]) {
      const out = sidecarAssetPath(spec);
      expect(out.startsWith(SIDECAR_ASSET_DIR)).toBe(true);
      expect(out.endsWith(".js")).toBe(true);
      expect(out).not.toContain("/../");
    }
  });

  test("sanitizes unexpected characters into hyphens", () => {
    expect(sidecarAssetPath("npm:weird pkg!name")).toBe("/assets/weird-pkg-name.js");
  });
});
