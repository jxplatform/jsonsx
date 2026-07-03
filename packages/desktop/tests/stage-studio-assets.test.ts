/**
 * Shared studio-asset staging (scripts/stage-studio-assets.ts) — the single copy list both desktop
 * pre-build scripts use. Guards the launcher-drift regression where the chromium staging script
 * missed the iframe canvas assets and the packaged iframe 404'd at `/__studio__/canvas.html`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageStudioAssets } from "../scripts/stage-studio-assets";

const root = mkdtempSync(join(tmpdir(), "jx-stage-assets-"));
const studioDir = join(root, "studio");
const desktopDir = join(root, "desktop");

mkdirSync(join(studioDir, "dist"), { recursive: true });
mkdirSync(desktopDir, { recursive: true });
writeFileSync(join(studioDir, "dist", "studio.css"), "/* css */");
writeFileSync(join(studioDir, "dist", "studio.js"), "// studio");
writeFileSync(join(studioDir, "dist", "iframe-entry.js"), "// canvas entry");
writeFileSync(join(studioDir, "canvas.html"), '<div id="jx-canvas-root"></div>');
writeFileSync(
  join(studioDir, "index.html"),
  '<html><script type="module" src="./dist/studio.js"></script></html>',
);

afterAll(() => {
  rmSync(root, { force: true, recursive: true });
});

describe("stageStudioAssets", () => {
  test("stages shell, styles, AND the iframe canvas doc + bundle; patches index.html", async () => {
    await stageStudioAssets(desktopDir);
    const out = join(desktopDir, "assets", "studio");

    expect(await readFile(join(out, "dist", "studio.css"), "utf8")).toBe("/* css */");
    expect(await readFile(join(out, "dist", "studio.js"), "utf8")).toBe("// studio");
    // The regression: these two must ship with EVERY launcher, or the packaged iframe 404s.
    expect(await readFile(join(out, "canvas.html"), "utf8")).toContain("jx-canvas-root");
    expect(await readFile(join(out, "dist", "iframe-entry.js"), "utf8")).toBe("// canvas entry");
    // Index.html loads the launcher init bundle before studio.js.
    const html = await readFile(join(out, "index.html"), "utf8");
    expect(html).toContain('src="./dist/init.js"');
    expect(html.indexOf("init.js")).toBeLessThan(html.indexOf("studio.js"));
  });

  test("a missing optional sourcemap is tolerated; a present one is copied", async () => {
    // First run above had no map and succeeded. Add one and re-stage.
    writeFileSync(join(studioDir, "dist", "iframe-entry.js.map"), "{}");
    await stageStudioAssets(desktopDir);
    expect(
      await readFile(join(desktopDir, "assets", "studio", "dist", "iframe-entry.js.map"), "utf8"),
    ).toBe("{}");
  });
});
