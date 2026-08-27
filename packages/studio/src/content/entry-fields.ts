/**
 * **Where a content entry's fields live**, and the one mutation that writes them.
 *
 * A collection has two storage shapes and exactly one editor, so the question "what record am I
 * editing?" has to be answered once, here, rather than assumed at every read site.
 *
 * - A **markdown** entry (or any file a format class parsed) is a frontmatter block plus a body. Its
 *   fields are `tab.doc.content.frontmatter`; `tab.doc.document` is the prose.
 * - A **JSON** entry (site-architecture.md §6.2's native collection shape) has no frontmatter block
 *   to split off. `files/files.ts` parses it straight into `tab.doc.document`, and
 *   `files/file-ops.ts` writes that object back as the whole file. Its fields ARE the document.
 *
 * The Entry editor read `content.frontmatter` unconditionally. For a JSON entry that record is `{}`
 * — so the form drew blank rows for an entry full of data, `absentRequiredErrors` accused a valid
 * entry of missing its required fields, and every keystroke was committed to a record that
 * `serializeDocument` never writes: the edit marked the tab dirty, survived undo, and was discarded
 * by ⌘S under a "Saved" toast. Three symptoms, one wrong assumption about storage.
 *
 * **The discriminator is the serializer's own ladder, not a guess about the extension.**
 * `serializeDocument` writes `JSON.stringify(tab.doc.document)` for exactly one kind of tab: no
 * format class claimed it (`sourceFormat === null`) and it is not a content-mode document. Those
 * are the two reads {@link fieldsAreDocument} makes, so "which record does the form edit" and
 * "which record does save write" cannot drift apart — and if a project ever registers a format
 * class for `.json`, both answers move together to frontmatter.
 *
 * Both shapes mutate with the same semantics — `undefined`, `null` and `""` remove the key, every
 * other value is written — so an author cannot tell from the form's behaviour which one they are
 * editing. That is the point.
 */

import { cloneValue } from "@jxsuite/collab/ops";
import { notePreviewOverlayEdit } from "../preview/preview-overlay";
import { recordDocOp } from "../tabs/patch-ops";
import { mutateUpdateFrontmatter, transactDoc } from "../tabs/transact";
import type { Tab } from "../tabs/tab";
import type { JsonValue } from "../types";

/**
 * Whether this tab's entry fields are the document itself rather than a frontmatter block.
 *
 * Mirrors `files/file-ops.ts`'s `serializeDocument` fall-through: a tab with no serializing format
 * and no content mode round-trips as raw JSON, so anything not in `tab.doc.document` is not saved.
 *
 * Deliberately NOT exported. The answer is only ever useful as the record it selects, and a second
 * caller branching on it would be the beginning of the fork this module exists to prevent —
 * {@link entryFields} and {@link mutateEntryField} are the whole interface.
 */
function fieldsAreDocument(tab: Tab): boolean {
  return tab.doc.sourceFormat == null && tab.doc.mode !== "content";
}

/**
 * The record this entry's fields live in — the one the form draws, validates and repaints from.
 *
 * Returned live, not copied: the caller reads it during a render that is already tracking the
 * reactive tab, and a copy would break that. It is also the identity a caller can compare against
 * `tab.doc.document` to see which store answered.
 */
export function entryFields(tab: Tab): Record<string, unknown> {
  return fieldsAreDocument(tab)
    ? (tab.doc.document as unknown as Record<string, unknown>)
    : (tab.doc.content?.frontmatter ?? {});
}

/**
 * Set one document-root key, recording the forward/inverse pair history and the collab bridge
 * replay from. The same shape `mutateUpdateFrontmatter` records for a frontmatter key, against the
 * other store — a JSON entry's field change is a genuine document op, so unlike a frontmatter op it
 * also reaches a co-editor.
 *
 * No canvas patch op: a JSON entry has no rendered node for the key, and an unrecorded patch batch
 * is already the "not surgically patchable, fall back" signal `transactDoc` reads.
 */
function mutateDocumentField(tab: Tab, field: string, value?: JsonValue): void {
  const doc = tab.doc.document as unknown as Record<string, unknown>;
  const before = Object.hasOwn(doc, field) ? cloneValue(doc[field]) : undefined;
  const deletes = value === undefined || value === null || value === "";
  if (deletes) {
    delete doc[field];
  } else {
    doc[field] = value;
  }
  const after = deletes ? undefined : cloneValue(value);
  recordDocOp({
    forward: { key: field, op: "set-key", path: [], value: after },
    inverse: { key: field, op: "set-key", path: [], value: before },
  });
  tab.doc.dirty = true;
  /* The document's ROOT REFERENCE is untouched here — the key is written in place — so the preview
     overlay's effect, which reads that reference, sees nothing. `transactDoc` and the Monaco source
     commit both assign a fresh one and need no such call; this path is the exception, and without
     the note an entry field edited twice would stop reaching a live preview after the first. */
  notePreviewOverlayEdit();
}

/**
 * Set one entry field, in whichever record this entry keeps its fields in.
 *
 * A mutation, not a transaction: callers wrap it in `transactDoc` so a multi-key change is one undo
 * step.
 */
export function mutateEntryField(tab: Tab, field: string, value?: JsonValue): void {
  if (fieldsAreDocument(tab)) {
    mutateDocumentField(tab, field, value);
  } else {
    mutateUpdateFrontmatter(tab, field, value);
  }
}

/**
 * Commit a form patch onto this entry's fields, in ONE transaction.
 *
 * `renderForm` emits single-key patches today, but committing per key would put a multi-key patch
 * on the undo stack as several steps — and an author who changed one thing expects one ⌘Z.
 */
export function commitEntryFields(tab: Tab, patch: Record<string, unknown>): void {
  transactDoc(tab, (t) => {
    for (const [field, value] of Object.entries(patch)) {
      mutateEntryField(t, field, value as JsonValue);
    }
  });
}
