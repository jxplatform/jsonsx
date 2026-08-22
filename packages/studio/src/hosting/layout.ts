/**
 * What `@jxsuite/studio` ships, where it goes, and how a host addresses it.
 *
 * The package's internal cross-references are already correct and self-locating — `dist/studio.css`
 * reaches `./codicon.ttf`, `styles/tokens.css` reaches `../fonts/*.woff2`, the entry reaches
 * `./chunks/*` and `./workers/*`. What it never shipped was a STATEMENT that they are, so four
 * hosts re-derived the file list by hand, two of them flattened the tree, that broke the
 * references, and they rewrote the shipped HTML to compensate. This module is the statement.
 *
 * **Pure by contract.** No `node:`, no DOM, nothing beyond the language — so a wrangler build, a
 * Vite plugin, a Deno host or a Nix derivation can read it. `./hosting` (stage.ts) is the `node:fs`
 * convenience the two Bun consumers share, and it is the only entry that binds a runtime. The build
 * also emits `dist/manifest.json` from {@link STUDIO_ASSETS} for a host that cannot import
 * TypeScript at all.
 *
 * **It names no adapter, no backend and no transport.** `@jxsuite/studio` may contain PAL adapters
 * — `platforms/devserver.ts` and `platforms/cloud.ts` both ship, the latter because it owns the
 * collab client's `Y.Doc` and a second bundled `yjs` breaks cross-module `instanceof` — but it must
 * not depend on a backend PACKAGE. `scripts/check-dep-rules.ts` cannot catch a violation (it
 * forbids only core-to-extension edges, and server and studio are both core), so
 * `scripts/check-studio-package.ts` does.
 */

/** What a manifest entry is, which decides how a host must treat it. */
export type StudioAssetKind =
  | "document"
  | "entry"
  | "style"
  | "chunk"
  | "worker"
  | "font"
  | "asset";

export interface StudioAsset {
  /** POSIX, relative to the package root. */
  readonly path: string;
  readonly kind: StudioAssetKind;
  /** A DIRECTORY copied wholesale; the names inside it are part of the contract. */
  readonly dir: boolean;
  /** Absence is a boot failure, not a degradation. */
  readonly required: boolean;
  /** Printed verbatim when it is missing, so the error explains itself. */
  readonly why: string;
}

/**
 * Everything a host serves.
 *
 * `required: false` means a host may leave it out and get a working editor with something switched
 * off; everything else is load-bearing. The `why` is not decoration — it is what a staging error
 * prints, and the difference between "a file is missing" and "the code view will silently have no
 * schema validation".
 */
export const STUDIO_ASSETS: readonly StudioAsset[] = [
  {
    dir: false,
    kind: "document",
    path: "index.html",
    required: true,
    why: "the editor document. Generated from studioShellHtml(); a host serving the shell at its own path should render its own rather than copy this one.",
  },
  {
    dir: false,
    kind: "document",
    path: "canvas.html",
    required: true,
    why: "the canvas iframe document. Without it every canvas frame 404s at boot.",
  },
  {
    dir: false,
    kind: "entry",
    path: "dist/studio.js",
    required: true,
    why: "the editor bundle. Its path is a contract (studio.md 11.1) and is never hashed, because it anchors every other url the bundle resolves.",
  },
  {
    dir: false,
    kind: "entry",
    path: "dist/iframe-entry.js",
    required: true,
    why: "the canvas bundle, loaded by canvas.html. Same unhashed-path contract.",
  },
  {
    dir: false,
    kind: "style",
    path: "dist/studio.css",
    required: true,
    why: "the bundle's own stylesheet — Monaco's tokens and Tabulator's theme. Distinct from styles/, which is hand-authored.",
  },
  {
    dir: false,
    kind: "asset",
    path: "dist/codicon.ttf",
    required: true,
    why: "Monaco's icon font, referenced by dist/studio.css and by three chunk stylesheets. It shipped in no tarball and no copy list for months, so every host drew tofu where Monaco draws icons.",
  },
  {
    dir: true,
    kind: "chunk",
    path: "dist/chunks",
    required: true,
    why: "the split chunks — Monaco, yjs, ajv and every on-demand import. The entry reaches them by url relative to itself, so the directory ships wholesale with its emitted names intact. A bundle that cannot find them dies at boot with a bare module-resolution error.",
  },
  {
    dir: true,
    kind: "worker",
    path: "dist/workers",
    required: true,
    why: "Monaco's pre-bundled web workers. Missing, they do not 404 loudly: the code view simply has no JSON language service, so no schema validation, no completion and no hover, with nothing in the console.",
  },
  {
    dir: true,
    kind: "style",
    path: "styles",
    required: true,
    why: "the hand-authored chrome stylesheet, linked by the document in cascade order. No bundler sees it. Missing, the editor boots with no tokens, no grid and no panel chrome.",
  },
  {
    dir: true,
    kind: "font",
    path: "fonts",
    required: true,
    why: "the vendored JetBrains Mono faces, reached from styles/tokens.css by ../fonts/. They stay a directory rather than being bundled: Bun inlines a woff2 under its size threshold as base64, which would put about 85 KB into a render-blocking stylesheet.",
  },
];

