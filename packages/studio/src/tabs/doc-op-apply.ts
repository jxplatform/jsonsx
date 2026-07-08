/**
 * Pure document-op applier — folds a value-carrying {@link JxDocOp} into a bare (non-reactive)
 * document tree. Shared by two consumers that MUST stay byte-identical or undo/redo would drift
 * from live editing: history replay in the parent ({@link file://./transact.ts}) and the iframe
 * canvas's non-reactive shadow doc (the patch source-of-truth across the cross-origin bridge).
 *
 * The implementation is the canonical one in `@jxsuite/collab/ops` (yjs-free, so the slim
 * canvas-iframe bundle imports it without dragging yjs in); this module re-exports it so both sides
 * of the frame boundary — and the collab bridge — replay ops through one code path.
 */

export { applyDocOpToDoc, childArray, cloneValue } from "@jxsuite/collab/ops";
export type { JxDocOp } from "@jxsuite/collab/ops";
