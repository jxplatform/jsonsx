/** The package barrel: every public entry point re-exports from the phase modules. */
import { describe, expect, test } from "bun:test";
import * as api from "../src/index.ts";

describe("package exports", () => {
  test("exposes the pipeline surface", () => {
    for (const name of [
      "importSite",
      "capturePage",
      "launchBrowser",
      "closeBrowser",
      "convertToJx",
      "emitProject",
      "emitMultiPageProject",
      "captureStyles",
      "diffAllStyles",
      "extractMedia",
      "applyStylesToTree",
      "collectAssets",
      "downloadAssets",
      "rewriteAssetUrls",
      "applyTokens",
      "crawlSite",
      "detectLayout",
      "componentize",
      "aiComponentize",
      "diffScreenshots",
      "verifyProject",
    ] as const) {
      expect(typeof api[name]).toBe("function");
    }
    expect(Array.isArray(api.STYLE_ALLOWLIST)).toBe(true);
  });
});
