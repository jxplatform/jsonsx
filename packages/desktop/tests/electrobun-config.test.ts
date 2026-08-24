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
 * the Electrobun SDK is raw TypeScript rather than declarations — Hutch projects `.ts` sources into
 * `.hutch/devkit/api` and this package's `paths` point straight at them — so importing it pulls its
 * SOURCE into whichever program imports it. `exclude` cannot stop that (it only filters
 * which files become program roots, never what an import reaches) and `skipLibCheck` cannot either
 * (it covers `.d.ts` only) — so the root's `exactOptionalPropertyTypes` lands on a dependency's
 * code and this package needs a looser config.
 *
 * Asserted rather than written down, because the day it stops being true is the day the split can
 * go, and nothing else would ever tell us. When this fails: try deleting `packages/desktop` from
 * the root `exclude` and this package's tsconfig with it.
 */
describe("the electrobun SDK's shipped types", () => {
  /* The committed half, which always runs: these paths ARE the import, so a `.d.ts` target here
     would be the end of the carve-out even if the devkit still shipped sources. */
  test("this package's own paths point at raw .ts", () => {
    const tsconfig = readFileSync(resolve(desktopDir, "tsconfig.json"), "utf8");
    /* Read as text, not JSON.parse: this tsconfig carries comments. Each paths entry is one
       line of the form `"electrobun/main": ["./.hutch/devkit/..."],`. */
    const targets = tsconfig
      .split(/\r?\n/)
      .filter((line) => line.trimStart().startsWith('"electrobun'))
      .map((line) => line.slice(line.indexOf("./"), line.lastIndexOf('"')));
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect({ source: target.endsWith(".ts"), target }).toEqual({ source: true, target });
    }
  });

  /* The upstream half. Skipped without a devkit — `bun test` never resolves `electrobun/*` (every
     suite mocks it by specifier), so CI's desktop test job deliberately does not run
     `electrobun prepare`. It runs wherever the SDK has actually been projected. */
  const devkit = resolve(desktopDir, ".hutch/devkit/package.json");
  test.skipIf(!existsSync(devkit))("the projected SDK is still raw .ts, not declarations", () => {
    const pkg = JSON.parse(readFileSync(devkit, "utf8")) as { exports: Record<string, string> };
    const entries = Object.values(pkg.exports);
    expect(entries.length).toBeGreaterThan(0);
    for (const target of entries) {
      expect({
        declaration: target.endsWith(".d.ts"),
        source: target.endsWith(".ts"),
        target,
      }).toEqual({ declaration: false, source: true, target });
    }
  });
});
