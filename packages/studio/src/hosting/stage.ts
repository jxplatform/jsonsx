/**
 * Copy the studio tree somewhere a host can serve it.
 *
 * CONVENIENCE, not contract. Everything a subscriber strictly needs is in `./layout` (the manifest
 * and {@link assetUrl}) and `./document` (the two generators), both of which are pure and run
 * anywhere. This module exists so the two Bun consumers — the desktop's asset staging and
 * jx-platform's `public/` build — do not each write the same copier, and it is the ONLY module
 * under `src/` that imports `node:`. A host in another runtime reads the manifest and moves the
 * bytes however it likes.
 */

import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Glob } from "bun";
import { STUDIO_ASSETS, STUDIO_CANVAS, STUDIO_SHELL } from "./layout";
import type { AssetBase, StudioAsset, StudioAssetKind, StudioLayoutMode } from "./layout";
import { canvasShellHtml } from "./document";
import type { DocumentOptions } from "./document";

/** The installed package root, resolved off this module rather than off a caller's cwd. */
export const STUDIO_PACKAGE_DIR = resolve(import.meta.dir, "..", "..");

export interface StageOptions {
  /** Package root to read from — an installed copy, or a `--link` checkout. */
  readonly from?: string;
  /** Kinds to leave out. The cloud passes `["document"]`; see the note on {@link stageStudioAssets}. */
  readonly exclude?: readonly StudioAssetKind[];
  /** Copy `*.map` too. Default false: the chunk maps alone are about 24 MB. */
  readonly sourceMaps?: boolean;
  /**
   * Remove the manifest's own paths under `destDir` first. Default true.
   *
   * Only those paths, never the whole directory. `packages/desktop/scripts/pre-build.ts` writes its
   * launcher's PAL-init bundle to `assets/studio/dist/init.js` BEFORE staging, so a blanket wipe
   * deletes it and the packaged app boots with no platform registered. Not cleaning at all is
   * equally wrong: content-hashed chunks would accumulate in a staged tree forever.
   */
  readonly clean?: boolean;
  /** Layout to report in {@link StageResult.base}. Default `"nested"`. */
  readonly layout?: StudioLayoutMode;
  /** Url prefix to report in {@link StageResult.base}. Default `"./"`. */
  readonly prefix?: string;
}

export interface StageResult {
  /**
   * The base the tree was staged at — hand it straight to {@link studioShellHtml}, so the stager and
   * the document cannot disagree about where the files went.
   */
  readonly base: AssetBase;
  /** Package-relative paths written, in manifest order. */
  readonly written: readonly string[];
  readonly bytes: number;
}

/** Manifest entries absent from `root`. Empty means the tree is complete. */
export function missingStudioAssets(root: string = STUDIO_PACKAGE_DIR): readonly StudioAsset[] {
  return STUDIO_ASSETS.filter((a) => a.required && !existsSync(join(root, a.path)));
}

/** Where a package-relative path lands under `destDir`, honouring the layout. */
function destOf(destDir: string, path: string, layout: StudioLayoutMode): string {
  return join(destDir, layout === "flat" ? path.replace(/^dist\//, "") : path);
}

/**
 * Copy the tree into `destDir`.
 *
 * @throws {Error} Naming the entry AND its `why` when a required one is missing — a staging failure
 *   should say what the reader will lose, not just which file was absent.
 */
export async function stageStudioAssets(
  destDir: string,
  options: StageOptions = {},
): Promise<StageResult> {
  const from = options.from ?? STUDIO_PACKAGE_DIR;
  const layout = options.layout ?? "nested";
  const exclude = new Set(options.exclude);
  const entries = STUDIO_ASSETS.filter((a) => !exclude.has(a.kind));

  const absent = entries.filter((a) => a.required && !existsSync(join(from, a.path)));
  if (absent.length > 0) {
    const listed = absent.map((a) => `  ${a.path} — ${a.why}`).join("\n");
    throw new Error(
      `@jxsuite/studio is missing ${absent.length} required asset(s) at ${from}:\n${listed}\n` +
        `Run \`bun run build\` in packages/studio, or check the package's published files list.`,
    );
  }

  if (options.clean !== false) {
    for (const a of entries) {
      await rm(destOf(destDir, a.path, layout), { force: true, recursive: true });
    }
  }

  const written: string[] = [];
  let bytes = 0;
  const skipMap = (p: string) => !options.sourceMaps && p.endsWith(".map");

  for (const a of entries) {
    const src = join(from, a.path);
    if (!existsSync(src)) {
      continue;
    }
    const dest = destOf(destDir, a.path, layout);
    if (a.dir) {
      await mkdir(dest, { recursive: true });
      for (const rel of new Glob("**/*").scanSync(src)) {
        const posix = rel.replaceAll("\\", "/");
        if (skipMap(posix)) {
          continue;
        }
        const file = join(src, rel);
        const to = join(dest, rel);
        await mkdir(dirname(to), { recursive: true });
        await cp(file, to);
        written.push(`${a.path}/${posix}`);
        const info = await stat(file);
        bytes += info.size;
      }
    } else {
      if (skipMap(a.path)) {
        continue;
      }
      await mkdir(dirname(dest), { recursive: true });
      await cp(src, dest);
      written.push(a.path);
      const info = await stat(src);
      bytes += info.size;
    }
  }

  return { base: { mode: layout, prefix: options.prefix ?? "./" }, bytes, written };
}

export interface ReadDocumentOptions extends DocumentOptions {
  /** Package root to read `canvas.html` from. */
  readonly from?: string;
}

/* There is no shellDocument() here. The editor document needs no file read, so it would be a
   re-export of studioShellHtml under a second name — a host imports `./hosting/document` for it,
   which is also the entry that stays pure. */

/** The canvas document, read from the package and rebased. */
export async function canvasDocument(options: ReadDocumentOptions = {}): Promise<string> {
  const from = options.from ?? STUDIO_PACKAGE_DIR;
  const html = await readFile(join(from, STUDIO_CANVAS), "utf8");
  return canvasShellHtml(html, options.base);
}

/**
 * Write `dist/manifest.json` — {@link STUDIO_ASSETS} as data, for a host that cannot import
 * TypeScript. Called by the build; gated against the manifest by check-studio-dist.ts.
 */
export async function writeAssetManifest(root: string = STUDIO_PACKAGE_DIR): Promise<void> {
  const out = join(root, "dist", "manifest.json");
  await mkdir(dirname(out), { recursive: true });
  await writeFile(
    out,
    `${JSON.stringify({ assets: STUDIO_ASSETS, shell: STUDIO_SHELL }, null, 2)}\n`,
  );
}
