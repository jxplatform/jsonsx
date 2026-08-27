/**
 * Legacy handler surface — kept for the chromium/ dev launcher and the test suite, which import
 * these free functions and drive a single process-global project root via setProjectRoot/
 * getProjectRoot. All real logic now lives in project-session.ts; this module is a thin shim over
 * one shared default ProjectSession. The Electrobun multi-window path (index.ts/window-manager.ts)
 * does NOT use this default session — it creates an explicit ProjectSession per window.
 */

import { createProjectSession } from "./project-session";

/* `pickProjectFile` is session-free (it picks without binding), but it is re-exported HERE rather
   than imported straight from project-session so the launcher keeps ONE backend module boundary —
   which is also the seam this package's launcher tests mock. */
export { setFileDialog, setDirectoryDialog, pickProjectFile } from "./project-session";
export type { ProjectSession, ProxyResult, StudioSchema } from "./project-session";

const _default = createProjectSession(null);

export function setProjectRoot(root: string | null) {
  _default.setProjectRoot(root);
}

export function getProjectRoot(): string | null {
  return _default.projectRoot;
}

export const { listFormats } = _default;
export const { listExtensions } = _default;
export const { fetchProjectSchemas } = _default;
export const { formatAction } = _default;
export const { openProject } = _default;

export const { openExternal } = _default;
/* Registering a sink is what starts the filesystem watcher; the launcher points it at its push
   channel so the studio sidebar sees a file appear the moment it lands. */
export const { setFileEventSink } = _default;
export const { buildSite, previewSite, setPreviewOverlay, clearPreviewOverlay } = _default;
export const { createProject } = _default;
export const { listDirectory } = _default;
export const { handleReadFile } = _default;
export const { handleWriteFile } = _default;
export const { handleDeleteFile } = _default;
export const { handleRenameFile } = _default;
export const { findReferences } = _default;
export const { handleCreateDirectory } = _default;
export const { handleUploadFile } = _default;
export const { handleResolveSiteContext } = _default;
export const { discoverComponents } = _default;
export const { codeService } = _default;
export const { locateFile } = _default;
export const { searchFiles } = _default;
export const { fetchPluginSchema } = _default;
export const { jxResolve } = _default;
export const { jxServerFunction } = _default;
export const { dataConnections } = _default;
export const { dataConnectionTest } = _default;
export const { dataPush } = _default;
export const { dataRows } = _default;
export const { dataInsertRow } = _default;
export const { dataUpdateRow } = _default;
export const { dataDeleteRow } = _default;
export const { listSecrets } = _default;
export const { setSecrets } = _default;
