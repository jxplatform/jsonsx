/// <reference lib="dom" />
/**
 * Media upload core — the single path every upload surface goes through.
 *
 * Four surfaces feed it: the image field's Upload button (ui/media-picker), a file dropped on the
 * canvas (editor/file-drop-action), a file dropped on the Files tree (files/files), and the Manage
 * view's drop zone / Upload button (browse/browse). They differ only in how the destination
 * directory is chosen; naming, collision handling, the platform call, and cache invalidation are
 * shared here.
 *
 * Destination (specs/site-architecture.md §9.1/§9.3): a document inside a content collection keeps
 * its media co-located in `content/<collection>/images/` — the entry references it file-relatively
 * and the collection loader rewrites it to the asset mount. Everything else goes to `public/`,
 * which is served from the site root.
 *
 * @docs studio/projects/media
 */

import { errorMessage } from "@jxsuite/schema/parse";
import { getPlatform } from "../platform";
import { statusMessage } from "../panels/statusbar";
import { activeTab } from "../workspace/workspace";

// ─── File classification ─────────────────────────────────────────────────────

/** Extensions rendered as a thumbnail (media picker, Manage cards, file-tree icons). */
export const IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".svg",
  ".webp",
  ".avif",
  ".ico",
]);

/** Every extension Studio treats as project media. Superset of {@link IMAGE_EXTENSIONS}. */
export const MEDIA_EXTENSIONS = new Set([
  ...IMAGE_EXTENSIONS,
  ".mp4",
  ".webm",
  ".mp3",
  ".wav",
  ".ogg",
  ".pdf",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
]);

/** The `accept` attribute for every upload file input. */
export const UPLOAD_ACCEPT = [
  "image/*",
  "video/*",
  "audio/*",
  ".pdf",
  ".svg",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
].join(",");

/** What kind of element an uploaded asset wants to become. */
export type AssetKind = "image" | "video" | "audio" | "file";

/** One successfully uploaded file. */
export interface UploadedAsset {
  /** Project-relative path written, e.g. `public/hero.jpg`. */
  path: string;
  /** The filename actually used (may carry a collision suffix). */
  name: string;
  /** The reference to write into a document `src`/prop, e.g. `/hero.jpg`. */
  ref: string;
  kind: AssetKind;
}

