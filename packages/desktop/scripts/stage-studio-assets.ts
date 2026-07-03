/**
 * Shared studio-asset staging for the desktop launchers. Both pre-build scripts (electrobun's
 * `pre-build.ts` and the chromium launcher's `pre-build-rpc.ts`) stage the SAME asset set — only
 * the init bundle they build beforehand differs. Keeping the copy list here means a new studio
 * asset (like the iframe canvas doc + bundle) can never ship to one launcher and 404 in the other
 * again.
 */
import { join, resolve } from "node:path";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";

/**
 * Copy the built studio assets into `<desktopDir>/assets/studio` and patch index.html to load the
 * launcher init bundle (dist/init.js, built by the caller) before studio.js.
 */
export async function stageStudioAssets(desktopDir: string): Promise<void> {
  const studioDir = resolve(desktopDir, "../studio");
  const outDir = join(desktopDir, "assets", "studio");
  await mkdir(join(outDir, "dist"), { recursive: true });

  await copyFile(join(studioDir, "dist", "studio.css"), join(outDir, "dist", "studio.css"));
  await copyFile(join(studioDir, "dist", "studio.js"), join(outDir, "dist", "studio.js"));

  // Iframe canvas: the project server serves the canvas doc + its bundle from assets/studio.
  // Without these, the packaged iframe 404s at boot (/__studio__/canvas.html and its entry).
  await copyFile(join(studioDir, "canvas.html"), join(outDir, "canvas.html"));
  await copyFile(
    join(studioDir, "dist", "iframe-entry.js"),
    join(outDir, "dist", "iframe-entry.js"),
  );
  // The sourcemap is optional (dev convenience); copy it when present.
  try {
    await copyFile(
      join(studioDir, "dist", "iframe-entry.js.map"),
      join(outDir, "dist", "iframe-entry.js.map"),
    );
  } catch {
    // No sourcemap in this build — fine.
  }

  const html = await readFile(join(studioDir, "index.html"), "utf8");
  const patched = html.replace(
    '<script type="module" src="./dist/studio.js"></script>',
    '<script type="module" src="./dist/init.js"></script>\n  <script type="module" src="./dist/studio.js"></script>',
  );
  await writeFile(join(outDir, "index.html"), patched, "utf8");
}
