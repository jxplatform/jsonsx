import "./with-dom.js";
import { effect } from "../src/reactivity";
import { createTab, disposeTab } from "../src/tabs/tab";
import { test, expect, describe } from "bun:test";

describe("Tab primitive", () => {
  test("createTab returns reactive doc/session/history", () => {
    const tab = createTab({
      id: "test-1",
      documentPath: "components/button.json",
      document: { tagName: "div", children: [] },
    });

    expect(tab.id).toBe("test-1");
    expect(tab.documentPath).toBe("components/button.json");
    expect(tab.doc.document.tagName).toBe("div");
    expect(tab.doc.mode).toBe("component");
    expect(tab.doc.dirty).toBe(false);
    expect(tab.session.selection).toBe(null);
    expect(tab.session.ui.rightTab).toBe("properties");
    expect(tab.history.index).toBe(0);
    expect(tab.history.snapshots).toHaveLength(1);

    disposeTab(tab);
  });

  test("markdown file sets mode to content", () => {
    const tab = createTab({
      id: "test-md",
      documentPath: "pages/index.md",
      document: { tagName: "main" },
    });

    expect(tab.doc.mode).toBe("content");
    disposeTab(tab);
  });

  test("effects track reactive mutations on doc", () => {
    const tab = createTab({
      id: "test-2",
      document: { tagName: "div" },
    });

    let observed = false;
    const stop = effect(() => {
      observed = tab.doc.dirty;
    });

    expect(observed).toBe(false);
    tab.doc.dirty = true;
    expect(observed).toBe(true);

    stop();
    disposeTab(tab);
  });

  test("effects track reactive mutations on session", () => {
    const tab = createTab({
      id: "test-3",
      document: { tagName: "div" },
    });

    let observedSelection: (string | number)[] | null = null;
    const stop = effect(() => {
      observedSelection = tab.session.selection;
    });

    expect(observedSelection).toBe(null);
    tab.session.selection = [0, 1];
    expect(observedSelection as (string | number)[] | null).toEqual([0, 1]);

    stop();
    disposeTab(tab);
  });

  test("disposeTab stops effects created in tab scope", () => {
    const tab = createTab({
      id: "test-4",
      document: { tagName: "div" },
    });

    let runs = 0;
    tab.scope.run(() => {
      effect(() => {
        runs++;
        void tab.doc.dirty;
      });
    });

    expect(runs).toBe(1);
    tab.doc.dirty = true;
    expect(runs).toBe(2);

    disposeTab(tab);

    tab.doc.dirty = false;
    expect(runs).toBe(2);
  });

  test("history snapshot is a deep clone of the document", () => {
    const doc = { tagName: "div", children: [{ tagName: "p" }] };
    const tab = createTab({ id: "test-5", document: doc });

    doc.children.push({ tagName: "span" });
    expect(tab.history.snapshots[0].document.children).toHaveLength(1);

    disposeTab(tab);
  });

  test("frontmatter is stored in doc.content", () => {
    const tab = createTab({
      id: "test-6",
      documentPath: "pages/about.md",
      document: { tagName: "main" },
      frontmatter: { title: "About", layout: "default" },
    });

    expect(tab.doc.content.frontmatter.title).toBe("About");
    expect(tab.doc.content.frontmatter.layout).toBe("default");

    disposeTab(tab);
  });
});
