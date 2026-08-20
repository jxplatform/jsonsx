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
 * electrobun's `exports` map points at raw TypeScript rather than declarations, so importing it
 * pulls its SOURCE into whichever program imports it. `exclude` cannot stop that (it only filters
 * which files become program roots, never what an import reaches) and `skipLibCheck` cannot either
 * (it covers `.d.ts` only) — so the root's `exactOptionalPropertyTypes` lands on a dependency's
 * code and this package needs a looser config.
 *
 * Asserted rather than written down, because the day it stops being true is the day the split can
 * go, and nothing else would ever tell us. When this fails: try deleting `packages/desktop` from
 * the root `exclude` and this package's tsconfig with it.
 */
describe("the electrobun package's shipped types", () => {
  test("still resolves to raw .ts, which is what forces this package's own tsconfig", () => {
    /* Read, not imported: electrobun's own `exports` map declares no `./package.json` entry, so it
       is not importable — the very narrowness this test is about. */
    const manifest = resolve(desktopDir, "../../node_modules/electrobun/package.json");
    expect(existsSync(manifest)).toBe(true);
    const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { exports: Record<string, string> };
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
