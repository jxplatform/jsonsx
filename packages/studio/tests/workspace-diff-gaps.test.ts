/**
 * The guards and the ordering rules of the pane model that nothing else reaches (B3): `addPane`'s
 * "the id is already in the grid" answer, `closePane`'s "that pane is not here", `insertIntoPane`'s
 * idempotence and the pinned prefix it inserts against, `document.setPinned`'s idempotent write,
 * `pane.pin` run past its own gate, and a stored view-settings entry that is not an object.
 *
 * Every one of them is a refusal rather than an action, so each test asserts the state that did NOT
 * change beside the one that did — a refusal nothing can distinguish from the act it refuses is not
 * a refusal.
 */
import "./harness";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  PRIMARY_PANE,
  SECONDARY_PANE,
  closeAllTabs,
  closePane,
  detachTab,
  focusPane,
  insertIntoPane,
  openTab,
  paneById,
  setTabPinned,
  sidePane,
  splitRight,
  tabCommands,
  workspace,
} from "../src/workspace/workspace";
import {
  derivationCommands,
  derivationOfPane,
  noopDerivationDeps,
  setPaneDerivation,
} from "../src/workspace/pane-derive";
import { readSession } from "../src/workspace/session";
import { createCommandRegistry } from "../src/commands/registry";
import { emptyContext, makeContext } from "../src/commands/context";
import type { PaneDerivation } from "../src/workspace/workspace";

const deps = { openFile: () => {}, openFileInPane: () => {} };

function open(id: string, opts: Record<string, unknown> = {}) {
  return openTab({ document: { tagName: "div" }, documentPath: `${id}.json`, id, ...opts });
}

function tabRegistry() {
  const registry = createCommandRegistry({
    getContext: () => makeContext({ document: { open: workspace.tabs.size > 0 } }),
  });
  registry.registerAll(tabCommands(deps));
  return registry;
}

/** The `pane.pin` command record, so it can be run PAST its own enablement gate. */
function pinCommand() {
  return derivationCommands(noopDerivationDeps()).find((command) => command.id === "pane.pin")!;
}

beforeEach(() => {
  closeAllTabs();
});

afterEach(() => {
  closeAllTabs();
});

describe("a pane id already in the grid is answered, never minted twice", () => {
  test("`sidePane` hands back the record that is there rather than a second one under its id", () => {
    /* The grid `addPane`'s guard exists for. Two records under one id is undefined behaviour in
       lit's keyed `repeat` — the grid draws two cells for one pane, each `ref` overwriting the
       other's surface record — so the answer has to be the pane that is already published. */
    workspace.panes = [{ activeTabId: null, derived: null, id: SECONDARY_PANE, tabOrder: [] }];
    workspace.activePaneId = SECONDARY_PANE;

    const pane = sidePane();

    expect(pane.id).toBe(SECONDARY_PANE);
    expect(workspace.panes.map((candidate) => candidate.id)).toEqual([SECONDARY_PANE]);
  });
});

describe("closePane refuses an id the grid does not carry", () => {
  test("a ghost id changes no pane, no strip and no focus — and a real id still collapses", () => {
    open("a");
    open("b");
    splitRight();
    focusPane(PRIMARY_PANE);

    closePane("no-such-pane");

    expect(workspace.panes.map((pane) => pane.id)).toEqual([PRIMARY_PANE, SECONDARY_PANE]);
    expect(paneById(PRIMARY_PANE)!.tabOrder).toEqual(["a"]);
    expect(paneById(SECONDARY_PANE)!.tabOrder).toEqual(["b"]);
    expect(workspace.activePaneId).toBe(PRIMARY_PANE);

    // The control: the same call with an id the grid DOES carry moves the tabs and drops the pane.
    closePane(SECONDARY_PANE);
    expect(workspace.panes.map((pane) => pane.id)).toEqual([PRIMARY_PANE]);
    expect(paneById(PRIMARY_PANE)!.tabOrder).toEqual(["a", "b"]);
  });
});

describe("insertIntoPane", () => {
  test("a tab the pane already holds is not inserted a second time", () => {
    open("a");
    open("b");
    const pane = paneById(PRIMARY_PANE)!;

    insertIntoPane(pane, "a");

    expect(pane.tabOrder).toEqual(["a", "b"]);
  });

  test("a pinned arrival lands at the END of the pinned prefix, not in front of it", () => {
    open("p1");
    open("u1");
    open("p2");
    setTabPinned("p1", true);
    setTabPinned("p2", true);
    const pane = paneById(PRIMARY_PANE)!;
    detachTab("p2");
    expect(pane.tabOrder).toEqual(["p1", "u1"]);

    insertIntoPane(pane, "p2");

    expect(pane.tabOrder).toEqual(["p1", "p2", "u1"]);
  });

  test("an unpinned arrival lands at the end of the strip, behind everything", () => {
    open("p1");
    open("u1");
    setTabPinned("p1", true);
    const pane = paneById(PRIMARY_PANE)!;
    detachTab("u1");

    insertIntoPane(pane, "u1");

    expect(pane.tabOrder).toEqual(["p1", "u1"]);
  });

  test("the prefix is counted at the HEAD — a pinned tab behind an unpinned one is not in it", () => {
    /* `pinnedCount` stops at the first tab that is not pinned rather than counting the pinned ones
       wherever they sit. The two answers only differ on an interleaved order, so that is the order
       stated here: counting instead of stopping would put the arrival behind `u1`, on the far side
       of the boundary the pinned region is supposed to be. */
    open("p1");
    open("u1");
    open("p2");
    open("p3");
    setTabPinned("p1", true);
    setTabPinned("p2", true);
    setTabPinned("p3", true);
    const pane = paneById(PRIMARY_PANE)!;
    detachTab("p3");
    pane.tabOrder = ["p1", "u1", "p2"];

    insertIntoPane(pane, "p3");

    expect(pane.tabOrder).toEqual(["p1", "p3", "u1", "p2"]);
  });
});

