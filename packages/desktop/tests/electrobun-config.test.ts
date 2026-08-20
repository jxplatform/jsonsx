/**
 * Electrobun config invariants. The bundled JS resolves static data via import.meta.dirname (=
 * app/bun/ at runtime), so `build.copy` must stage the create/starters data to exactly those paths
 * — and every copy source that is not a prebuild output must exist in the repo, catching renames of
 * the source dirs at unit-test time instead of in a packaged build.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import config from "../electrobun.config";

const desktopDir = resolve(import.meta.dir, "..");

describe("electrobun config", () => {
  /* Electrobun 2 defaults `mainProcess` to Cottontail. Dropping this key does not fail the build —
     it silently ignores `build.bun` and packages a runtime this app's Bun.serve / Bun.$ / Bun.Glob
     graph was never validated against, which would only surface as a runtime failure in a packaged
     bundle. It also moves the entrypoint the copy paths below are keyed to. */
  test("selects the Bun main process explicitly", () => {
    expect(config.build.mainProcess).toBe("bun");
    expect(config.build.bun.entrypoint).toBe("src/index.ts");
  });

  test("stages create/starters static data next to the bundled module (app/bun/)", () => {
    expect(config.build.copy).toMatchObject({
      "../create/template": "bun/template",
      "../create/templates": "bun/templates",
      "../starters/registry.json": "bun/registry.json",
      "../starters/sites": "bun/sites",
    });
  });

  test("every copy source outside assets/ exists on disk", () => {
    // Assets/studio sources are prebuild outputs and may be absent in a fresh checkout.
    const sources = Object.keys(config.build.copy).filter((src) => !src.startsWith("assets/"));
    expect(sources.length).toBeGreaterThan(0);
    for (const src of sources) {
      expect({ exists: existsSync(resolve(desktopDir, src)), src }).toEqual({ exists: true, src });
    }
  });

  test("the postBuild hook runs the bundle verification", () => {
    expect(config.scripts.postBuild).toBe("./scripts/post-build.ts");
  });
});
