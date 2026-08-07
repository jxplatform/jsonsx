import { installMockPlatform } from "./harness";
import { createMockCollabHub, settleCollab } from "./collab-mock";
import { toRaw } from "../src/reactivity";
import { jsonClone } from "../src/utils/studio-utils";
import { activateTab, closeAllTabs, closeTab, openTab } from "../src/workspace/workspace";
import {
  collabSave,
  configureCollabSerializer,
  resetCollabForTests,
  setCollabEnabled,
} from "../src/collab/collab-session";
import { collabState, isCollabActive, isCollabPath } from "../src/collab/collab-state";
import { createGridController } from "../src/grid/grid-controller";
import type { GridEditBatch, GridSource } from "../src/grid/grid-source";
import { reloadCleanTab } from "../src/files/files";
import { saveFile } from "../src/files/file-ops";
import { getHistoryDelegate, mutateUpdateProperty, transactDoc } from "../src/tabs/transact";
import { seedStructure, yDocToJson } from "@jxsuite/collab";
import type { JxMutableNode } from "@jxsuite/schema/types";
import { afterEach, describe, expect, test } from "bun:test";

const DOC: JxMutableNode = {
  children: [{ tagName: "p", textContent: "Hello" }],
  tagName: "div",
};

const PATH = "pages/index.json";

