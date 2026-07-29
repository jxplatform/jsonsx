// oxlint-disable typescript/await-thenable -- bun test .resolves/.rejects matchers are typed `void` but return real Promises at runtime; the await is required.
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

mkdirSync(join(studioDir, "dist", "workers"), { recursive: true });
mkdirSync(join(studioDir, "dist", "chunks"), { recursive: true });
mkdirSync(join(studioDir, "fonts"), { recursive: true });
mkdirSync(desktopDir, { recursive: true });
writeFileSync(join(studioDir, "dist", "studio.css"), "/* css */");
writeFileSync(join(studioDir, "dist", "studio.js"), "// studio");
writeFileSync(join(studioDir, "dist", "iframe-entry.js"), "// canvas entry");
writeFileSync(join(studioDir, "dist", "chunks", "studio-abc123.js"), "// split chunk");
for (const worker of ["editor.worker.js", "json.worker.js", "ts.worker.js"]) {
  writeFileSync(join(studioDir, "dist", "workers", worker), `// ${worker}`);
}
for (const font of [
  "jetbrains-mono-400.woff2",
  "jetbrains-mono-500.woff2",
  "jetbrains-mono-700.woff2",
  "OFL.txt",
]) {
  writeFileSync(join(studioDir, "fonts", font), `font:${font}`);
}
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

  test("stages the split chunks — the editor cannot boot without them", async () => {
    await stageStudioAssets(desktopDir);
    const out = join(desktopDir, "assets", "studio");
    // The build code-splits, and studio.js imports those chunks by url relative to its OWN location,
    // So they ship with their emitted names intact. Miss them and the packaged editor dies at boot
    // With a bare module-resolution error.
    expect(await readFile(join(out, "dist", "chunks", "studio-abc123.js"), "utf8")).toBe(
      "// split chunk",
    );
  });

  /* Studio.js resolves Monaco's workers relative to its OWN url, so they have to land beside it —
     and a miss here is silent: no 404 the user sees, just a code view with no JSON language
     service, which means no schema validation, completion or hover in the packaged app. */
  test("stages Monaco's workers beside the bundle and the vendored webfonts", async () => {
    await stageStudioAssets(desktopDir);
    const out = join(desktopDir, "assets", "studio");

    for (const worker of ["editor.worker.js", "json.worker.js", "ts.worker.js"]) {
      expect(await readFile(join(out, "dist", "workers", worker), "utf8")).toBe(`// ${worker}`);
    }
    expect(await readFile(join(out, "fonts", "jetbrains-mono-400.woff2"), "utf8")).toBe(
      "font:jetbrains-mono-400.woff2",
    );
    expect(await readFile(join(out, "fonts", "OFL.txt"), "utf8")).toBe("font:OFL.txt");
  });

  /* Refusing beats shipping: a staged app whose studio.js imports chunks that are not there dies at
     boot with a bare module-resolution error and no hint about the missing build step. */
  test("refuses to stage when the studio build has no chunks", async () => {
    const bare = mkdtempSync(join(tmpdir(), "jx-stage-nochunks-"));
    const bareStudio = join(bare, "studio");
    const bareDesktop = join(bare, "desktop");
    mkdirSync(join(bareStudio, "dist"), { recursive: true });
    mkdirSync(bareDesktop, { recursive: true });
    writeFileSync(join(bareStudio, "dist", "studio.js"), "// studio");
    writeFileSync(join(bareStudio, "dist", "studio.css"), "/* css */");
    try {
      await expect(stageStudioAssets(bareDesktop)).rejects.toThrow("no dist/chunks");
    } finally {
      rmSync(bare, { force: true, recursive: true });
    }
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
