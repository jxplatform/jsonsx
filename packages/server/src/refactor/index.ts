/**
 * Public entrypoint for the rename-refactor engine (`@jxsuite/server/refactor`), shared by the
 * dev-server endpoint and the desktop project session.
 */

export { applyRename, deriveTag } from "./apply.ts";
export type { ApplyRenameOptions, FileChange, RenameReport } from "./apply.ts";
export { findReferences, invalidateReferenceCache } from "./find-refs.ts";
export type {
  FindReferencesOptions,
  ReferenceFile,
  ReferenceHit,
  ReferencesResult,
} from "./find-refs.ts";
export { coalesceFsEvents, toFsEvent } from "./fs-events.ts";
export type { FsEventPayload } from "./fs-events.ts";
export { createFsWatcher } from "./watcher.ts";
export type { FsWatcherHandle } from "./watcher.ts";