/** Never staged and never published, whatever the entries above would otherwise match. */
export const STUDIO_ASSET_EXCLUDE: readonly string[] = ["**/*.map"];

/**
 * Published beyond the served tree: the source graph the `exports` map points at, and the data it
 * reads. `data/` is here because six modules import it — `src/studio.ts` among them — so without it
 * the package's own `.` export does not resolve from a tarball.
 */
export const PUBLISHED_EXTRAS: readonly string[] = ["src", "data"];

export const STUDIO_SHELL = "index.html";
export const STUDIO_CANVAS = "canvas.html";
export const STUDIO_ENTRY = "dist/studio.js";
export const STUDIO_IFRAME_ENTRY = "dist/iframe-entry.js";
export const STUDIO_BUNDLE_CSS = "dist/studio.css";

/** Monaco's workers, by the names scripts/build-workers.ts emits and monaco-setup.ts asks for. */
export const STUDIO_WORKERS: readonly string[] = [
  "editor.worker.js",
  "json.worker.js",
  "ts.worker.js",
];

/**
 * The chrome stylesheets, IN CASCADE ORDER.
 *
 * Order is behaviour, not presentation: `forced-colors.css` is last because it redraws what Windows
 * High Contrast deletes. This list is what the document's link tags are generated from, so a
 * stylesheet added to `styles/` and not added here is simply never loaded — which is the 2.1.0
 * outage exactly, where the cloud shipped seven dead link tags and the build exited 0.
 * `scripts/check-studio-package.ts` holds it equal to `styles/*.css` on disk.
 */
export const STUDIO_STYLESHEETS: readonly string[] = [
  "styles/tokens.css",
  "styles/shell.css",
  "styles/canvas.css",
  "styles/panels.css",
  "styles/inspector.css",
  "styles/overlays.css",
  "styles/forced-colors.css",
];

/** Bump when a host-visible export changes shape. A consumer may assert against it. */
export const STUDIO_HOST_API = 1;

/**
 * How a host lays the tree out.
 *
 * `nested` keeps the package's own shape. `flat` hoists the contents of `dist/` up one level, which
 * is what jx-platform's `public/` has always done.
 */
export type StudioLayoutMode = "nested" | "flat";

export interface AssetBase {
  /** URL prefix the tree is served under, as the BROWSER sees it. Non-empty values end in "/". */
  readonly prefix: string;
  readonly mode: StudioLayoutMode;
}

/**
 * Map a package-relative path to the url a host serving under `base` answers.
 *
 * `flat` strips exactly ONE leading `dist/` segment and nothing else, and that single rule is what
 * makes flattening a contract rather than a rewrite. Every reference that lives inside `dist/` is
 * dist-relative — the entry reaches `./chunks/`, `dist/studio.css` reaches `./codicon.ttf`, a chunk
 * stylesheet reaches `../codicon.ttf` — so stripping one segment uniformly moves all of them
 * together and none of them breaks. `styles/` and `fonts/` are untouched in both modes, which is
 * why `tokens.css`'s `url("../fonts/…")` holds either way.
 *
 * @param base Where the tree is mounted.
 * @param packagePath A path from {@link STUDIO_ASSETS}, or a file inside one of its directories.
 * @returns The url, with `base.prefix` applied.
 */
export function assetUrl(base: AssetBase, packagePath: string): string {
  const path = packagePath.replace(/^\.?\//, "");
  const laid = base.mode === "flat" ? path.replace(/^dist\//, "") : path;
  return `${base.prefix}${laid}`;
}
