/// <reference lib="dom" />
/**
 * File-drop-action.ts — the parent-realm half of dropping OS files onto the canvas (flow 5).
 *
 * The iframe supplies geometry only (see `fileDragOver`/`fileDrop` in canvas/iframe-protocol.ts);
 * everything semantic happens here because it needs the component registry, the platform, and the
 * mutation pipeline — none of which the iframe bundle may import.
 *
 * Two outcomes:
 *
 * - Dropped ON an existing image → REPLACE its source in place. That is a `set-attr` patch, so the
 *   canvas swaps the picture without a re-render.
 * - Dropped anywhere else → INSERT a new element at the resolved position, through the same
 *   `applyDropInstruction` the palette uses.
 *
 * Registered by name via `setFileDropHandler` in studio.ts.
 *
 * @docs studio/projects/media
 */

import { componentRegistry } from "../files/components";
import { uploadAssets } from "../files/media-upload";
import { applyDropInstruction } from "../panels/dnd";
import { mutateUpdateAttribute, mutateUpdateProp, transactDoc } from "../tabs/transact";
import type { UploadedAsset } from "../files/media-upload";
import type { DropPreview, FileDropHit } from "../canvas/iframe-protocol";
import type { JxPath } from "../state";
import type { Tab } from "../tabs/tab";
import type { JxMutableNode } from "@jxsuite/schema/types";
import { isMediaFormat } from "../utils/studio-utils";

/** Where an asset's URL goes when it replaces an existing element's picture. */
const REPLACE_ATTRS: Record<string, "src" | "poster"> = {
  img: "src",
  source: "src",
  // A <video>'s own `src` is the movie; dropping an image on one sets its poster frame instead.
  video: "poster",
};

/** What a drop resolves to once the parent has applied its semantics. */
export type FileDropTarget =
  | { mode: "replace-attr"; path: JxPath; attr: "src" | "poster" }
  | { mode: "replace-prop"; path: JxPath; prop: string }
  | { mode: "insert" };

/** A component prop the registry declares as an image, for {@link resolveFileDropTarget}. */
interface RegistryEntry {
  tagName: string;
  props?: { name: string; format?: unknown; [k: string]: unknown }[];
}

/**
 * Decide whether a drop replaces an existing picture or inserts a new element.
 *
 * A custom element qualifies only when its schema declares EXACTLY ONE `format: "image"` prop —
 * with two or more there is no non-arbitrary choice, so the drop falls through to an insert rather
 * than guessing which picture the author meant.
 *
 * `kind` gates the whole thing: dropping a video on an `<img>` is an insert, not a replace.
 */
export function resolveFileDropTarget(
  hit: FileDropHit | null,
  kind: UploadedAsset["kind"],
  registry: readonly RegistryEntry[] = componentRegistry,
): FileDropTarget {
  if (!hit || kind !== "image") {
    return { mode: "insert" };
  }
  const attr = REPLACE_ATTRS[hit.tagName];
  if (attr) {
    return { attr, mode: "replace-attr", path: hit.path as JxPath };
  }
  if (hit.tagName.includes("-")) {
    const entry = registry.find((c) => c.tagName === hit.tagName);
    const imageProps = (entry?.props ?? []).filter((p) => isMediaFormat(p.format));
    if (imageProps.length === 1) {
      return { mode: "replace-prop", path: hit.path as JxPath, prop: imageProps[0]!.name };
    }
  }
  return { mode: "insert" };
}

/**
 * The node an uploaded asset becomes when inserted. Images get a plain `<img>` (the build's
 * optimizer picks it up); playable media gets native controls so it is usable straight away;
 * anything else becomes a download link, which is the only sensible generic rendering.
 */
export function elementForAsset(asset: UploadedAsset): JxMutableNode {
  switch (asset.kind) {
    case "image": {
      return { attributes: { alt: "", src: asset.ref }, tagName: "img" } as JxMutableNode;
    }
    case "video": {
      return { attributes: { controls: "", src: asset.ref }, tagName: "video" } as JxMutableNode;
    }
    case "audio": {
      return { attributes: { controls: "", src: asset.ref }, tagName: "audio" } as JxMutableNode;
    }
    default: {
      return {
        attributes: { href: asset.ref },
        tagName: "a",
        textContent: asset.name,
      } as JxMutableNode;
    }
  }
}

/**
 * The target path for the `n`th file of a multi-file drop.
 *
 * Both reorder instructions derive their insert index from the path's trailing child index, so
 * advancing that index by `n` — with the instruction unchanged — lays the files down in the order
 * they were dropped. `make-child` appends, which is already ordered.
 */
export function nthDropPath(preview: DropPreview, n: number): JxPath {
  const path = [...preview.targetPath];
  const tail = path.at(-1);
  if (n === 0 || typeof tail !== "number") {
    return path as JxPath;
  }
  path[path.length - 1] = tail + n;
  return path as JxPath;
}

/**
 * Upload the dropped files and apply them to `tab`.
 *
 * A replace consumes only the first image (one element, one picture); an insert places every file.
 * A drop that resolved to no position (the canvas gutter, or a hit-test miss) appends to the
 * document root. Uploads that fail are already reported by `uploadAssets` and never appear here.
 */
export async function applyFileDrop(
  tab: Tab | null,
  files: File[],
  hit: FileDropHit | null,
  preview: DropPreview | null,
): Promise<void> {
  if (!tab || files.length === 0) {
    return;
  }
  const assets = await uploadAssets(files);
  const [first] = assets;
  if (!first) {
    return;
  }

  const target = resolveFileDropTarget(hit, first.kind);
  if (target.mode === "replace-attr") {
    transactDoc(tab, (t) => mutateUpdateAttribute(t, target.path, target.attr, first.ref));
    return;
  }
  if (target.mode === "replace-prop") {
    transactDoc(tab, (t) => mutateUpdateProp(t, target.path, target.prop, first.ref));
    return;
  }

  for (const [i, asset] of assets.entries()) {
    const srcData = { fragment: elementForAsset(asset), type: "block" };
    if (preview) {
      applyDropInstruction(tab, { type: preview.instruction }, srcData, nthDropPath(preview, i));
    } else {
      applyDropInstruction(tab, { type: "make-child" }, srcData, [] as unknown as JxPath);
    }
  }
}
