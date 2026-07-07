import "./with-dom.js";
import { createTab, disposeTab } from "../src/tabs/tab";
import type { Tab } from "../src/tabs/tab";
import type { JxMutableNode } from "@jxsuite/schema/types";
import type { TransactionRecord } from "../src/tabs/patch-ops";
import {
  applyExternalDocOps,
  beginBatch,
  canRedo,
  canUndo,
  endBatch,
  getHistoryDelegate,
  mutateInsertNode,
  mutateUpdateProperty,
  redo,
  setBatchEndNotifier,
  setHistoryDelegate,
  setTransactObserver,
  transactDoc,
  undo,
} from "../src/tabs/transact";
import type { TransactOrigin } from "../src/tabs/transact";
import { afterEach, describe, expect, test } from "bun:test";

function makeTab(doc?: JxMutableNode) {
  const document = doc ?? {
    children: [{ tagName: "p", textContent: "Hello" }],
    tagName: "div",
  };
  return createTab({ document, id: "test-seams" });
}

interface Seen {
  tab: Tab;
  record: TransactionRecord;
  origin: TransactOrigin;
}

afterEach(() => {
  setTransactObserver(null);
  setBatchEndNotifier(null);
});

describe("setTransactObserver", () => {
  test("observer sees the record and default user origin after the dirty mark", () => {
    const tab = makeTab();
    const seen: Seen[] = [];
    let dirtyAtObserve = false;
    setTransactObserver((t, record, origin) => {
      seen.push({ origin, record, tab: t });
      dirtyAtObserve = t.doc.dirty;
    });

    transactDoc(tab, (t) => mutateInsertNode(t, [], 1, { tagName: "span" }));

    expect(seen).toHaveLength(1);
    expect(seen[0]!.origin).toBe("user");
    expect(seen[0]!.tab).toBe(tab);
    expect(seen[0]!.record.docOps).toHaveLength(1);
    expect(seen[0]!.record.docOps[0]!.forward.op).toBe("insert-child");
    expect(dirtyAtObserve).toBe(true);

    disposeTab(tab);
  });

  test("un-instrumented mutations still notify, with an empty record", () => {
    const tab = makeTab();
    const seen: Seen[] = [];
    setTransactObserver((t, record, origin) => seen.push({ origin, record, tab: t }));

    transactDoc(tab, (t) => {
      (t.doc.document as { tagName?: string }).tagName = "section";
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.record.docOps).toHaveLength(0);

    disposeTab(tab);
  });

  test("unregistering stops notifications", () => {
    const tab = makeTab();
    let calls = 0;
    setTransactObserver(() => {
      calls += 1;
    });
    setTransactObserver(null);

    transactDoc(tab, (t) => mutateInsertNode(t, [], 1, { tagName: "span" }));

    expect(calls).toBe(0);
    disposeTab(tab);
  });

  test("undo and redo report the history origin", () => {
    const tab = makeTab();
    transactDoc(tab, (t) => mutateInsertNode(t, [], 1, { tagName: "span" }));

    const origins: TransactOrigin[] = [];
    setTransactObserver((_t, _record, origin) => origins.push(origin));
    undo(tab);
    redo(tab);

    expect(origins).toEqual(["history", "history"]);
    disposeTab(tab);
  });
});

describe("applyExternalDocOps", () => {
  test("applies remote ops through the pipeline with remote origin and no history entry", () => {
    const tab = makeTab();
    const origins: TransactOrigin[] = [];
    setTransactObserver((_t, _record, origin) => origins.push(origin));

    applyExternalDocOps(tab, [
      { index: 1, node: { tagName: "aside" }, op: "insert-child", parentPath: [] },
      { key: "textContent", op: "set-key", path: ["children", 0], value: "Remote" },
    ]);

    expect(origins).toEqual(["remote"]);
    expect(tab.history.snapshots).toHaveLength(1);
    const doc = tab.doc.document as {
      children: { tagName?: string; textContent?: string }[];
    };
    expect(doc.children).toHaveLength(2);
    expect(doc.children[1]!.tagName).toBe("aside");
    expect(doc.children[0]!.textContent).toBe("Remote");
    expect(tab.doc.dirty).toBe(true);

    disposeTab(tab);
  });
});

describe("history delegate", () => {
  function delegateStub(log: string[]) {
    return {
      canRedo: () => {
        log.push("canRedo");
        return true;
      },
      canUndo: () => {
        log.push("canUndo");
        return false;
      },
      redo: () => log.push("redo"),
      undo: () => log.push("undo"),
    };
  }

  test("undo/redo/canUndo/canRedo route to the registered delegate", () => {
    const tab = makeTab();
    transactDoc(tab, (t) => mutateInsertNode(t, [], 1, { tagName: "span" }));
    const log: string[] = [];
    setHistoryDelegate(tab, delegateStub(log));

    undo(tab);
    redo(tab);
    expect(canUndo(tab)).toBe(false);
    expect(canRedo(tab)).toBe(true);
    expect(log).toEqual(["undo", "redo", "canUndo", "canRedo"]);
    // The snapshot history was never touched by the delegated undo.
    expect(tab.history.index).toBe(1);

    setHistoryDelegate(tab, null);
    expect(getHistoryDelegate(tab)).toBeNull();
    disposeTab(tab);
  });

  test("without a delegate, canUndo/canRedo read the snapshot history", () => {
    const tab = makeTab();
    expect(canUndo(tab)).toBe(false);
    expect(canRedo(tab)).toBe(false);

    transactDoc(tab, (t) => mutateUpdateProperty(t, ["children", 0], "textContent", "Hi"));
    expect(canUndo(tab)).toBe(true);
    expect(canRedo(tab)).toBe(false);

    undo(tab);
    expect(canUndo(tab)).toBe(false);
    expect(canRedo(tab)).toBe(true);
    disposeTab(tab);
  });
});

describe("batch end hook", () => {
  test("notifier fires with the batched tab after endBatch", () => {
    const tab = makeTab();
    const notified: Tab[] = [];
    setBatchEndNotifier((t) => notified.push(t));

    beginBatch(tab);
    transactDoc(tab, (t) => mutateInsertNode(t, [], 1, { tagName: "span" }));
    endBatch();

    expect(notified).toEqual([tab]);
    // Default (no delegate) behavior still pushes the one batch snapshot.
    expect(tab.history.snapshots).toHaveLength(2);
    disposeTab(tab);
  });

  test("a registered delegate suppresses the batch snapshot push", () => {
    const tab = makeTab();
    setHistoryDelegate(tab, {
      canRedo: () => false,
      canUndo: () => false,
      redo: () => {},
      undo: () => {},
    });

    beginBatch(tab);
    transactDoc(tab, (t) => mutateInsertNode(t, [], 1, { tagName: "span" }));
    endBatch();

    expect(tab.history.snapshots).toHaveLength(1);
    setHistoryDelegate(tab, null);
    disposeTab(tab);
  });
});