/** Lowercased extension including the dot, or `""` when the name carries none. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

/** Whether a file extension (with or without the leading dot) is a previewable image. */
export function isImage(ext: string): boolean {
  return IMAGE_EXTENSIONS.has(ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`);
}

/** Whether a filename is project media. */
export function isMediaFile(name: string): boolean {
  return MEDIA_EXTENSIONS.has(extensionOf(name));
}

const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".m4v"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".ogg", ".m4a", ".flac"]);

/**
 * Classify a file by MIME type, falling back to its extension. A drop from the OS usually carries a
 * `type`, but it is empty for unrecognized extensions and for some Linux file managers.
 */
export function mediaKind(file: { name: string; type?: string }): AssetKind {
  const mime = file.type ?? "";
  if (mime.startsWith("image/")) {
    return "image";
  }
  if (mime.startsWith("video/")) {
    return "video";
  }
  if (mime.startsWith("audio/")) {
    return "audio";
  }
  const ext = extensionOf(file.name);
  if (IMAGE_EXTENSIONS.has(ext)) {
    return "image";
  }
  if (VIDEO_EXTENSIONS.has(ext)) {
    return "video";
  }
  if (AUDIO_EXTENSIONS.has(ext)) {
    return "audio";
  }
  return "file";
}

// ─── Destination resolution ──────────────────────────────────────────────────

/** Matches a path inside a content collection: `content/<collection>/…`. */
const CONTENT_ENTRY = /^content\/([^/]+)\//;

/**
 * The directory an upload lands in when the caller doesn't name one. A document inside a content
 * collection gets `content/<collection>/images`; everything else gets `public`.
 */
export function uploadDirFor(documentPath: string | null): string {
  const match = documentPath ? CONTENT_ENTRY.exec(documentPath.replaceAll("\\", "/")) : null;
  return match ? `content/${match[1]}/images` : "public";
}

/**
 * The reference to write into a document for a file at `destPath`.
 *
 * `public/` is served from the site root, so its contents get a root-relative `/name`. A content
 * asset is referenced relative to the entry that owns it (`./images/name`) so the collection loader
 * rewrites it to the asset mount. Anything else is project-root relative (`./dir/name`), which is
 * how the compiler resolves a non-`/` path.
 */
export function assetRef(destPath: string): string {
  const path = destPath.replaceAll("\\", "/");
  if (path.startsWith("public/")) {
    return path.slice("public".length);
  }
  const content = /^content\/[^/]+\/(.+)$/.exec(path);
  if (content) {
    return `./${content[1]}`;
  }
  return `./${path}`;
}

/**
 * A filename that doesn't collide with `taken`, suffixing `-1`, `-2`, … before the extension. Never
 * overwrites existing media (the previous behaviour clobbered silently).
 */
export function uniqueName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) {
    return name;
  }
  const ext = extensionOf(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  for (let i = 1; ; i++) {
    const candidate = `${base}-${i}${ext}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}

/** Join a directory and a filename, treating `.` (project root) as no prefix. */
export function joinDir(dir: string, name: string): string {
  const normalized = dir.replaceAll("\\", "/").replace(/\/+$/, "");
  return normalized === "." || normalized === "" ? name : `${normalized}/${name}`;
}

// ─── Cache invalidation (injected) ───────────────────────────────────────────

/**
 * Called after a batch of uploads with the directory they landed in. Injected from studio.ts so
 * this module doesn't import the media-picker / Manage / file-tree caches it needs to invalidate
 * (they all import from here) — the same injection pattern as the canvas host's drop handlers.
 */
let mediaChangedHandler: ((dir: string) => void | Promise<void>) | null = null;

/** Register the post-upload cache invalidator (see {@link mediaChangedHandler}). */
export function setMediaChangedHandler(fn: ((dir: string) => void | Promise<void>) | null): void {
  mediaChangedHandler = fn;
}

// ─── Upload ──────────────────────────────────────────────────────────────────

/**
 * Upload files into the project and report what landed.
 *
 * `opts.dir` names the destination explicitly (the file tree's target folder, the Manage view's
 * active category); without it the destination follows the active document via {@link uploadDirFor}.
 * Names are made collision-free against a single listing of the destination. A file that fails to
 * upload is reported and skipped — the rest of the batch still lands.
 */
export async function uploadAssets(
  files: Iterable<File>,
  opts: { dir?: string } = {},
): Promise<UploadedAsset[]> {
  const list = [...files];
  if (list.length === 0) {
    return [];
  }
  const platform = getPlatform();
  const dir = opts.dir ?? uploadDirFor(activeTab.value?.documentPath ?? null);

  let taken: Set<string>;
  try {
    const existing = await platform.listDirectory(dir);
    taken = new Set(existing.map((entry) => entry.name));
  } catch {
    taken = new Set(); // Directory doesn't exist yet — the backend mkdir -p's on write.
  }

  const uploaded: UploadedAsset[] = [];
  for (const file of list) {
    const name = uniqueName(file.name, taken);
    taken.add(name);
    const path = joinDir(dir, name);
    try {
      await platform.uploadFile(path, file);
      uploaded.push({ kind: mediaKind(file), name, path, ref: assetRef(path) });
    } catch (error) {
      statusMessage(`Upload failed: ${file.name} — ${errorMessage(error)}`);
    }
  }

  if (uploaded.length > 0) {
    statusMessage(
      uploaded.length === 1
        ? `Uploaded ${uploaded[0]!.name} to ${dir}/`
        : `Uploaded ${uploaded.length} files to ${dir}/`,
    );
    await mediaChangedHandler?.(dir);
  }
  return uploaded;
}