describe("document.setPinned states the pinned state rather than flipping it", () => {
  test("it is idempotent where `document.togglePinned` is not", async () => {
    const registry = tabRegistry();
    open("a");

    await registry.run("document.setPinned", { pinned: true });
    expect(workspace.tabs.get("a")!.pinned).toBe(true);
    // Twice, because the whole reason this command exists beside the toggle is that a second
    // Delivery of the same instruction must not undo the first.
    await registry.run("document.setPinned", { pinned: true });
    expect(workspace.tabs.get("a")!.pinned).toBe(true);

    await registry.run("document.setPinned", { pinned: false });
    expect(workspace.tabs.get("a")!.pinned).toBe(false);
  });

  test("pinning also commits a preview tab, the way `setTabPinned` does", async () => {
    const registry = tabRegistry();
    open("p", { preview: true });

    await registry.run("document.setPinned", { pinned: true });

    expect(workspace.tabs.get("p")!.preview).toBe(false);
  });

  test("an active id no tab answers to is refused BEFORE the arguments are read", async () => {
    /* `workspace.activeTabId` reports what the pane says, and a pane can name a document the
       workspace no longer carries — a layout restored from a stale session, a tab closed out from
       under a context that was already captured. Both halves of the guard are load-bearing, and
       only the membership half can be seen from here: `setTabPinned` re-checks the id, so a call
       that got through would write nothing either way. What tells them apart is WHEN the command
       gives up. `booleanArg` rejects loudly by design (`commands/command-args.ts` rule 1), so a
       command that reached it with no tab under the id would report a bad argument for an action
       it was never going to take — the caller would be told to fix `pinned` when the real answer
       is that there is nothing here to pin. */
    const registry = tabRegistry();
    open("a");
    paneById(PRIMARY_PANE)!.activeTabId = "ghost";
    expect(workspace.activeTabId).toBe("ghost");

    await registry.run("document.setPinned", { pinned: true });

    // Nothing was pinned — not the ghost, and not the tab that IS open beside it.
    expect(workspace.tabs.get("a")!.pinned).toBe(false);
    expect(paneById(PRIMARY_PANE)!.tabOrder).toEqual(["a"]);

    // And a call with no `pinned` at all is still just a no-op: the arguments are never read.
    expect(() => registry.run("document.setPinned", {})).not.toThrow();
    expect(workspace.tabs.get("a")!.pinned).toBe(false);

    // The control: put a real tab back under the id and the SAME call refuses by name.
    paneById(PRIMARY_PANE)!.activeTabId = "a";
    expect(() => registry.run("document.setPinned", {})).toThrow(
      'command "document.setPinned" argument "pinned": expected a boolean, got missing',
    );
  });
});

describe("pane.pin run past its own gate", () => {
  /** A companion on the secondary pane holding `path` as a preview tab. */
  function companionHolding(path: string) {
    open("page");
    open("scratch");
    splitRight();
    focusPane(PRIMARY_PANE);
    const tab = openTab({
      document: { tagName: "div" },
      documentPath: path,
      focus: false,
      id: path,
      paneId: SECONDARY_PANE,
      preview: true,
    });
    const companion: PaneDerivation = {
      kind: "companion",
      preset: "layout",
      reason: "",
      resolved: path,
      sourcePaneId: PRIMARY_PANE,
      status: "loading",
    };
    setPaneDerivation(SECONDARY_PANE, companion);
    return tab;
  }

  test("with no pinnable pane it promotes nothing and clears nothing", () => {
    const tab = open("p", { preview: true });

    expect(() => pinCommand().run(emptyContext(), undefined as never)).not.toThrow();

    // Nothing was kept: the preview tab is still replaceable and the grid still has one pane.
    expect(workspace.tabs.get(tab.id)!.preview).toBe(true);
    expect(workspace.panes.map((pane) => pane.id)).toEqual([PRIMARY_PANE]);
  });

  test("with a companion holding a tab it promotes that tab and drops the derivation", () => {
    const tab = companionHolding("layouts/base.json");

    void pinCommand().run(emptyContext(), undefined as never);

    expect(workspace.tabs.get(tab.id)!.preview).toBe(false);
    expect(derivationOfPane(SECONDARY_PANE)).toBeNull();
  });
});

describe("readSession — a stored view-settings entry is untrusted input", () => {
  test("an entry that is not an object reads as no settings at all", () => {
    const parsed = readSession({
      panes: [{ activeFile: null, files: ["a.md", "b.md", "c.md"], id: PRIMARY_PANE }],
      ui: {
        "a.md": null,
        "b.md": "source",
        "c.md": { canvasMode: "source", zoom: 2 },
      },
    });

    // `null` is the case that matters: `typeof null === "object"`, so a guard that only asked the
    // Typeof would read fields off it and throw on the way out of `localStorage`.
    expect(parsed?.ui).toEqual({
      "a.md": {},
      "b.md": {},
      "c.md": { canvasMode: "source", zoom: 2 },
    });
  });
});
