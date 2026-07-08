import { installMockPlatform } from "./harness";
import { createMockCollabHub, settleCollab } from "./collab-mock";
import { toRaw } from "../src/reactivity";
import { jsonClone } from "../src/utils/studio-utils";
import { closeAllTabs, closeTab, openTab, workspace } from "../src/workspace/workspace";
import {
  collabSave,
  configureCollabSerializer,
  resetCollabForTests,
} from "../src/collab/collab-session";
import { collabState, isCollabPath } from "../src/collab/collab-state";
import { reloadCleanTab } from "../src/files/files";
import { saveFile } from "../src/files/file-ops";
import { mutateUpdateProperty, transactDoc } from "../src/tabs/transact";
import { seedStructure, yDocToJson } from "@jxsuite/collab";
import type { JxMutableNode } from "@jxsuite/schema/types";
import { afterEach, describe, expect, test } from "bun:test";

const DOC: JxMutableNode = {
  children: [{ tagName: "p", textContent: "Hello" }],
  tagName: "div",
};

const PATH = "pages/index.json";

function openCollabTab(hub: ReturnType<typeof createMockCollabHub>, doc?: JxMutableNode) {
  installMockPlatform({ collab: hub.capability });
  return openTab({
    document: structuredClone(doc ?? DOC),
    documentPath: PATH,
    id: PATH,
  });
}

afterEach(() => {
  closeAllTabs();
  resetCollabForTests();
});

describe("session attach", () => {
  test("openTab attaches, seeds the shared structure, and clears dirty", async () => {
    const hub = createMockCollabHub();
    const tab = openCollabTab(hub);
    await settleCollab();

    const state = collabState(tab);
    expect(state.active).toBe(true);
    expect(state.status).toBe("synced");
    expect(isCollabPath(PATH)).toBe(true);
    expect(yDocToJson(hub.serverDoc(PATH))).toEqual(DOC);
    expect(tab.doc.dirty).toBe(false);
  });

  test("a second client adopts the already-seeded shared tree", async () => {
    const hub = createMockCollabHub();
    const shared: JxMutableNode = {
      children: [{ tagName: "h1", textContent: "Shared truth" }],
      tagName: "main",
    };
    seedStructure(hub.serverDoc(PATH), shared);

    const tab = openCollabTab(hub, {
      children: [{ tagName: "p", textContent: "stale local parse" }],
      tagName: "div",
    });
    await settleCollab();

    expect(collabState(tab).active).toBe(true);
    expect(jsonClone(toRaw(tab.doc.document))).toEqual(shared);
  });

  test("a refused path falls back to solo editing", async () => {
    const hub = createMockCollabHub({ refuse: [PATH] });
    const tab = openCollabTab(hub);
    await settleCollab();

    expect(collabState(tab).active).toBe(false);
    expect(isCollabPath(PATH)).toBe(false);
    transactDoc(tab, (t) => mutateUpdateProperty(t, ["children", 0], "textContent", "solo"));
    expect(tab.doc.dirty).toBe(true);
  });

  test("a platform without the capability is a no-op", async () => {
    installMockPlatform();
    const tab = openTab({ document: structuredClone(DOC), documentPath: PATH, id: PATH });
    await settleCollab();
    expect(collabState(tab).active).toBe(false);
  });

  test("read-only identity mounts as an observer", async () => {
    const hub = createMockCollabHub({ identity: { permission: "read" } });
    const tab = openCollabTab(hub);
    await settleCollab();

    expect(collabState(tab).readOnly).toBe(true);
    // Local edits are not published.
    transactDoc(tab, (t) => mutateUpdateProperty(t, ["children", 0], "textContent", "nope"));
    await settleCollab();
    expect(yDocToJson(hub.serverDoc(PATH))).toEqual({});
  });
});

describe("session lifecycle", () => {
  test("closing the tab detaches and destroys the handle", async () => {
    const hub = createMockCollabHub();
    const tab = openCollabTab(hub);
    await settleCollab();
    expect(hub.connectionCount(PATH)).toBe(1);

    closeTab(tab.id);
    await settleCollab();
    expect(hub.connectionCount(PATH)).toBe(0);
    expect(isCollabPath(PATH)).toBe(false);
  });

  test("drilling into a component detaches; returning re-attaches", async () => {
    const hub = createMockCollabHub();
    const tab = openCollabTab(hub);
    await settleCollab();
    expect(collabState(tab).active).toBe(true);

    tab.session.documentStack.push({
      dirty: false,
      document: tab.doc.document,
      documentPath: tab.documentPath,
      mode: tab.doc.mode,
      selection: null,
      sourceFormat: null,
    } as never);
    await settleCollab();
    expect(collabState(tab).active).toBe(false);
    expect(hub.connectionCount(PATH)).toBe(0);

    tab.session.documentStack.pop();
    await settleCollab();
    expect(collabState(tab).active).toBe(true);
    expect(hub.connectionCount(PATH)).toBe(1);
  });

  test("a server doc-reset re-attaches against the fresh room", async () => {
    const hub = createMockCollabHub();
    const tab = openCollabTab(hub);
    await settleCollab();

    hub.reset(PATH);
    await settleCollab();
    expect(collabState(tab).active).toBe(true);
    expect(hub.connectionCount(PATH)).toBe(1);
    // The fresh room got re-seeded from the tab.
    expect(yDocToJson(hub.serverDoc(PATH))).toEqual(DOC);
  });

  test("offline status surfaces on the tab state", async () => {
    const hub = createMockCollabHub();
    const tab = openCollabTab(hub);
    await settleCollab();

    hub.setStatus(PATH, "offline");
    expect(collabState(tab).status).toBe("offline");
    hub.setStatus(PATH, "connected");
    expect(collabState(tab).status).toBe("synced");
  });
});

describe("file plumbing guards", () => {
  test("reloadCleanTab skips co-edited paths", async () => {
    const hub = createMockCollabHub();
    const { state } = installMockPlatform({ collab: hub.capability });
    openTab({ document: structuredClone(DOC), documentPath: PATH, id: PATH });
    await settleCollab();

    state.calls.length = 0;
    reloadCleanTab(PATH);
    await settleCollab();
    expect(state.calls.filter((call) => call[0] === "readFile")).toHaveLength(0);
  });

  test("saveFile persists through the provider, not the file API", async () => {
    const hub = createMockCollabHub();
    const { state } = installMockPlatform({ collab: hub.capability });
    const tab = openTab({ document: structuredClone(DOC), documentPath: PATH, id: PATH });
    workspace.activeTabId = tab.id;
    await settleCollab();

    state.calls.length = 0;
    await saveFile();
    expect(hub.flushes).toEqual([PATH]);
    expect(state.calls.filter((call) => call[0] === "writeFile")).toHaveLength(0);
  });

  test("collabSave refreshes the source mirror before flushing", async () => {
    const hub = createMockCollabHub();
    const tab = openCollabTab(hub);
    configureCollabSerializer((t) => Promise.resolve(JSON.stringify(t.doc.document)));
    await settleCollab();

    transactDoc(tab, (t) => mutateUpdateProperty(t, ["children", 0], "textContent", "Mirrored"));
    await collabSave(tab);
    const source = hub.serverDoc(PATH).getText("source").toString();
    expect(source).toContain("Mirrored");
    expect(hub.flushes).toEqual([PATH]);
  });
});
