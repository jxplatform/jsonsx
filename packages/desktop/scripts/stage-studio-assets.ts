/**
 * Shared studio-asset staging for the desktop launchers. Both pre-build scripts (electrobun's
 * `pre-build.ts` and the chromium launcher's `pre-build-rpc.ts`) stage the SAME asset set — only
 * the init bundle they build beforehand differs. Keeping the copy list here means a new studio
 * asset (like the iframe canvas doc + bundle) can never ship to one launcher and 404 in the other
 * again.
 */
import { join, resolve } from "node:path";
import { copyFile, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

/**
 * Monaco's pre-bundled web workers (packages/studio/scripts/build-workers.ts). Without them the
 * packaged shell has no JSON language service at all — schema validation, completion and hover in
 * the code view silently stop working, because `new Worker()` 404s and Monaco surfaces nothing.
 */
const WORKER_BUNDLES = ["editor.worker.js", "json.worker.js", "ts.worker.js"];

/** The vendored JetBrains Mono faces index.html declares via @font-face. */
const FONT_FILES = [
  "jetbrains-mono-400.woff2",
  "jetbrains-mono-500.woff2",
  "jetbrains-mono-700.woff2",
  "OFL.txt",
];

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

  // Split chunks. The studio build emits content-hashed chunks into dist/chunks/ (Monaco, yjs, ajv
  // And every other on-demand import live there rather than in the entry), and studio.js reaches them
  // By relative URL — so the whole directory has to ship, and its names cannot be rewritten.
  const chunksSrc = join(studioDir, "dist", "chunks");
  if (!existsSync(chunksSrc)) {
    throw new Error(
      `Studio build has no dist/chunks — run \`bun run build\` in packages/studio first. ` +
        `Staging without them produces an app whose editor fails at boot with a bare ` +
        `module-resolution error, so this refuses rather than shipping it.`,
    );
  }
  await cp(chunksSrc, join(outDir, "dist", "chunks"), { recursive: true });

  // Monaco workers + webfonts. Both are addressed relatively — the workers against the BUNDLE's own
  // Url (monaco-setup.ts), the fonts against the document (index.html @font-face) — so the staged
  // Tree has to mirror packages/studio's layout exactly for either to resolve.
  await mkdir(join(outDir, "dist", "workers"), { recursive: true });
  for (const worker of WORKER_BUNDLES) {
    await copyFile(
      join(studioDir, "dist", "workers", worker),
      join(outDir, "dist", "workers", worker),
    );
  }
  await mkdir(join(outDir, "fonts"), { recursive: true });
  for (const font of FONT_FILES) {
    await copyFile(join(studioDir, "fonts", font), join(outDir, "fonts", font));
  }

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
