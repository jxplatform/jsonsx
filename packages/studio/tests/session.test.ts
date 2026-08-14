/**
 * The session a project is left in, and the one it comes back as (plan §4.4).
 *
 * Every case here is about a claim the app made and did not keep: the per-project record's own
 * interface said "session state grows into this shape" while holding two layout fields, so
 * reopening a project landed on the home page with an empty strip — and P3's "Newly possible" says
 * "the session survives a relaunch".
 *
 * The validation cases matter as much as the round trip. `localStorage` is hand-editable and
 * outlives the version that wrote it, so every field read back is input.
 */
import { resetWorkspaceWithTab } from "./harness";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  PRIMARY_PANE,
  SECONDARY_PANE,
  closeAllTabs,
  closePane,
  focusPane,
  openTab,
  paneById,
  receivingPane,
  splitRight,
  workspace,
} from "../src/workspace/workspace";
import { captureSession, readSession, restoreSession } from "../src/workspace/session";
import type { PersistedSession } from "../src/workspace/session";
import type { JxMutableNode } from "@jxsuite/schema/types";

const DOC = { children: [], tagName: "div" } as unknown as JxMutableNode;

/** Open `path` into `paneId`, the way `studio.ts` hands `restoreSession` its opener. */
function opener(missing: string[] = []) {
  return async (path: string, paneId: string) => {
    if (missing.includes(path)) {
      throw new Error(`no such file: ${path}`);
    }
    const tab = openTab({ document: structuredClone(DOC), documentPath: path, id: `t:${path}` });
    const pane = paneById(paneId);
    const home = workspace.panes.find((p) => p.tabOrder.includes(tab.id));
    if (pane && home && home.id !== paneId) {
      home.tabOrder = home.tabOrder.filter((id) => id !== tab.id);
      home.activeTabId = home.tabOrder.at(-1) ?? null;
      pane.tabOrder = [...pane.tabOrder, tab.id];
      pane.activeTabId = tab.id;
    }
    await Promise.resolve();
  };
}

beforeEach(() => {
  closeAllTabs();
  closePane(SECONDARY_PANE);
  focusPane(PRIMARY_PANE);
});

describe("captureSession", () => {
  test("records each pane's documents in strip order, and the active one", () => {
    openTab({ document: structuredClone(DOC), documentPath: "pages/a.md", id: "a" });
    const b = openTab({ document: structuredClone(DOC), documentPath: "pages/b.md", id: "b" });
    const captured = captureSession();
    expect(captured.panes).toEqual([
      { activeFile: b.documentPath, files: ["pages/a.md", "pages/b.md"], id: PRIMARY_PANE },
    ]);
    expect(captured.focusedPane).toBe(PRIMARY_PANE);
  });

  test("records the view settings a person chose, per document", () => {
    const tab = resetWorkspaceWithTab(structuredClone(DOC), { documentPath: "pages/a.md" });
    tab.session.ui.canvasMode = "source";
    tab.session.ui.zoom = 1.5;
    tab.session.ui.activeMedia = "md";
    tab.session.ui.previewColorScheme = "dark";
    expect(captureSession().ui["pages/a.md"]).toMatchObject({
      activeMedia: "md",
      canvasMode: "source",
      previewColorScheme: "dark",
      zoom: 1.5,
    });
  });

  test("an untitled tab is not in it — there is no path to reopen from", () => {
    openTab({ document: structuredClone(DOC), documentPath: null, id: "untitled" });
    expect(captureSession().panes).toEqual([]);
  });

  test("a pane with nothing restorable is dropped rather than stored empty", () => {
    // A split MOVES the active tab, so this leaves the primary with nothing. Restoring an empty
    // Pane would reopen one the author would immediately close.
    openTab({ document: structuredClone(DOC), documentPath: "pages/a.md", id: "a" });
    expect(splitRight()?.id).toBe(SECONDARY_PANE);
    expect(captureSession().panes.map((p) => p.id)).toEqual([SECONDARY_PANE]);
  });

  test("both panes are recorded when both hold something", () => {
    openTab({ document: structuredClone(DOC), documentPath: "pages/a.md", id: "a" });
    openTab({ document: structuredClone(DOC), documentPath: "pages/b.md", id: "b" });
    splitRight();
    expect(captureSession().panes).toEqual([
      { activeFile: "pages/a.md", files: ["pages/a.md"], id: PRIMARY_PANE },
      { activeFile: "pages/b.md", files: ["pages/b.md"], id: SECONDARY_PANE },
    ]);
    expect(captureSession().focusedPane).toBe(SECONDARY_PANE);
  });
});

