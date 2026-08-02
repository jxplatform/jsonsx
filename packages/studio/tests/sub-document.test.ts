/**
 * Sub-documents — the stack that survives now that drill-in opens a real tab.
 *
 * Only genuine sub-documents ($map templates, function bodies) push a frame, and a frame carries
 * the whole UI context so popping restores WHERE YOU WERE, not just what you were looking at.
 */
import "./with-dom.js";
import { describe, expect, test } from "bun:test";
import {
  captureTabUi,
  createTab,
  disposeTab,
  popSubDocument,
  popToSubDocument,
  pushSubDocument,
  restoreTabUi,
} from "../src/tabs/tab";
import type { Tab } from "../src/tabs/tab";

function parentTab(): Tab {
  const tab = createTab({
    document: { children: [{ tagName: "p" }], tagName: "main" },
    documentPath: "pages/index.json",
    id: "pages/index.json",
  });
  Object.assign(tab.session.ui, {
    activeMedia: "@md",
    activeSelector: ":hover",
    featureToggles: { motion: true },
    previewParams: { slug: "hello" },
    previewProps: { title: "Hi" },
    rightTab: "style",
    zoom: 0.75,
  });
  tab.session.selection = ["children", 0];
  tab.doc.dirty = true;
  return tab;
}

describe("captureTabUi", () => {
  test("copies the nested records so the frame cannot be mutated through the live tab", () => {
    const tab = parentTab();
    const snapshot = captureTabUi(tab.session.ui);
    tab.session.ui.previewParams.slug = "changed";
    tab.session.ui.featureToggles.motion = false;
    expect(snapshot.previewParams.slug).toBe("hello");
    expect(snapshot.featureToggles.motion).toBe(true);
    disposeTab(tab);
  });

  test("a null previewProps stays null", () => {
    const tab = createTab({ document: {}, id: "t" });
    expect(captureTabUi(tab.session.ui).previewProps).toBeNull();
    disposeTab(tab);
  });
});

describe("restoreTabUi", () => {
  test("writes into the existing reactive object rather than replacing it", () => {
    const tab = createTab({ document: {}, id: "t" });
    const live = tab.session.ui;
    restoreTabUi(tab, { ...captureTabUi(tab.session.ui), zoom: 3 });
    expect(tab.session.ui).toBe(live);
    expect(tab.session.ui.zoom).toBe(3);
    disposeTab(tab);
  });
});

describe("pushSubDocument", () => {
  test("snapshots the parent and loads the sub-document", () => {
    const tab = parentTab();
    const frame = pushSubDocument(tab, {
      document: { children: [], tagName: "li" },
      documentPath: null,
      mode: "component",
      sourceFormat: null,
    });

    expect(frame.documentPath).toBe("pages/index.json");
    expect(frame.dirty).toBe(true);
    expect(frame.selection).toEqual(["children", 0]);
    expect(frame.ui.activeMedia).toBe("@md");
    expect(frame.ui.rightTab).toBe("style");

    expect(tab.session.documentStack).toHaveLength(1);
    expect(tab.doc.document.tagName).toBe("li");
    expect(tab.documentPath).toBeNull();
    expect(tab.doc.dirty).toBe(false);
    expect(tab.doc.mode).toBe("component");
    expect(tab.session.selection).toBeNull();
    disposeTab(tab);
  });

  test("an unspecified mode and sourceFormat clear the tab's", () => {
    const tab = parentTab();
    pushSubDocument(tab, { document: { tagName: "li" }, documentPath: null });
    expect(tab.doc.mode).toBeNull();
    expect(tab.doc.sourceFormat).toBeNull();
    disposeTab(tab);
  });

  test("editing the sub-document's UI does not corrupt the frame", () => {
    const tab = parentTab();
    pushSubDocument(tab, { document: { tagName: "li" }, documentPath: null });
    tab.session.ui.previewParams.slug = "child";
    tab.session.ui.activeMedia = "@sm";
    popSubDocument(tab);
    expect(tab.session.ui.previewParams.slug).toBe("hello");
    expect(tab.session.ui.activeMedia).toBe("@md");
    disposeTab(tab);
  });
});

describe("popSubDocument", () => {
  test("restores the document coordinates AND the UI context", () => {
    const tab = parentTab();
    pushSubDocument(tab, { document: { tagName: "li" }, documentPath: null });
    tab.session.ui.rightTab = "content";
    tab.session.ui.zoom = 2;
    tab.session.ui.activeSelector = "::marker";
    tab.doc.dirty = true;

    const frame = popSubDocument(tab);
    expect(frame?.documentPath).toBe("pages/index.json");
    expect(tab.documentPath).toBe("pages/index.json");
    expect(tab.doc.document.tagName).toBe("main");
    expect(tab.doc.dirty).toBe(true);
    expect(tab.session.selection).toEqual(["children", 0]);
    expect(tab.session.ui.rightTab).toBe("style");
    expect(tab.session.ui.zoom).toBe(0.75);
    expect(tab.session.ui.activeSelector).toBe(":hover");
    expect(tab.session.documentStack).toHaveLength(0);
    disposeTab(tab);
  });

  test("an empty stack pops nothing and leaves the tab alone", () => {
    const tab = parentTab();
    const before = tab.doc.document;
    expect(popSubDocument(tab)).toBeUndefined();
    expect(tab.doc.document).toBe(before);
    disposeTab(tab);
  });
});

describe("popToSubDocument", () => {
  test("jumps to a level and discards every frame above it", () => {
    const tab = parentTab();
    pushSubDocument(tab, { document: { tagName: "li" }, documentPath: null });
    tab.session.ui.zoom = 1.5;
    pushSubDocument(tab, { document: { tagName: "span" }, documentPath: null });

    expect(tab.session.documentStack).toHaveLength(2);
    const frame = popToSubDocument(tab, 0);
    expect(frame?.documentPath).toBe("pages/index.json");
    expect(tab.doc.document.tagName).toBe("main");
    expect(tab.session.ui.zoom).toBe(0.75);
    expect(tab.session.documentStack).toHaveLength(0);
    disposeTab(tab);
  });

  test("popping to the innermost frame restores it and keeps the ones below", () => {
    const tab = parentTab();
    pushSubDocument(tab, { document: { tagName: "li" }, documentPath: null });
    pushSubDocument(tab, { document: { tagName: "span" }, documentPath: null });
    popToSubDocument(tab, 1);
    expect(tab.doc.document.tagName).toBe("li");
    expect(tab.session.documentStack).toHaveLength(1);
    disposeTab(tab);
  });

  test("an out-of-range index changes nothing", () => {
    const tab = parentTab();
    pushSubDocument(tab, { document: { tagName: "li" }, documentPath: null });
    expect(popToSubDocument(tab, -1)).toBeUndefined();
    expect(popToSubDocument(tab, 5)).toBeUndefined();
    expect(tab.session.documentStack).toHaveLength(1);
    expect(tab.doc.document.tagName).toBe("li");
    disposeTab(tab);
  });
});