/** The smallest grid source that can record a commit — a `.csv` tab's controller needs one. */
function stubGridSource(): GridSource & { commits: GridEditBatch[] } {
  const commits: GridEditBatch[] = [];
  return {
    capabilities: { delete: true, insert: true, remotePaging: false, remoteSort: false },
    columns: async () => [{ editable: true, field: "name", kind: "string", title: "Name" }],
    async commit(batch) {
      commits.push(batch);
      return {
        cells: [],
        deletes: [],
        inserts: batch.inserts.map((i) => ({
          newKey: `real-${i.tempKey}`,
          ok: true,
          tempKey: i.tempKey,
        })),
      };
    },
    commits,
    id: "grid://file/data/people.csv",
    label: "people.csv",
    rows: async () => ({ rows: [{ cells: { name: "Grace" } as never, key: "r1" }], total: 1 }),
  };
}

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
    expect(isCollabActive(tab)).toBe(false);
    await settleCollab();

    const state = collabState(tab);
    expect(state.active).toBe(true);
    expect(isCollabActive(tab)).toBe(true);
    expect(state.status).toBe("synced");
    expect(isCollabPath(PATH)).toBe(true);
    expect(yDocToJson(hub.serverDoc(PATH))).toEqual(DOC);
    expect(tab.doc.dirty).toBe(false);
  });

  test("the server's room-level dirty broadcast drives tab.doc.dirty", async () => {
    const hub = createMockCollabHub();
    const tab = openCollabTab(hub);
    await settleCollab();
    // A fresh clean room leaves the tab clean (onDirty fired false on attach).
    expect(tab.doc.dirty).toBe(false);
    // The server reports the room dirty (any peer edited): the Save affordance lights up.
    hub.setDirty(PATH, true);
    expect(tab.doc.dirty).toBe(true);
    // A save by any collaborator clears the room for everyone.
    hub.setDirty(PATH, false);
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

  /*
   * `project.json` is declared out of replication (specs/collab.md). It is the one document whose
   * edits arrive from surfaces that are not the canvas and whose value the studio itself reads to
   * configure formats, extensions and the style cascade, so a shared Y.Doc over it would let a
   * peer's extension list reconfigure your editor mid-keystroke. Returning early in `ensureCollab`
   * is the whole gate: no session, and therefore no Yjs history delegate over the tab
   * `tabs/project-config.ts` transacts configuration onto.
   */
  test("project.json is out of replication — no session, no history delegate", async () => {
    const hub = createMockCollabHub();
    installMockPlatform({ collab: hub.capability });
    const tab = openTab({
      document: { name: "Site" } as unknown as JxMutableNode,
      documentPath: "project.json",
      id: "project.json",
    });
    await settleCollab();

    expect(collabState(tab).active).toBe(false);
    expect(isCollabPath("project.json")).toBe(false);
    expect(hub.connectionCount("project.json")).toBe(0);
    expect(getHistoryDelegate(tab)).toBeNull();
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

  // The watcher's one condition. It used to have a second — detach while the tab is drilled into a
  // Sub-document — over a `documentStack` nothing in `src/` could push to, so it never fired; a
  // Drill-in opens its own tab, which attaches its own session for its own file.
  test("opting out detaches; rejoining re-attaches", async () => {
    const hub = createMockCollabHub();
    const tab = openCollabTab(hub);
    await settleCollab();
    expect(collabState(tab).active).toBe(true);

    setCollabEnabled(tab, false);
    await settleCollab();
    expect(collabState(tab).active).toBe(false);
    expect(hub.connectionCount(PATH)).toBe(0);

    setCollabEnabled(tab, true);
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
    activateTab(tab.id);
    await settleCollab();

    state.calls.length = 0;
    await saveFile();
    expect(hub.flushes).toEqual([PATH]);
    expect(state.calls.filter((call) => call[0] === "writeFile")).toHaveLength(0);
  });

  /**
   * A read-only client publishes nothing (`onTransact` gates the publish AND the mirror behind
   * `canWrite`), so there is no version of "save" that reaches anywhere. This used to skip the
   * mirror, flush an untouched Y-doc and return `true` — which `saveFile` stamped "Saved just now"
   * on, and the tab strip's Save button closed the tab on top of.
   */
  test("a read-only client's save writes nothing and reports failure, not success", async () => {
    const hub = createMockCollabHub({ identity: { permission: "read" } });
    // A read-only client never seeds — the room has to exist before it can observe.
    seedStructure(hub.serverDoc(PATH), structuredClone(DOC));
    const { state } = installMockPlatform({ collab: hub.capability });
    const tab = openTab({ document: structuredClone(DOC), documentPath: PATH, id: PATH });
    activateTab(tab.id);
    configureCollabSerializer((t) => Promise.resolve(JSON.stringify(t.doc.document)));
    await settleCollab();
    expect(collabState(tab).readOnly).toBe(true);

    transactDoc(tab, (t) => mutateUpdateProperty(t, ["children", 0], "textContent", "Local only"));
    expect(tab.doc.dirty).toBe(true);
    // The edit is in this browser and nowhere else — nothing gated behind `canWrite` ran.
    expect(yDocToJson(hub.serverDoc(PATH))).toEqual(DOC);

    state.calls.length = 0;
    expect(await collabSave(tab)).toBe(false);
    expect(await saveFile(tab)).toBe(false);

    expect(hub.flushes).toEqual([]);
    // And it must not fall through to a plain file write either: the local file is the ROOM's
    // File, so writing it here forks the shared document behind its owner's back.
    expect(state.calls.filter((call) => call[0] === "writeFile")).toHaveLength(0);
    expect(tab.doc.dirty).toBe(true);
  });

  /**
   * The refusal is only a refusal if nothing can step in front of it.
   *
   * `ensureCollab` attaches a session to every tab with a `documentPath` except `project.json` —
   * `.csv` included, and a `.csv` tab is exactly the kind `grid-panel.ts` provisions a controller
   * for. The grid branch used to sit ABOVE the read-only check, so a read-only collaborator on a
   * co-edited sheet ran `grid.save()`, which commits through the source and writes the ROOM's file
   * behind its owner's back — and then `return !tab.doc.dirty` reported it as a save, which is the
   * precise pair of outcomes the paragraph on `saveFile` says it prevents.
   */
  test("a read-only collaborator's GRID save is refused before it can commit", async () => {
    const CSV = "data/people.csv";
    const hub = createMockCollabHub({ identity: { permission: "read" } });
    seedStructure(hub.serverDoc(CSV), structuredClone(DOC));
    installMockPlatform({ collab: hub.capability });
    const tab = openTab({ document: structuredClone(DOC), documentPath: CSV, id: CSV });
    activateTab(tab.id);
    await settleCollab();
    expect(collabState(tab).readOnly).toBe(true);

    const source = stubGridSource();
    const controller = createGridController(tab, source);
    await controller.load();
    controller.addRow({ name: "Ada" });

    expect(await saveFile(tab)).toBe(false);
    // Nothing reached the source, so nothing reached the file the room is serving.
    expect(source.commits).toHaveLength(0);
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
