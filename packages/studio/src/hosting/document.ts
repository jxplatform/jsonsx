/**
 * The two documents `@jxsuite/studio` ships, generated for whatever base a host mounts the tree at.
 *
 * They used to be hand-written files that every host rewrote by hand. jx-platform's asset build
 * carried three `replaceAll` calls, an exact-string surgery on the entry's script tag, and — added
 * after the fact — an assertion that no relative reference had survived, because studio 2.1.0 split
 * the chrome into `./styles/*.css` and the rewrite list missed it. The cloud editor shipped seven
 * dead stylesheet links and rendered unstyled while the build exited 0. A rewrite list is a fact
 * about a document someone else owns; generating the document removes the category.
 *
 * Pure: no `node:`, no DOM, no I/O. The caller supplies the base and the boot modules.
 */

import {
  assetUrl,
  STUDIO_BUNDLE_CSS,
  STUDIO_ENTRY,
  STUDIO_FAVICON,
  STUDIO_IFRAME_ENTRY,
  STUDIO_STYLESHEETS,
} from "./layout";
import type { AssetBase } from "./layout";

/** The default base: the tree served at the document's own directory, in the package's own shape. */
export const IN_PLACE: AssetBase = { mode: "nested", prefix: "./" };

export interface DocumentOptions {
  /** Where the asset tree is mounted. Defaults to {@link IN_PLACE}. */
  readonly base?: AssetBase | undefined;
  /**
   * Module urls evaluated BEFORE the studio entry — the host's PAL registration, in order.
   *
   * This is the declared seam. Both hosts used to obtain it by string-replacing the entry's script
   * tag, and only one of them checked that the replace had matched; the other silently shipped an
   * app with no platform registered, which then self-registered the dev-server adapter and fetched
   * `/__studio/*` against a `views://` origin.
   *
   * The runtime half of the handshake is unchanged: a boot module sets `globalThis.__jxPlatform`,
   * or publishes the `__jxCloud` signal for the studio entry to build the adapter from. It must do
   * so SYNCHRONOUSLY — a module script with top-level await does not block a later script tag, and
   * the entry reads the global as it evaluates.
   */
  readonly boot?: readonly string[] | undefined;
  /** Document title. Defaults to "Jx Studio". */
  readonly title?: string | undefined;
}

function scriptTag(url: string): string {
  return `<script type="module" src="${url}"></script>`;
}

/**
 * The editor document.
 *
 * The chrome stylesheets are LINKED rather than bundled, and the order is
 * {@link STUDIO_STYLESHEETS}'s. Bundling them was tried and rejected on measurement: Bun inlines a
 * woff2 below its size threshold as a base64 data uri, which would put roughly 85 KB into a
 * render-blocking stylesheet, and concatenating the chrome with the vendor CSS already in
 * `dist/studio.css` makes the cascade depend on module-graph traversal instead of on link order.
 * Generating the links keeps the one thing that mattered — a single definition of the list.
 */
export function studioShellHtml(options: DocumentOptions = {}): string {
  const base = options.base ?? IN_PLACE;
  const url = (path: string) => assetUrl(base, path);
  const links = [STUDIO_BUNDLE_CSS, ...STUDIO_STYLESHEETS]
    .map((path) => `    <link rel="stylesheet" href="${url(path)}" />`)
    .join("\n");
  const boot = (options.boot ?? []).map((mod) => `    ${scriptTag(mod)}`).join("\n");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${options.title ?? "Jx Studio"}</title>
    <link rel="icon" href="${url(STUDIO_FAVICON)}" />
${links}
  </head>
  <body>
${boot ? `${boot}\n` : ""}    ${scriptTag(url(STUDIO_ENTRY))}
  </body>
</html>
`;
}

/**
 * The canvas iframe document.
 *
 * Its `<style>` block is hand-authored and stays that way — it establishes the fixed-size query
 * container the runtime transposes viewport units against, and the preview-mode overrides, both of
 * which have to apply before the iframe's first render. Only the entry url is generated.
 *
 * The reference it replaces is a dynamic `import()` inside a template literal with a cache-buster,
 * which is precisely the shape jx-platform's `(?:src|href)="\./…"` residual-ref guard could not
 * see.
 *
 * @param html The package's own `canvas.html`, read by the caller.
 * @param base Where the asset tree is mounted. Defaults to {@link IN_PLACE}.
 * @returns The document with its entry url rebased.
 * @throws {Error} When the entry reference is absent — a silent miss here is a canvas that 404s at
 *   boot.
 */
export function canvasShellHtml(html: string, base: AssetBase = IN_PLACE): string {
  const from = `./${STUDIO_IFRAME_ENTRY}`;
  if (!html.includes(from)) {
    throw new Error(
      `canvas.html does not reference ${from}. The canvas entry's path is a contract ` +
        `(studio.md 11.1); if it moved, STUDIO_IFRAME_ENTRY moved with it.`,
    );
  }
  return html.replaceAll(from, assetUrl(base, STUDIO_IFRAME_ENTRY));
}
