/**
 * Monaco ↔ `Y.Text`: two-way character-level sync plus remote in-buffer cursors.
 *
 * This is the first-party replacement for `y-monaco`, which was abandonware — last published
 * 2024-07-31 — and was the one thing pinning Studio to `monaco-editor@0.55`, because 0.56 replaced
 * the deep `esm/vs/...` entrypoints it imports with a tree-shakable export map (studio.md §11.1).
 * The upstream module was ~220 lines, Studio built exactly one of them and called exactly one
 * method on it, so owning it costs less than working around it.
 *
 * **It touches no Monaco value at runtime, deliberately.** Upstream reaches for `new
 * monaco.Range(...)`, `new monaco.Selection(...)`, `Selection.createWithDirection(...)` and the
 * `SelectionDirection` enum — none of which is necessary, because every API it feeds takes a plain
 * object: `applyEdits` takes an `IRange` literal, `createDecorationsCollection` takes `IRange` too,
 * and `setSelection` has an `ISelection` overload where **direction is the field order** —
 * `selectionStart*` is the anchor, `position*` is the head — so the enum answers a question the
 * shape already answers. Monaco is therefore a TYPES-ONLY import here: the module stays off the
 * eager graph, and its tests drive it with structural doubles rather than a real editor, the same
 * way `services/monaco-buffer.ts` is tested and for the same reason `attachCursorStyles` takes
 * `document` as a parameter.
 *
 * Yjs is a real import, but through `@jxsuite/collab` — the single yjs import point (see the
 * comment on its barrel). Safe for the lazy graph because `canvas/canvas-render.ts` reaches THIS
 * module through `await import()`, which is what defers the payload (studio.md §11.1).
 *
 * The presence field it publishes is `selection`, reserved for it by
 * `@jxsuite/collab/awareness-types`, and the CSS class names it decorates with are the ones
 * `./monaco-cursors.ts` writes rules for. Both are wire-compatible with y-monaco, so a peer on an
 * older Studio still sees this client's caret and this client still sees theirs.
 *
 * @docs studio/publish/collaboration
 */

import {
  createAbsolutePositionFromRelativePosition,
  createRelativePositionFromTypeIndex,
} from "@jxsuite/collab";
import type * as Y from "yjs";
import type { editor } from "monaco-editor";
import type { AwarenessLike } from "./monaco-cursors";

/**
 * The slice of y-protocols Awareness the binding uses: {@link AwarenessLike} (which
 * `./monaco-cursors.ts` already defines for the style manager) plus the one writer it needs.
 */
export interface BindingAwareness extends AwarenessLike {
  setLocalStateField: (field: string, value: unknown) => void;
}

export interface MonacoYTextBindingOptions {
  /** The shared text. Must be attached to a `Y.Doc`. */
  text: Y.Text;
  /** The model to keep in sync with it. */
  model: editor.ITextModel;
  /** Editors whose carets are preserved across remote edits and published to peers. */
  editors?: Iterable<editor.ICodeEditor>;
  /** Presence connection. Omit (or pass null) for sync without cursors. */
  awareness?: BindingAwareness | null;
  /** Transaction origin for local keystrokes. */
  origin?: unknown;
}

/** A caret snapshotted as two positions that survive a concurrent edit. */
interface RelativeSelection {
  anchor: Y.RelativePosition;
  head: Y.RelativePosition;
}

/** A peer's published caret, as it arrives over the wire (JSON, hence `unknown` halves). */
interface PeerSelectionState {
  selection?: { anchor?: unknown; head?: unknown } | null;
}

/**
 * The `Y.Doc` a bound text must belong to.
 *
 * Every `RelativePosition` this module mints or resolves is resolved against it, so a detached
 * `Y.Text` is not a degraded binding — it is one whose cursors and remote deltas can never work.
 * Returning it non-nullable also keeps the closures below free of `!`: TypeScript does not carry a
 * narrowing across a function boundary, and the type it needs is simply `Y.Doc`.
 */
function docOf(text: Y.Text): Y.Doc {
  const { doc } = text;
  if (!doc) {
    throw new Error("bindMonacoToYText: the Y.Text has no Y.Doc — nothing to sync against");
  }
  return doc;
}

/**
 * Bind `model` to `text`, both ways, until the returned disposer is called.
 *
 * The disposer is idempotent and releases everything: listeners, decorations, and this client's
 * published caret. That last one is not tidiness — a client that leaves Code view without clearing
 * the field keeps drawing its caret and name flag in every peer's editor, at its last position, for
 * the life of the session.
 *
 * @param options - {@link MonacoYTextBindingOptions}
 * @returns Teardown. Also runs by itself when the model is disposed.
 */
