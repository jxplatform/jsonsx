// oxlint-disable typescript/await-thenable -- bun test .resolves/.rejects matchers are typed `void` but return real Promises at runtime; the await is required.
/**
 * Shared studio-asset staging (scripts/stage-studio-assets.ts) — the single copy list both desktop
 * pre-build scripts use. Guards the launcher-drift regression where the chromium staging script
 * missed the iframe canvas assets and the packaged iframe 404'd at `/__studio__/canvas.html`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { STUDIO_ASSETS, STUDIO_STYLESHEETS, STUDIO_WORKERS } from "@jxsuite/studio/hosting/layout";
import { stageStudioAssets } from "../scripts/stage-studio-assets";

const root = mkdtempSync(join(tmpdir(), "jx-stage-assets-"));
const studioDir = join(root, "studio");
const desktopDir = join(root, "desktop");
mkdirSync(desktopDir, { recursive: true });

/**
 * A studio package tree, built FROM THE MANIFEST rather than from a list written here.
 *
 * The list written here was itself an incomplete copy list — it had no `dist/codicon.ttf`, the same
 * omission that shipped tofu instead of Monaco's icons in every distribution. A fixture that
 * enumerates what the staging should copy cannot catch the staging missing something, because both
 * sides are the same guess. Deriving it means a manifest entry added upstream appears here too.
 */
function write(rel: string, body: string): void {
  mkdirSync(dirname(join(studioDir, rel)), { recursive: true });
  writeFileSync(join(studioDir, rel), body);
}
for (const asset of STUDIO_ASSETS) {
  if (asset.dir) {
    mkdirSync(join(studioDir, asset.path), { recursive: true });
  } else {
    write(asset.path, `/* ${asset.path} */`);
  }
}
/* The contents of the wholesale directories, and the two documents' real shapes. */
write("dist/chunks/studio-abc123.js", "// split chunk");
for (const worker of STUDIO_WORKERS) {
  write(`dist/workers/${worker}`, `// ${worker}`);
}
for (const sheet of STUDIO_STYLESHEETS) {
  write(sheet, `/* ${sheet} */`);
}
for (const font of [
  "jetbrains-mono-400.woff2",
  "jetbrains-mono-500.woff2",
  "jetbrains-mono-700.woff2",
  "OFL.txt",
]) {
  write(`fonts/${font}`, `font:${font}`);
}
write("dist/studio.css", "/* css */");
write("dist/studio.js", "// studio");
write("dist/iframe-entry.js", "// canvas entry");
write(
  "canvas.html",
  '<div id="jx-canvas-root"></div>\n<script type="module">import(`./dist/iframe-entry.js`);</script>',
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

  /* The chrome stylesheet is plain CSS that index.html <link>s directly — no bundler touches it, so
     nothing else in the pipeline would carry it into the app. Miss it and the packaged Studio boots
     with no tokens, no grid and no panel chrome: every surface renders as unstyled boxes. */
  test("stages the whole styles/ directory, the studio's only chrome CSS", async () => {
    await stageStudioAssets(desktopDir);
    const out = join(desktopDir, "assets", "studio");

    for (const sheet of STUDIO_STYLESHEETS) {
      expect(await readFile(join(out, sheet), "utf8")).toBe(`/* ${sheet} */`);
    }
  });

  /* Refusing beats shipping, and the refusal is now the manifest's rather than two hand-written
     guards. It used to cover exactly the two omissions someone had already been bitten by —
     `styles/` and `dist/chunks` — which is why `dist/codicon.ttf` went missing for months with
     nothing to say so. Every required entry is guarded, and the message names what the reader
     loses rather than only which file was absent. */
  test("refuses to stage when a required asset is missing, naming what it costs", async () => {
    for (const [missing, cost] of [
      ["styles", "no tokens, no grid and no panel chrome"],
      ["dist/chunks", "bare module-resolution error"],
      ["dist/codicon.ttf", "Monaco's icon font"],
      ["dist/workers", "no JSON language service"],
    ] as const) {
      const bare = mkdtempSync(join(tmpdir(), "jx-stage-missing-"));
      try {
        cpSync(studioDir, join(bare, "studio"), { recursive: true });
        mkdirSync(join(bare, "desktop"), { recursive: true });
        rmSync(join(bare, "studio", missing), { force: true, recursive: true });
        await expect(stageStudioAssets(join(bare, "desktop"))).rejects.toThrow(missing);
        await expect(stageStudioAssets(join(bare, "desktop"))).rejects.toThrow(cost);
      } finally {
        rmSync(bare, { force: true, recursive: true });
      }
    }
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

  /* Source maps are left behind by default. The chunk maps alone are about 24 MB, and the entries
     ship without their own map anyway, so a chunk map could not resolve a stack frame on its own. */
  test("does not carry source maps into the app bundle", async () => {
    writeFileSync(join(studioDir, "dist", "chunks", "studio-abc123.js.map"), "{}");
    await stageStudioAssets(desktopDir);
    const out = join(desktopDir, "assets", "studio");
    expect(existsSync(join(out, "dist", "chunks", "studio-abc123.js.map"))).toBe(false);
    expect(existsSync(join(out, "dist", "chunks", "studio-abc123.js"))).toBe(true);
  });
});