describe("readSession — every field is untrusted input", () => {
  /* Through JSON, because that is the trip: the record is `localStorage`, not an object handed
     across a function call. `structuredClone` would preserve types JSON erases and prove less. */
  const round = (session: PersistedSession) => {
    /* Through a STRING, because that is the trip: the record lives in `localStorage`, not in an
       object handed across a call. A structured clone would preserve types JSON erases and prove
       less about the thing that actually happens. */
    const wire: string = JSON.stringify(session);
    return readSession(JSON.parse(wire) as unknown);
  };

  test("a captured session survives the round trip", () => {
    openTab({ document: structuredClone(DOC), documentPath: "pages/a.md", id: "a" });
    const captured = captureSession();
    expect(round(captured)).toEqual(captured);
  });

  test("null, a string, a number and an array are all not a session", () => {
    for (const value of [null, undefined, "", 3, [], { panes: "no" }]) {
      expect(readSession(value)).toBeNull();
    }
  });

  test("a pane id the grid does not have is dropped", () => {
    expect(readSession({ panes: [{ activeFile: null, files: ["a.md"], id: "ghost" }] })).toBeNull();
  });

  test("a session whose every pane is empty is not a session", () => {
    expect(readSession({ panes: [{ activeFile: null, files: [], id: PRIMARY_PANE }] })).toBeNull();
  });

  test("an activeFile the pane does not hold falls back to null", () => {
    const parsed = readSession({
      panes: [{ activeFile: "elsewhere.md", files: ["a.md"], id: PRIMARY_PANE }],
    });
    expect(parsed?.panes[0]?.activeFile).toBeNull();
  });

  test("a focusedPane the grid does not have falls back to the primary", () => {
    const parsed = readSession({
      focusedPane: "ghost",
      panes: [{ activeFile: null, files: ["a.md"], id: PRIMARY_PANE }],
    });
    expect(parsed?.focusedPane).toBe(PRIMARY_PANE);
  });

  test("view settings of the wrong type are dropped, one field at a time", () => {
    const parsed = readSession({
      panes: [{ activeFile: null, files: ["a.md"], id: PRIMARY_PANE }],
      ui: {
        "a.md": {
          activeMedia: 7,
          canvasMode: "source",
          previewColorScheme: "sepia",
          showLayout: "yes",
          zoom: Number.NaN,
        },
      },
    });
    // The one legible field survives; the illegal scheme, the NaN zoom, the numeric breakpoint and
    // The string boolean do not — a bad neighbour must not cost a good field.
    expect(parsed?.ui["a.md"]).toEqual({ canvasMode: "source" });
  });
});