export function bindMonacoToYText(options: MonacoYTextBindingOptions): () => void {
  const { awareness = null, model, origin, text } = options;
  const editors = [...(options.editors ?? [])];
  const doc = docOf(text);

  /* THE RE-ENTRANCY GUARD, and it is load-bearing in both directions.
     `model.applyEdits` fires `onDidChangeContent` SYNCHRONOUSLY, so applying a remote delta would
     otherwise write straight back into the Y.Text as if the user had typed it; and a local
     keystroke's transaction fires the Y observer, which would re-apply it to the model. Upstream
     spelled this `lib0/mutex`; it is one boolean. */
  let inApply = false;
  function guarded(run: () => void): void {
    if (inApply) {
      return;
    }
    inApply = true;
    try {
      run();
    } finally {
      inApply = false;
    }
  }

  let savedSelections = new Map<editor.ICodeEditor, RelativeSelection>();
  const decorations = new Map<editor.ICodeEditor, editor.IEditorDecorationsCollection>();

  /** An editor's caret as two `RelativePosition`s — also exactly the wire shape peers read. */
  function relativeSelectionOf(codeEditor: editor.ICodeEditor): RelativeSelection | null {
    const selection = codeEditor.getSelection();
    if (!selection) {
      return null;
    }
    return {
      anchor: createRelativePositionFromTypeIndex(
        text,
        model.getOffsetAt({
          column: selection.selectionStartColumn,
          lineNumber: selection.selectionStartLineNumber,
        }),
      ),
      head: createRelativePositionFromTypeIndex(
        text,
        model.getOffsetAt({
          column: selection.positionColumn,
          lineNumber: selection.positionLineNumber,
        }),
      ),
    };
  }

  /** Put a snapshotted caret back where the text moved it to. */
  function restoreSelection(codeEditor: editor.ICodeEditor, saved: RelativeSelection): void {
    const anchor = createAbsolutePositionFromRelativePosition(saved.anchor, doc);
    const head = createAbsolutePositionFromRelativePosition(saved.head, doc);
    if (!anchor || !head || anchor.type !== text || head.type !== text) {
      return;
    }
    const anchorPos = model.getPositionAt(anchor.index);
    const headPos = model.getPositionAt(head.index);
    /* Direction is the field order, which is why no `SelectionDirection` appears in this file:
       anchor first, head second, and an RTL selection is simply one whose head precedes it. */
    codeEditor.setSelection({
      positionColumn: headPos.column,
      positionLineNumber: headPos.lineNumber,
      selectionStartColumn: anchorPos.column,
      selectionStartLineNumber: anchorPos.lineNumber,
    });
  }

  /** Every peer caret that resolves against THIS text, as decorations over the current model. */
  function remoteDecorations(): editor.IModelDeltaDecoration[] {
    const result: editor.IModelDeltaDecoration[] = [];
    if (!awareness) {
      return result;
    }
    for (const [clientId, raw] of awareness.getStates()) {
      /* Filtered on the AWARENESS clientID, not the doc's, so this pairs with the self-filter in
         `./monaco-cursors.ts` — the module that writes the rules these class names need. */
      if (clientId === awareness.clientID) {
        continue;
      }
      const { selection } = (raw ?? {}) as PeerSelectionState;
      if (!selection?.anchor || !selection.head) {
        continue;
      }
      const anchor = createAbsolutePositionFromRelativePosition(
        selection.anchor as Y.RelativePosition,
        doc,
      );
      const head = createAbsolutePositionFromRelativePosition(
        selection.head as Y.RelativePosition,
        doc,
      );
      if (!anchor || !head || anchor.type !== text || head.type !== text) {
        continue;
      }
      const forward = anchor.index < head.index;
      const from = model.getPositionAt(forward ? anchor.index : head.index);
      const to = model.getPositionAt(forward ? head.index : anchor.index);
      // The caret sits at the HEAD end of the band, so which side carries it flips with direction.
      const headClass = `yRemoteSelectionHead yRemoteSelectionHead-${clientId}`;
      result.push({
        options: {
          className: `yRemoteSelection yRemoteSelection-${clientId}`,
          ...(forward
            ? { afterContentClassName: headClass }
            : { beforeContentClassName: headClass }),
        },
        range: {
          endColumn: to.column,
          endLineNumber: to.lineNumber,
          startColumn: from.column,
          startLineNumber: from.lineNumber,
        },
      });
    }
    return result;
  }

  /**
   * Repaint peer carets in every bound editor.
   *
   * Upstream held the decoration ids and called the deprecated `deltaDecorations`; a collection is
   * both the supported API and the one that can be CLEARED, which matters for an editor whose model
   * outlives the binding — it kept the last frame of everyone's cursors otherwise.
   */
  function renderRemoteSelections(): void {
    if (!awareness) {
      return;
    }
    const next = remoteDecorations();
    for (const codeEditor of editors) {
      if (codeEditor.getModel() !== model) {
        decorations.get(codeEditor)?.clear();
        continue;
      }
      let collection = decorations.get(codeEditor);
      if (!collection) {
        collection = codeEditor.createDecorationsCollection();
        decorations.set(codeEditor, collection);
      }
      collection.set(next);
    }
  }

  /* Snapshot every caret BEFORE the transaction moves the text under it, so the observer below has
     something position-independent to restore. Guarded, because a local keystroke's own transaction
     fires this too and its caret is already where the user put it. */
  function beforeTransaction(): void {
    guarded(() => {
      savedSelections = new Map();
      for (const codeEditor of editors) {
        if (codeEditor.getModel() !== model) {
          continue;
        }
        const saved = relativeSelectionOf(codeEditor);
        if (saved) {
          savedSelections.set(codeEditor, saved);
        }
      }
    });
  }

  /** Inbound: a remote (or undo) delta, walked into `model.applyEdits`. */
  function onTextChanged(event: Y.YTextEvent): void {
    guarded(() => {
      let index = 0;
      for (const op of event.delta) {
        if (op.retain !== undefined) {
          index += op.retain;
          continue;
        }
        if (op.delete !== undefined) {
          const from = model.getPositionAt(index);
          const to = model.getPositionAt(index + op.delete);
          model.applyEdits([
            {
              range: {
                endColumn: to.column,
                endLineNumber: to.lineNumber,
                startColumn: from.column,
                startLineNumber: from.lineNumber,
              },
              text: "",
            },
          ]);
          continue;
        }
        /* Not a retain and not a delete, so it must be an insert of text. `Y.Text` can also hold
           embeds (`insert` is then an object or another type), and a Monaco buffer has nowhere to
           put one — upstream cast the field to string and produced `"[object Object]"` in the
           document. The same clause catches an op carrying none of the three fields. */
        if (typeof op.insert !== "string") {
          throw new TypeError(
            "bindMonacoToYText: unsupported Y.Text delta op — a text buffer can only apply " +
              "string inserts",
          );
        }
        const at = model.getPositionAt(index);
        model.applyEdits([
          {
            range: {
              endColumn: at.column,
              endLineNumber: at.lineNumber,
              startColumn: at.column,
              startLineNumber: at.lineNumber,
            },
            text: op.insert,
          },
        ]);
        index += op.insert.length;
      }
      for (const [codeEditor, saved] of savedSelections) {
        restoreSelection(codeEditor, saved);
      }
    });
    renderRemoteSelections();
  }

  /** Outbound: the author typed. */
  function onModelChanged(event: editor.IModelContentChangedEvent): void {
    guarded(() => {
      doc.transact(() => {
        /* Right to left. Every `rangeOffset` in the event indexes the PRE-edit text, so applying
           them in document order would shift every offset after the first. Copied before sorting —
           `event.changes` is the model's own readonly array. */
        for (const change of [...event.changes].toSorted((a, b) => b.rangeOffset - a.rangeOffset)) {
          text.delete(change.rangeOffset, change.rangeLength);
          text.insert(change.rangeOffset, change.text);
        }
      }, origin);
    });
  }

  const disposables: { dispose: () => void }[] = [];
  let disposed = false;

  function destroy(): void {
    if (disposed) {
      return;
    }
    disposed = true;
    for (const disposable of disposables) {
      disposable.dispose();
    }
    disposables.length = 0;
    text.unobserve(onTextChanged);
    doc.off("beforeAllTransactions", beforeTransaction);
    for (const collection of decorations.values()) {
      collection.clear();
    }
    decorations.clear();
    savedSelections.clear();
    if (awareness) {
      awareness.off("change", renderRemoteSelections);
      /* AND STOP PUBLISHING THIS CLIENT'S CARET. `null` is a legal value for the field
         (awareness-types.ts), and without it every peer still in Code view keeps drawing our caret
         and name flag at the position we left, for as long as the session lasts. */
      awareness.setLocalStateField("selection", null);
    }
  }

  doc.on("beforeAllTransactions", beforeTransaction);
  text.observe(onTextChanged);

  /* Seed the buffer BEFORE the change handler exists, so the seed is not echoed back at the room
     as if the author had typed the whole document. */
  const shared = text.toString();
  if (model.getValue() !== shared) {
    model.setValue(shared);
  }

  disposables.push(model.onDidChangeContent(onModelChanged), model.onWillDispose(destroy));

  if (awareness) {
    for (const codeEditor of editors) {
      disposables.push(
        codeEditor.onDidChangeCursorSelection(() => {
          if (codeEditor.getModel() !== model) {
            return;
          }
          const selection = relativeSelectionOf(codeEditor);
          if (selection) {
            awareness.setLocalStateField("selection", selection);
          }
        }),
      );
    }
    /* ONCE, outside the loop. Upstream registered this per editor and unregistered it once, which
       was correct only because lib0's Observable happens to dedupe listeners in a Set. */
    awareness.on("change", renderRemoteSelections);
    /* Paint once at bind time. Peers already in the buffer have a published caret, and waiting for
       their next keystroke to draw it makes a room that is merely quiet look like a room that is
       empty. */
    renderRemoteSelections();
  }

  return destroy;
}
