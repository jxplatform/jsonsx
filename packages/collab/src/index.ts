export type { JxDocOp, JxDocOpPair } from "./ops.ts";
export { applyDocOpToDoc, childArray, cloneValue, getNodeAtPath } from "./ops.ts";
export {
  COLLAB_SCHEMA_VERSION,
  FRONTMATTER_KEY,
  frontmatterMap,
  META_KEY,
  metaMap,
  resolveYPath,
  seedStructure,
  SOURCE_KEY,
  sourceText,
  STRUCTURE_KEY,
  structureMap,
  toYChildren,
  toYNode,
  updateSourceText,
  yDocToJson,
  yValueToJson,
} from "./schema.ts";
// Re-exported so consumers keep a single yjs import point (avoids dual-instance hazards).
export { Doc as YDoc, UndoManager } from "yjs";
export {
  applyDocOpsToY,
  CollabPathError,
  LOCAL_ORIGIN,
  MIRROR_ORIGIN,
  SEED_ORIGIN,
  yEventsToDocOps,
} from "./op-bridge.ts";
export { deepEqual, diffDocs, replaceYStructure } from "./diff.ts";
export {
  acquireSourceCanonical,
  canonicalOf,
  canonicalRevOf,
  isSourceReconciler,
  otherSourceEditors,
  releaseSourceCanonical,
} from "./source-lock.ts";
export type { CanonicalRepresentation } from "./source-lock.ts";
export type { DiffOptions } from "./diff.ts";
export {
  decodeFrame,
  encodeFrame,
  EnvelopeError,
  FRAME_AWARENESS,
  FRAME_CONTROL,
  FRAME_DOC_CLOSE,
  FRAME_DOC_SYNC,
} from "./envelope.ts";
export type { CollabFrame, CollabPermission, ControlMessage } from "./envelope.ts";
export { colorForKey, PRESENCE_PALETTE } from "./awareness-types.ts";
export type { CollabAwarenessState, CollabUser } from "./awareness-types.ts";
export type { CollabCapability, CollabHandle, CollabIdentity, CollabStatus } from "./provider.ts";
