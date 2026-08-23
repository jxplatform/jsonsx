/**
 * Stage the studio assets into `<desktopDir>/assets/studio` for both launchers.
 *
 * This used to be a hand-maintained copy list: two named files, a chunks tree, a styles tree, three
 * worker filenames, four font filenames, the canvas pair, an optional sourcemap, and an
 * exact-string replace on `index.html` to inject the launcher's init bundle. Every one of those was
 * a fact about a package this one does not own, restated here — and the list was already wrong:
 * `dist/codicon.ttf` appeared in it nowhere, so the packaged app drew tofu where Monaco draws
 * icons.
 *
 * `@jxsuite/studio/hosting` owns those facts now. What is left is the two things that are genuinely
 * the DESKTOP's: where the tree goes, and that the launcher's own `dist/init.js` loads before the
 * studio entry.
 */
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canvasDocument, stageStudioAssets as stageAssets } from "@jxsuite/studio/hosting";
import { studioShellHtml } from "@jxsuite/studio/hosting/document";

/**
 * Copy the built studio assets and write the launcher's own editor document.
 *
 * @param {string} desktopDir Absolute path to `packages/desktop`.
 * @returns {Promise<void>}
 */
export async function stageStudioAssets(desktopDir: string): Promise<void> {
  const outDir = join(desktopDir, "assets", "studio");
  const from = resolve(desktopDir, "../studio");

  /*
   * `exclude: ["document"]` because both documents are written below rather than copied — the
   * editor's carries the launcher's boot module, and the canvas's is rebased for this layout.
   *
   * `clean` stays on (the default), and that is what makes this safe to run repeatedly: it removes
   * only the manifest's own paths, so `dist/init.js` — which the pre-build scripts write into this
   * very tree BEFORE calling us — survives, while a chunk the previous build emitted and this one
   * does not is gone rather than accumulating forever.
   */
  const { base } = await stageAssets(outDir, { exclude: ["document"], from });

  await writeFile(join(outDir, "canvas.html"), await canvasDocument({ base, from }), "utf8");

  /*
   * The editor document, with the launcher's PAL init in the boot slot.
   *
   * This was an exact-string `html.replace()` on the package's own index.html, and it did not check
   * that the replace had matched — so a whitespace change upstream would have produced a packaged
   * app with no platform registered, which then self-registers the dev-server adapter and fetches
   * `/__studio/*` against a `views://` origin. `boot` is an argument now, and generating the
   * document means there is nothing left to miss.
   */
  await writeFile(
    join(outDir, "index.html"),
    studioShellHtml({ base, boot: [`${base.prefix}dist/init.js`] }),
    "utf8",
  );
}
