/**
 * Minimal two-way binding between a Monaco model and the shared source Y.Text. Deliberately
 * duck-typed (no yjs import — the text arrives through the collab session's dynamic module) and
 * deliberately small: character-level merging comes from Y.Text itself; remote cursor decorations
 * are a later nicety (y-monaco can replace this wholesale once adopted).
 */

/** The slice of Y.Text the binding uses. */
export interface SharedTextLike {
  toString: () => string;
  insert: (index: number, text: string) => void;
  delete: (index: number, length: number) => void;
  observe: (cb: (event: SharedTextEvent, transaction: { origin: unknown }) => void) => void;
  unobserve: (cb: (event: SharedTextEvent, transaction: { origin: unknown }) => void) => void;
  doc: { transact: (fn: () => void, origin?: unknown) => void } | null;
}

export interface SharedTextEvent {
  delta: { retain?: number; delete?: number; insert?: string | unknown[] }[];
}

/** The slice of a Monaco model/editor the binding uses. */
export interface MonacoModelLike {
  getValue: () => string;
  getPositionAt: (offset: number) => unknown;
  applyEdits: (edits: { range: unknown; text: string }[]) => unknown;
  onDidChangeContent: (
    cb: (event: { changes: { rangeOffset: number; rangeLength: number; text: string }[] }) => void,
  ) => { dispose: () => void };
  isDisposed?: () => boolean;
}

export interface MonacoRangeFactory {
  fromPositions: (start: unknown, end: unknown) => unknown;
}

export function bindMonacoToSharedText(opts: {
  model: MonacoModelLike;
  rangeFactory: MonacoRangeFactory;
  text: SharedTextLike;
  localOrigin: unknown;
}): { dispose: () => void } {
  const { model, rangeFactory, text, localOrigin } = opts;
  let muted = false;

  // Adopt the shared text as the buffer's initial content.
  muted = true;
  const initial = text.toString();
  if (model.getValue() !== initial) {
    const start = model.getPositionAt(0);
    const end = model.getPositionAt(model.getValue().length);
    model.applyEdits([{ range: rangeFactory.fromPositions(start, end), text: initial }]);
  }
  muted = false;

  const contentSub = model.onDidChangeContent((event) => {
    if (muted) {
      return;
    }
    // Apply in reverse offset order so earlier edits don't shift later offsets.
    const changes = [...event.changes].toSorted((a, b) => b.rangeOffset - a.rangeOffset);
    const apply = () => {
      for (const change of changes) {
        if (change.rangeLength > 0) {
          text.delete(change.rangeOffset, change.rangeLength);
        }
        if (change.text.length > 0) {
          text.insert(change.rangeOffset, change.text);
        }
      }
    };
    if (text.doc) {
      text.doc.transact(apply, localOrigin);
    } else {
      apply();
    }
  });

  const textObserver = (event: SharedTextEvent, transaction: { origin: unknown }) => {
    if (transaction.origin === localOrigin || model.isDisposed?.()) {
      return;
    }
    muted = true;
    try {
      let index = 0;
      for (const delta of event.delta) {
        if (delta.retain !== undefined) {
          index += delta.retain;
        } else if (delta.delete !== undefined) {
          model.applyEdits([
            {
              range: rangeFactory.fromPositions(
                model.getPositionAt(index),
                model.getPositionAt(index + delta.delete),
              ),
              text: "",
            },
          ]);
        } else if (typeof delta.insert === "string") {
          const position = model.getPositionAt(index);
          model.applyEdits([
            { range: rangeFactory.fromPositions(position, position), text: delta.insert },
          ]);
          index += delta.insert.length;
        }
      }
    } finally {
      muted = false;
    }
  };
  text.observe(textObserver);

  return {
    dispose: () => {
      contentSub.dispose();
      text.unobserve(textObserver);
    },
  };
}