describe("restoreSession", () => {
  const session = (over: Partial<PersistedSession> = {}): PersistedSession => ({
    focusedPane: PRIMARY_PANE,
    panes: [{ activeFile: "pages/b.md", files: ["pages/a.md", "pages/b.md"], id: PRIMARY_PANE }],
    ui: {},
    ...over,
  });

  test("reopens the documents, in order, and activates the one that was active", async () => {
    const opened = await restoreSession(session(), {
      openFile: opener(),
      ensureSecondPane: () => {},
    });
    expect(opened).toBe(2);
    const pane = paneById(PRIMARY_PANE)!;
    expect(pane.tabOrder.map((id) => workspace.tabs.get(id)?.documentPath)).toEqual([
      "pages/a.md",
      "pages/b.md",
    ]);
    expect(workspace.tabs.get(pane.activeTabId!)?.documentPath).toBe("pages/b.md");
  });

  test("applies each document's view settings after every tab exists", async () => {
    await restoreSession(session({ ui: { "pages/a.md": { canvasMode: "source", zoom: 2 } } }), {
      openFile: opener(),
      ensureSecondPane: () => {},
    });
    const tab = [...workspace.tabs.values()].find((t) => t.documentPath === "pages/a.md")!;
    expect(tab.session.ui.zoom).toBe(2);
    expect(tab.session.ui.canvasMode).toBe("source");
  });

  test("every stored view setting is restored, one field at a time", async () => {
    // Each field is its own `!== undefined` branch, because a stored `false` or `0` is a CHOICE and
    // A truthiness check would silently drop "preview off" and "no breakpoint".
    await restoreSession(
      session({
        ui: {
          "pages/a.md": {
            activeMedia: "md",
            editZoom: 1.25,
            preview: false,
            previewColorScheme: "dark",
            showLayout: false,
            zoom: 0.5,
          },
        },
      }),
      { ensureSecondPane: () => {}, openFile: opener() },
    );
    const { ui } = [...workspace.tabs.values()].find(
      (t) => t.documentPath === "pages/a.md",
    )!.session;
    expect({
      activeMedia: ui.activeMedia,
      editZoom: ui.editZoom,
      preview: ui.preview,
      previewColorScheme: ui.previewColorScheme,
      showLayout: ui.showLayout,
      zoom: ui.zoom,
    }).toEqual({
      activeMedia: "md",
      editZoom: 1.25,
      preview: false,
      previewColorScheme: "dark",
      showLayout: false,
      zoom: 0.5,
    });
  });

  test("a mode the document does not support is dropped, not forced", async () => {
    // `capabilities.modes` is the document's own answer. A stored mode the tab cannot draw would
    // Otherwise restore as a blank canvas — and the record is `localStorage`, so it may name a mode
    // From a version that had one this one does not.
    await restoreSession(session({ ui: { "pages/a.md": { canvasMode: "chart" } } }), {
      openFile: opener(),
      ensureSecondPane: () => {},
    });
    const tab = [...workspace.tabs.values()].find((t) => t.documentPath === "pages/a.md")!;
    expect(tab.session.ui.canvasMode).not.toBe("chart");
  });

  test("a file that has moved since is skipped, and the rest still open", async () => {
    const opened = await restoreSession(session(), {
      openFile: opener(["pages/a.md"]),
      ensureSecondPane: () => {},
    });
    expect(opened).toBe(1);
    expect(
      paneById(PRIMARY_PANE)!.tabOrder.map((id) => workspace.tabs.get(id)?.documentPath),
    ).toEqual(["pages/b.md"]);
  });

  test("nothing restorable returns 0 — the caller's signal to open the home page", async () => {
    const opened = await restoreSession(session(), {
      openFile: opener(["pages/a.md", "pages/b.md"]),
      ensureSecondPane: () => {},
    });
    expect(opened).toBe(0);
  });

  test("an opener that swallows its own failure still counts 0", async () => {
    /*
     * The real opener does exactly this. `openFileInTab` reports a missing file by raising a
     * Problem and returning normally, because it is a user action rather than an exception — so
     * counting CALLS made every restore look like a success, the caller skipped its home-page
     * fallback, and a session of three deleted files opened an empty window. Found in a browser.
     * The workspace is the only honest answer to "is it open?".
     */
    const opened = await restoreSession(session(), {
      ensureSecondPane: () => {},
      openFile: async () => {
        await Promise.resolve();
      },
    });
    expect(opened).toBe(0);
    expect(workspace.tabs.size).toBe(0);
  });

  test("a two-pane session splits first, and each pane gets its own documents", async () => {
    let splits = 0;
    const opened = await restoreSession(
      session({
        focusedPane: SECONDARY_PANE,
        panes: [
          { activeFile: "pages/a.md", files: ["pages/a.md"], id: PRIMARY_PANE },
          { activeFile: "pages/b.md", files: ["pages/b.md"], id: SECONDARY_PANE },
        ],
      }),
      {
        // `receivingPane`, the way the bootstrap wires it. NOT `splitRight`: a split MOVES the
        // Focused pane's active tab, and nothing is open at this point — so it returns null, the
        // Pane is never created, and the second pane's documents all land in the first.
        ensureSecondPane: () => {
          splits += 1;
          receivingPane();
        },
        openFile: opener(),
      },
    );
    expect([splits, opened]).toEqual([1, 2]);
    expect(
      paneById(SECONDARY_PANE)!.tabOrder.map((id) => workspace.tabs.get(id)?.documentPath),
    ).toEqual(["pages/b.md"]);
    expect(workspace.activePaneId).toBe(SECONDARY_PANE);
  });
});
