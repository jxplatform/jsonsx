/**
 * Electrobun config invariants. The bundled JS resolves static data via import.meta.dirname (=
 * app/bun/ at runtime), so `build.copy` must stage the create/starters data to exactly those paths
 * — and every copy source that is not a prebuild output must exist in the repo, catching renames of
 * the source dirs at unit-test time instead of in a packaged build.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
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

// ─── Why this package has a tsconfig of its own ──────────────────────────────

/*
 * The root tsconfig excludes `packages/desktop`, and that carve-out is owned by this dependency:
 * the Electrobun SDK is raw TypeScript rather than declarations, so importing it pulls its SOURCE
 * into whichever program imports it. `exclude` cannot stop that (it only filters which files become
 * program roots, never what an import reaches) and `skipLibCheck` cannot either (it covers `.d.ts`
 * only) — so the root's `exactOptionalPropertyTypes` lands on a dependency's code and this package
 * needs a looser config.
 *
 * Asserted rather than written down, because the day it stops being true is the day the split can
 * go, and nothing else would ever tell us. When this fails: try deleting `packages/desktop` from
 * the root `exclude` and this package's tsconfig with it.
 */
describe("the electrobun SDK's shipped types", () => {
  /* Read as text, not JSON.parse: this tsconfig carries comments. Each paths entry is one line of
     the form `"electrobun/main": ["../../vendor/electrobun/…"],`. */
  const targets = readFileSync(resolve(desktopDir, "tsconfig.json"), "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trimStart().startsWith('"electrobun'))
    .flatMap((line) => [...line.matchAll(/"((?:\.\.?\/)[^"]+)"/g)].map((m) => m[1]!));

  /* These paths ARE the import, so a `.d.ts` target here would be the end of the carve-out even if
     the SDK still shipped sources everywhere else. */
  test("this package's own paths point at raw .ts", () => {
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect({ source: target.endsWith(".ts"), target }).toEqual({ source: true, target });
    }
  });

  /* Electrobun 2 publishes no SDK on npm, so `electrobun/*` has to resolve out of SOMETHING that a
     clone supplies. That is the pinned vendor/electrobun submodule — not `.hutch/devkit`, which is
     a network download Hutch performs and which no fresh checkout, linter or CI job has. A path
     that drifts back into `.hutch` would typecheck on the author's machine and nowhere else. */
  test("they resolve out of the vendored submodule, not a Hutch projection", () => {
    for (const target of targets) {
      expect({ target, vendored: target.startsWith("../../vendor/electrobun/") }).toEqual({
        target,
        vendored: true,
      });
    }
  });
});
