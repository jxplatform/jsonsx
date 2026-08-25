/**
 * Asset references, resolved for the canvas — the half that asks the running editor.
 *
 * The resolution math itself is {@link file://./asset-resolve.ts}, which is pure and which the
 * canvas iframe imports. This module is everything that has to look something up: the open
 * project's content sections and locales, the active tab, the registered platform's declarations.
 *
 * The split is by REALM. The iframe bundle is deliberately dependency-light, and reaching
 * `projectState` or `getPlatform()` from it drags the whole editor shell in behind it — which is
 * what `check-studio-dist` caught the first time these lived in one file.
 *
 * @docs studio/projects/media
 */

import { resolveI18n } from "@jxsuite/schema/locale";
import { BUILD_LANES, dirOfPath } from "@jxsuite/schema/asset-paths";
import { contentMountFor, resolveAssetRef } from "./asset-resolve";
import { documentBase, loopbackAssetSrc } from "./canvas-origin";
import { getPlatform, hasPlatform } from "../platform";
import { projectState } from "../store";
import { activeTab } from "../workspace/workspace";
import type { AssetContext } from "./asset-resolve";
import type { ContentSectionEntry } from "../types";

/* Re-exported so callers that want both halves import one module. The pure ones are defined next
   door precisely so the iframe can reach them WITHOUT reaching any of the above. */
export { contentMountFor, mountedRefFor, resolveAssetRef } from "./asset-resolve";
export type { AssetContext } from "./asset-resolve";

/**
 * The open project's canonical locale tags, or `[]` when it declares none.
 *
 * Through `resolveI18n` rather than off the raw config, so `EN-us` means the same thing here as it
 * does in the compiler and the content loader — the whole reason that resolver is in
 * `@jxsuite/schema`.
 */
export function projectLocales(): string[] {
  return resolveI18n(projectState?.projectConfig ?? {}).i18n?.locales ?? [];
}

/**
 * The context for a document in the project currently open, or null when nothing applies.
 *
 * @param {string | null | undefined} documentPath - Project-relative path of the open document
 * @param {object} [over] - Host declarations: the asset space and the project-file base URL
 * @returns {AssetContext | null} A context, or null when no resolution is needed
 */
export function assetContextFor(
  documentPath: string | null | undefined,
  over?: { space?: "site" | "repo" | undefined; fileBaseUrl?: string | undefined },
): AssetContext | null {
  const space = over?.space ?? "site";
  const mount = contentMountFor(
    documentPath,
    projectState?.projectConfig?.content as Record<string, ContentSectionEntry> | undefined,
    projectLocales(),
  );
  /* In site space the mount is the ONLY thing that needs doing, so no mount means no work. In repo
     space every reference needs rebasing, mount or not. */
  if (space === "site" && !mount) {
    return null;
  }
  return {
    documentDir: dirOfPath(documentPath ?? ""),
    ...(over?.fileBaseUrl === undefined ? {} : { fileBaseUrl: over.fileBaseUrl }),
    lanes: BUILD_LANES,
    mounts: mount ? [mount] : [],
    space,
  };
}

/**
 * The src a PARENT-REALM preview should load for an AUTHORED value — a media-picker thumbnail, the
 * social card in the SEO modal.
 *
 * The canvas resolves its own references; panel chrome renders in the parent document, where a
 * content-relative value would resolve against `index.html` and 404 exactly as it did in the
 * canvas. Same mapping, same rule — resolved against the ACTIVE tab, which is the entry whose field
 * is being edited.
 *
 * Takes what the author WROTE. For a project FILE PATH — a library thumbnail, a media-browser tile
 * — use `previewFileSrc` in `files/media-paths`; the two are separate because a file path is not an
 * authored reference and confusing them is silent.
 *
 * The loopback absolutization is folded in rather than left to the caller: every one of the four
 * call sites needs both steps, and one that composed them by hand would work everywhere except the
 * desktop shell, where a relative src resolves against `views://`.
 *
 * @param {string} value - The reference as the author wrote it
 * @returns {string} A src the parent realm can load
 */
export function previewAssetSrc(value: string): string {
  if (!value) {
    return value;
  }
  const ctx = assetContextFor(activeTab.value?.documentPath, hostAssetDeclarations());
  return loopbackAssetSrc(resolveAssetRef(value, ctx) ?? value);
}

/**
 * What the registered host says about media — the platform's `assetSpace`, and the base project
 * files are served under.
 *
 * Read through the platform rather than passed in, because every caller is panel chrome with no
 * access to the render pipeline and because the answer is a property of the HOST, not of the call.
 * The canvas pipeline builds the same two values from the same two places; the difference is only
 * that it already has the document in hand.
 *
 * @returns {{ space?: "site" | "repo"; fileBaseUrl: string }} The host's declarations
 */
export function hostAssetDeclarations(): {
  space?: "site" | "repo" | undefined;
  fileBaseUrl: string;
} {
  return {
    fileBaseUrl: documentBase(projectState?.projectRoot),
    ...(hasPlatform() ? { space: getPlatform().assetSpace } : {}),
  };
}
