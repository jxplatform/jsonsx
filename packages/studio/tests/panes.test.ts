/**
 * The minimal pane model (§4.1) — panes as the unit of split, focus and zoom; the workspace-level
 * `activeTabId` / `tabOrder` as DERIVED reads over the focused pane; pin, drag reorder and preview
 * tabs; and the five `pane.*` command records.
 */
import "./harness";
import { afterEach, describe, expect, test } from "bun:test";
import {
  MAX_PANES,
  PRIMARY_PANE,
  SECONDARY_PANE,
  activePane,
  activateTab,
  closeAllTabs,
  closePane,
  closeTab,
  focusOtherPane,
  focusPane,
  moveTab,
  openTab,
  activeTab,
  paneById,
  paneCommands,
  paneOfTab,
  promoteDirtyPreviewTabs,
  promoteTab,
  setTabPinned,
  splitRight,
  tabCommands,
  tabIsLive,
  workspace,
} from "../src/workspace/workspace";
import { BUFFER_COMMIT, bufferWrites } from "../src/services/monaco-buffer";
import { view } from "../src/view";
import { editorKindOf, editorKindsOf, modeForEditorKind } from "../src/tabs/tab";
import { effect, effectScope } from "../src/reactivity";
import { createCommandRegistry } from "../src/commands/registry";
import { emptyContext, makeContext } from "../src/commands/context";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

function open(id: string, opts: Record<string, unknown> = {}) {
  return openTab({ document: { tagName: "div" }, documentPath: `${id}.json`, id, ...opts });
}

/** A tab whose only modes are Canvas ones — the case the second pane used to refuse. */
function openCanvasOnly(id: string) {
  return openTab({
    capabilities: { modes: ["edit", "design", "preview"] },
    document: { tagName: "div" },
    documentPath: `${id}.md`,
    id,
  });
}

function registryWith(commands: ReturnType<typeof paneCommands>) {
  const registry = createCommandRegistry({
    getContext: () => makeContext({ document: { open: workspace.tabs.size > 0 } }),
  });
  registry.registerAll(commands);
  return registry;
}

afterEach(() => {
  closeAllTabs();
});

describe("the store boots with one pane", () => {
  test("primary always exists and answers `activePane`", () => {
    expect(workspace.panes.length).toBe(1);
    expect(activePane().id).toBe(PRIMARY_PANE);
    expect(workspace.activeTabId).toBeNull();
    expect(workspace.tabOrder).toEqual([]);
  });

  test("the workspace reads are DERIVED — the pane is where a tab actually lives", () => {
    open("a");
    open("b");
    expect(activePane().tabOrder).toEqual(["a", "b"]);
    expect(workspace.tabOrder).toEqual(["a", "b"]);
    expect(workspace.activeTabId).toBe("b");
    expect(paneOfTab("a")?.id).toBe(PRIMARY_PANE);
    expect(paneOfTab("nope")).toBeUndefined();
  });
});

describe("editor kinds", () => {
  test("the base mode names the editor; preview is a Canvas VIEW, not a kind", () => {
    const tab = open("a");
    expect(editorKindOf(tab)).toBe("canvas");
    tab.session.ui.canvasMode = "source";
    expect(editorKindOf(tab)).toBe("code");
    tab.session.ui.canvasMode = "stylebook";
    expect(editorKindOf(tab)).toBe("config");
    tab.session.ui.canvasMode = "something-new";
    expect(editorKindOf(tab)).toBe("canvas");
  });

  test("the kind list is deduplicated and never contains a dead entry", () => {
    const tab = open("a", { capabilities: { modes: ["edit", "design", "preview", "source"] } });
    expect(editorKindsOf(tab)).toEqual(["canvas", "code"]);
    expect(modeForEditorKind(tab, "code")).toBe("source");
    expect(modeForEditorKind(tab, "diff")).toBeUndefined();
  });
});

describe("splitting", () => {
  test(String.raw`⌘\ moves the focused tab into a second pane and focuses it`, () => {
    open("a");
    open("b");
    const target = splitRight();
    expect(target?.id).toBe(SECONDARY_PANE);
    expect(workspace.panes.length).toBe(MAX_PANES);
    expect(paneById(PRIMARY_PANE)!.tabOrder).toEqual(["a"]);
    expect(paneById(SECONDARY_PANE)!.tabOrder).toEqual(["b"]);
    expect(workspace.activePaneId).toBe(SECONDARY_PANE);
    expect(workspace.activeTabId).toBe("b");
  });

  test("the tab moves AS IT IS — the split no longer rewrites a Design page into Code", () => {
    /* `capToPaneKind` used to run here. The side pane hosted six cheap kinds and a Canvas was not
       one of them, so `⌘\` on a page you were designing flipped `session.ui.canvasMode` to
       `source` before focus moved — silently reopening your page as Code in the pane you had just
       asked for. Both panes draw a live Canvas now, so a split is a move and nothing else. */
    const tab = open("a", { capabilities: { modes: ["edit", "design", "source"] } });
    expect(editorKindOf(tab)).toBe("canvas");
    const mode = tab.session.ui.canvasMode;
    splitRight();
    expect(editorKindOf(workspace.tabs.get("a")!)).toBe("canvas");
    expect(workspace.tabs.get("a")!.session.ui.canvasMode).toBe(mode);
  });

  test("a Canvas-only document splits — that refusal was the cap, and the cap is lifted", () => {
    openCanvasOnly("only");
    expect(splitRight()?.id).toBe(SECONDARY_PANE);
    expect(workspace.panes.length).toBe(2);
    expect(editorKindOf(workspace.tabs.get("only")!)).toBe("canvas");
  });

  test("splitting with nothing open is a no-op", () => {
    expect(splitRight()).toBeNull();
    expect(workspace.panes.length).toBe(1);
  });

  /*
   * The pane published by a split has to be COMPLETE before it is focused, and it has to be the
   * reactive record — two halves of one rule, and the split broke both.
   *
   * `workspace.activePaneId = target.id` ran first, so every `activeTab` reader re-ran against a
   * pane that was showing nothing and cached null: the jump bar rendered empty, the Inspector and
   * the toolbar said "no document", over a stage that was drawing the document perfectly. The
   * correction on the next line notified nobody, because `target` was still the raw literal that
   * had been pushed into the reactive array — a write through it reaches the fields and skips every
   * effect, which is the pitfall this codebase has already been bitten by once with nested
   * reactive collections.
   */
  test("the pane is complete and reactive before the focus moves to it", () => {
    open("a");
    open("b");
    const seen: (string | null)[] = [];
    const scope = effectScope();
    scope.run(() => {
      effect(() => {
        seen.push(activeTab.value?.id ?? null);
      });
    });
    seen.length = 0;

    splitRight();

    // What every activeTab reader saw, at every step of the split — never "no document".
    expect(seen).not.toContain(null);
    expect(seen.at(-1)).toBe("b");
    // And the computed is not left holding a stale null that nothing will ever invalidate.
    expect(activeTab.value?.id).toBe("b");
    scope.stop();
  });

  test("the pane it hands back is the reactive record, never the literal it published", () => {
    open("a");
    open("b");
    const target = splitRight()!;
    let runs = 0;
    const scope = effectScope();
    scope.run(() => {
      effect(() => {
        void paneById(SECONDARY_PANE)?.activeTabId;
        runs += 1;
      });
    });
    const before = runs;

    // A write through the record the API returned. `reactive()` wraps on READ, so if a caller can
    // Hold the object that was pushed into the array, this reaches the field and notifies nobody.
    target.activeTabId = "a";

    expect(runs).toBeGreaterThan(before);
    expect(paneById(SECONDARY_PANE)!.activeTabId).toBe("a");
    scope.stop();
  });

  test("splitting back from the side pane returns the tab AND collapses the emptied pane", () => {
    open("a");
    open("b");
    splitRight();
    const back = splitRight();
    expect(back?.id).toBe(PRIMARY_PANE);
    expect(paneById(PRIMARY_PANE)!.tabOrder).toEqual(["a", "b"]);
    // This assertion used to read `?.tabOrder).toEqual([])` — it asserted that the emptied pane
    // STAYED in the grid, which is three keystrokes from a shell with no stage, no strip and no
    // Jump bar while two documents are open: `pane.focusSecondary` remains enabled on a pane whose
    // `tabOfPane` is null, and that null is the exact input `hardClearCanvasWrap` takes. `closeTab`
    // Had the rule already — a pane with nothing in it is a hole in the grid — and every path that
    // Empties a pane now applies it.
    expect(workspace.panes.map((p) => p.id)).toEqual([PRIMARY_PANE]);
  });
});

describe("the lifted cap", () => {
  /*
   * There is exactly ONE cap left, and it is {@link MAX_PANES}. `SECONDARY_PANE_KINDS` and its five
   * predicates — `paneCanHostKind`, `canOpenInSecondPane`, `hostableKindsOf`,
   * `paneOfTabCanHostMode`, `capToPaneKind` — are deleted, because they existed to keep a second
   * LIVE canvas host off the screen and workstream 1 made one affordable.
   *
   * This is the assertion that the deletion was complete rather than partial: a cap enforced at
   * some of its points and not others is how the two ends of a rule start disagreeing, and this one
   * had five ends.
   */
  test("what a pane may host does not depend on WHICH pane the tab is in", () => {
    open("a", { capabilities: { modes: ["edit", "design", "source"] } });
    const tab = workspace.tabs.get("a")!;
    expect(editorKindsOf(tab)).toEqual(["canvas", "code"]);

    open("b");
    activateTab("a");
    splitRight();
    expect(paneOfTab("a")!.id).toBe(SECONDARY_PANE);

    // Same answer in the side pane, and the tab can be switched back to a Canvas mode there.
    expect(editorKindsOf(tab)).toEqual(["canvas", "code"]);
    tab.session.ui.canvasMode = "design";
    expect(editorKindOf(tab)).toBe("canvas");
  });

  test("two Canvas documents can be open side by side — the point of the workstream", () => {
    openCanvasOnly("left");
    openCanvasOnly("right");
    splitRight();
    expect(workspace.panes).toHaveLength(2);
    expect(editorKindOf(workspace.tabs.get("left")!)).toBe("canvas");
    expect(editorKindOf(workspace.tabs.get("right")!)).toBe("canvas");
    expect(paneById(PRIMARY_PANE)!.activeTabId).toBe("left");
    expect(paneById(SECONDARY_PANE)!.activeTabId).toBe("right");
  });
});

describe("focus and zoom", () => {
  test("focusPane moves the keyboard and the MRU; an unknown id is ignored", () => {
    open("a");
    open("b");
    splitRight();
    focusPane(PRIMARY_PANE);
    expect(workspace.activePaneId).toBe(PRIMARY_PANE);
    expect(workspace.activeTabId).toBe("a");
    expect(workspace.mruOrder[0]).toBe("a");
    focusPane("nope");
    expect(workspace.activePaneId).toBe(PRIMARY_PANE);
  });

  test("focusOtherPane flips between the two, and does nothing with one", () => {
    open("a");
    focusOtherPane();
    expect(workspace.activePaneId).toBe(PRIMARY_PANE);
    open("b");
    splitRight();
    focusOtherPane();
    expect(workspace.activePaneId).toBe(PRIMARY_PANE);
  });
});

describe("collapsing", () => {
  test("closePane hands its documents back rather than closing them", () => {
    open("a");
    open("b");
    splitRight();
    closePane(SECONDARY_PANE);
    expect(workspace.panes.length).toBe(1);
    expect(paneById(PRIMARY_PANE)!.tabOrder).toEqual(["a", "b"]);
    expect(workspace.tabs.size).toBe(2);
  });

  /*
   * "The active pane does not exist" must never be observable.
   *
   * `closePane` removed the pane from the grid while `activePaneId` still named it, so for one
   * synchronous instant every reader that resolves through the focused pane — the stage, the jump
   * bar, the Inspector — saw a pane with no tab. A canvas render scheduled in that instant tore the
   * stage down to nothing, and the focus flip that followed scheduled no repaint, because it
   * changed no `activeTab`. `⌘\` then Unsplit left an editor that only a reload brought back.
   */
  test("unsplit never publishes a focused pane that is not in the grid", () => {
    open("a");
    open("b");
    splitRight();
    const holes: string[] = [];
    const tabless: string[] = [];
    const scope = effectScope();
    scope.run(() => {
      effect(() => {
        const focused = workspace.panes.find((pane) => pane.id === workspace.activePaneId);
        if (!focused) {
          holes.push(workspace.activePaneId);
        } else if (!focused.activeTabId) {
          tabless.push(workspace.activePaneId);
        }
      });
    });

    closePane(SECONDARY_PANE);

    expect(holes).toEqual([]);
    expect(tabless).toEqual([]);
    expect(workspace.activePaneId).toBe(PRIMARY_PANE);
    expect(workspace.activeTabId).toBe("b");
    scope.stop();
  });

  test("closing the last tab in the side pane collapses it", () => {
    open("a");
    open("b");
    splitRight();
    closeTab("b");
    expect(workspace.panes.length).toBe(1);
    expect(workspace.activePaneId).toBe(PRIMARY_PANE);
    expect(workspace.activeTabId).toBe("a");
  });

  test("the primary is never collapsed", () => {
    open("a");
    closePane(PRIMARY_PANE);
    expect(workspace.panes.length).toBe(1);
  });

  test("closePane(PRIMARY) while SPLIT collapses the side pane instead of the primary", () => {
    /* The guard used to live in `collapseEmptiedPane`, one layer up, and both of `closePane`'s
       callers happened to be careful — so the exported function was reachable and unguarded. It
       produced `panes = ["secondary"]`: `resolveRegion("pane")` canonicalises onto `pane.primary`
       and answered null, nine shots lost their subject, and `splitRight` then computed
       `targetId = existing?.id ?? SECONDARY_PANE` with no check that the id was free and pushed a
       SECOND record under "secondary" — a duplicate key in lit's `repeat`, which is undefined
       behaviour. The rule belongs where the removal happens. */
    open("a");
    open("b");
    splitRight();
    expect(workspace.panes.map((p) => p.id)).toEqual([PRIMARY_PANE, SECONDARY_PANE]);

    closePane(PRIMARY_PANE);

    expect(workspace.panes.map((p) => p.id)).toEqual([PRIMARY_PANE]);
    expect(workspace.activePaneId).toBe(PRIMARY_PANE);
    // Both documents are still open, in the pane that stayed.
    expect(paneById(PRIMARY_PANE)!.tabOrder.toSorted()).toEqual(["a", "b"]);
    expect(workspace.tabs.size).toBe(2);
  });

  test("a split after that mints no duplicate pane id — the `repeat` key stays unique", () => {
    open("a");
    open("b");
    splitRight();
    closePane(PRIMARY_PANE);
    splitRight();
    const ids = workspace.panes.map((p) => p.id);
    expect(ids).toEqual([PRIMARY_PANE, SECONDARY_PANE]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("a pane id is unique by construction — splitting twice adds no second record", () => {
    /* `addPane` used to push unconditionally. Nothing in `src/` could reach it twice for one id
       once the primary stopped leaving, but "unreachable today" is not the same property as
       "cannot happen", and the cost of getting it wrong is two cells drawn for one pane, each
       `ref` callback overwriting the other's surface record. */
    open("a");
    open("b");
    splitRight();
    const sideBefore = paneById(SECONDARY_PANE);
    focusPane(PRIMARY_PANE);
    splitRight();
    expect(workspace.panes.map((p) => p.id)).toEqual([PRIMARY_PANE, SECONDARY_PANE]);
    // The SAME record, not a fresh one pushed under the same key.
    expect(paneById(SECONDARY_PANE)).toBe(sideBefore);
  });

  test("unsplitting from the PRIMARY leaves the primary showing its own document", () => {
    /* `survivor.activeTabId = pane.activeTabId ?? survivor.activeTabId` was unconditional, and
       `pane.unsplit` closes the SIDE pane whichever pane is focused — so unsplitting while looking
       at the primary swapped its document for the side pane's. The document you were looking at
       follows you; the one you were not does not replace it. Nothing is lost either way: the side
       pane's tabs are in the primary's strip, one click away. */
    open("a");
    open("b");
    splitRight();
    focusPane(PRIMARY_PANE);
    expect(paneById(PRIMARY_PANE)!.activeTabId).toBe("a");
    expect(paneById(SECONDARY_PANE)!.activeTabId).toBe("b");

    closePane(SECONDARY_PANE);

    expect(workspace.activePaneId).toBe(PRIMARY_PANE);
    expect(workspace.activeTabId).toBe("a");
    // Both documents are still open — this is a layout action, not a destructive one.
    expect(paneById(PRIMARY_PANE)!.tabOrder).toEqual(["a", "b"]);
  });

  test("closing the primary's last tab while split collapses the grid too", () => {
    /* §18.1 rule 3 — a pane with nothing in it is a hole in the grid — held on ONE side only:
       `closeTab` and `detachTab` both exempted the primary, so this left a welcome screen sitting
       beside a live document in a grid nobody had asked to keep. It collapses in the other
       direction, because `pane.primary` is the id nine shots crop and the one `resolveRegion`
       canonicalises onto: the SIDE pane is what leaves, and the primary adopts its tab. */
    open("a");
    open("b");
    splitRight();
    focusPane(PRIMARY_PANE);
    expect(workspace.panes.length).toBe(2);

    closeTab("a");

    expect(workspace.panes.map((p) => p.id)).toEqual([PRIMARY_PANE]);
    expect(workspace.activePaneId).toBe(PRIMARY_PANE);
    expect(workspace.activeTabId).toBe("b");
    expect(paneById(PRIMARY_PANE)!.tabOrder).toEqual(["b"]);
    expect(workspace.tabs.size).toBe(1);
  });

  test("closing the primary's last tab UNSPLIT still leaves the empty primary standing", () => {
    // The floor of the same rule: with one pane there is no grid to collapse, and a shell with no
    // Pane at all has nowhere to draw the welcome screen.
    open("a");
    closeTab("a");
    expect(workspace.panes.map((p) => p.id)).toEqual([PRIMARY_PANE]);
    expect(paneById(PRIMARY_PANE)!.activeTabId).toBeNull();
  });
});

describe("pinning and reorder", () => {
  test("pinning moves a tab to the head; unpinning drops it behind the pinned set", () => {
    open("a");
    open("b");
    open("c");
    setTabPinned("c", true);
    expect(activePane().tabOrder).toEqual(["c", "a", "b"]);
    setTabPinned("b", true);
    expect(activePane().tabOrder).toEqual(["c", "b", "a"]);
    setTabPinned("c", false);
    expect(activePane().tabOrder).toEqual(["b", "c", "a"]);
  });

  test("a drag can never interleave a pinned tab with an unpinned one", () => {
    open("a");
    open("b");
    open("c");
    setTabPinned("a", true);
    moveTab("c", 0); // Asks for the head, which is pinned territory
    expect(activePane().tabOrder).toEqual(["a", "c", "b"]);
    moveTab("a", 5); // A pinned tab cannot leave the prefix either
    expect(activePane().tabOrder).toEqual(["a", "c", "b"]);
  });

  test("reorder inside the unpinned region does what it says", () => {
    open("a");
    open("b");
    open("c");
    moveTab("a", 2);
    expect(activePane().tabOrder).toEqual(["b", "c", "a"]);
  });

  test("pin and reorder ignore ids no pane holds", () => {
    open("a");
    setTabPinned("ghost", true);
    moveTab("ghost", 0);
    expect(activePane().tabOrder).toEqual(["a"]);
  });
});

describe("preview tabs", () => {
  test("a preview open takes the previous preview's slot instead of adding a chip", () => {
    open("keep");
    open("p1", { preview: true });
    expect(activePane().tabOrder).toEqual(["keep", "p1"]);
    open("p2", { preview: true });
    expect(activePane().tabOrder).toEqual(["keep", "p2"]);
    expect(workspace.tabs.has("p1")).toBe(false);
  });

  test("committing — a pin, a promote, an edit — makes the tab permanent", () => {
    open("p1", { preview: true });
    promoteTab("p1");
    expect(workspace.tabs.get("p1")!.preview).toBe(false);
    open("p2", { preview: true });
    expect(activePane().tabOrder).toEqual(["p1", "p2"]);

    setTabPinned("p2", true);
    expect(workspace.tabs.get("p2")!.preview).toBe(false);

    const p3 = open("p3", { preview: true });
    p3.doc.dirty = true;
    promoteDirtyPreviewTabs();
    expect(workspace.tabs.get("p3")!.preview).toBe(false);
  });

  test("re-opening a pinned id never turns it back into a preview", () => {
    open("a");
    setTabPinned("a", true);
    open("a", { preview: true });
    expect(workspace.tabs.get("a")!.preview).toBe(false);
    expect(workspace.tabs.get("a")!.pinned).toBe(true);
  });

  test("promoting an id nothing holds is a no-op", () => {
    promoteTab("ghost");
    expect(workspace.tabs.size).toBe(0);
  });

  /**
   * THE EIGHTH WAY OUT OF A MONACO BUFFER — and the only one that is not a close.
   *
   * `services/monaco-buffer.ts` names seven exits and covers them in two places: five disposers
   * flush, and `commitTabBuffers` covers ⌘W and quitting. This is the eighth, and it wears no
   * warning at all: a single click on another page in the tree destroys the preview tab you were
   * typing in. `promoteDirtyPreviewTabs` is the gate that should make it unreachable — an edited
   * preview tab stops being replaceable — and it reads `doc.dirty`, the exact fact a buffer's armed
   * commit has not established yet. So the last 500ms of a handler body went with the tab, with no
   * dialog, no dirty dot and nothing anywhere saying an edit had gone missing.
   */
  test("replacing a preview tab commits its Monaco buffers first", () => {
    const victim = open("p1", { preview: true });
    const landed: string[] = [];
    const buffer = {
      _editingTab: victim,
      getModel: () => ({}),
      getValue: () => "typed();",
      hasTextFocus: () => false,
    };
    const writes = bufferWrites(buffer);
    writes.markTyped();
    // The dock's commit, as `editors.ts` arms it: synchronous, and it refuses a dead tab.
    writes.arm(BUFFER_COMMIT, 500, () => {
      if (tabIsLive(victim)) {
        landed.push(buffer.getValue());
      }
    });
    view.functionEditor = buffer as never;

    open("p2", { preview: true });

    expect(workspace.tabs.has("p1")).toBe(false);
    expect(landed).toEqual(["typed();"]);
    view.functionEditor = null;
  });

  /*
   * ...and the flush has to come BEFORE the victim is chosen, or the gate runs against the past.
   *
   * `promoteDirtyPreviewTabs` is what makes an edited preview tab unreplaceable, and it reads
   * `doc.dirty` — the fact the flush creates. Choosing the victim first and flushing after asked
   * the gate about the state of half a second ago, then destroyed the tab the gate would have
   * saved. The successful write is what made it silent: the buffer settles, so the discard toast
   * is correctly suppressed, and the edit dies inside a document destroyed on the next line.
   */
  test("a commit that dirties the document promotes the tab out of the slot instead", () => {
    const victim = open("p1", { preview: true });
    const buffer = {
      _editingTab: victim,
      getModel: () => ({}),
      getValue: () => "typed();",
      hasTextFocus: () => false,
    };
    const writes = bufferWrites(buffer);
    writes.markTyped();
    writes.arm(BUFFER_COMMIT, 500, () => {
      victim.doc.dirty = true;
    });
    view.functionEditor = buffer as never;

    open("p2", { preview: true });

    // The victim survives, upright, holding the edit; p2 opens beside it rather than over it.
    expect(workspace.tabs.has("p1")).toBe(true);
    expect(workspace.tabs.get("p1")!.preview).toBe(false);
    expect(activePane().tabOrder).toEqual(["p1", "p2"]);
    view.functionEditor = null;
  });
});

describe("activation across panes", () => {
  test("activating a tab in the other pane focuses that pane too", () => {
    open("a");
    open("b");
    splitRight();
    activateTab("a");
    expect(workspace.activePaneId).toBe(PRIMARY_PANE);
    activateTab("b");
    expect(workspace.activePaneId).toBe(SECONDARY_PANE);
  });
});

describe("the pane commands", () => {
  test("all four are declared at document level in the View category", () => {
    // Four, not six. `pane.toggleZoom` and `pane.setZoomed` wrote `zoomedPaneId` and nothing that
    // Draws ever read it — §18.3 hands one stage between panes, so the focused pane already fills
    // The shell. They return with the second live host.
    const ids = paneCommands().map((c) => c.id);
    expect(ids).toEqual([
      "pane.splitRight",
      "pane.focusPrimary",
      "pane.focusSecondary",
      "pane.unsplit",
    ]);
    for (const command of paneCommands()) {
      expect(command.level).toBe("document");
      expect(command.category).toBe("View");
    }
  });

  test(String.raw`⌘\ is the split chord and ⌘0 / ⌘⌥0 are the focus PAIR`, () => {
    const byId = new Map(paneCommands().map((c) => [c.id, c]));
    expect(byId.get("pane.splitRight")!.keybinding).toBe("mod+\\");
    expect(byId.get("pane.focusPrimary")!.keybinding).toBe("mod+0");
    expect(byId.get("pane.focusSecondary")!.keybinding).toBe("mod+alt+0");
  });

  test("⌘0 is claimed once — `canvas.zoomReset` gave it up rather than sharing it", () => {
    /* Two commands claiming one chord throws at bootstrap, so this is the assertion that keeps
       the pair legal. `canvas.zoomReset` kept its button in the floating zoom pod; focusing a pane
       has no control at all, which is the whole argument for the re-bind. */
    const source = readFileSync(
      join(resolve(import.meta.dir, "..", "src"), "editor", "shortcuts.ts"),
      "utf8",
    );
    const zoomReset = source.slice(source.indexOf('id: "canvas.zoomReset"'));
    expect(zoomReset.slice(0, zoomReset.indexOf("},"))).not.toContain("keybinding");
  });

  test("the three grid commands refuse with a sentence until the grid is split", () => {
    const registry = registryWith(paneCommands());
    open("a");
    for (const id of ["pane.focusPrimary", "pane.focusSecondary", "pane.unsplit"]) {
      expect(registry.isEnabled(id)).toBe(false);
      expect(registry.disabledReason(id)).toBe("a split pane grid");
    }
    open("b");
    splitRight();
    expect(registry.isEnabled("pane.unsplit")).toBe(true);
  });

  test("Split Right needs only a document, and says so", () => {
    const registry = registryWith(paneCommands());
    expect(registry.isEnabled("pane.splitRight")).toBe(false);
    expect(registry.disabledReason("pane.splitRight")).toBe("an open document");
    // A Canvas-only document used to be refused BY NAME here. It is not any more.
    openCanvasOnly("only");
    expect(registry.isEnabled("pane.splitRight")).toBe(true);
  });

  test("running them drives the model", async () => {
    const registry = registryWith(paneCommands());
    open("a");
    open("b");
    await registry.run("pane.splitRight");
    expect(workspace.panes.length).toBe(2);
    await registry.run("pane.focusPrimary");
    expect(workspace.activePaneId).toBe(PRIMARY_PANE);
    await registry.run("pane.focusSecondary");
    expect(workspace.activePaneId).toBe(SECONDARY_PANE);
    await registry.run("pane.unsplit");
    expect(workspace.panes.length).toBe(1);
  });

  test("Unsplit from the primary collapses the side pane, not the primary", async () => {
    const registry = registryWith(paneCommands());
    open("a");
    open("b");
    splitRight();
    focusPane(PRIMARY_PANE);
    await registry.run("pane.unsplit");
    expect(workspace.panes.map((p) => p.id)).toEqual([PRIMARY_PANE]);
  });
});

describe("the two new tab commands", () => {
  const deps = { openFile: () => {} };

  test("Pin / Unpin toggles the focused tab", async () => {
    const registry = registryWith(tabCommands(deps) as ReturnType<typeof paneCommands>);
    open("a");
    await registry.run("document.togglePinned");
    expect(workspace.tabs.get("a")!.pinned).toBe(true);
    await registry.run("document.togglePinned");
    expect(workspace.tabs.get("a")!.pinned).toBe(false);
  });

  test("Keep Document Open is available only for a preview tab", async () => {
    const registry = registryWith(tabCommands(deps) as ReturnType<typeof paneCommands>);
    open("a");
    expect(registry.isEnabled("document.keepOpen")).toBe(false);
    expect(registry.disabledReason("document.keepOpen")).toBe(
      "a preview document — one opened by a single click",
    );
    open("p", { preview: true });
    expect(registry.isEnabled("document.keepOpen")).toBe(true);
    await registry.run("document.keepOpen");
    expect(workspace.tabs.get("p")!.preview).toBe(false);
  });

  test("⌃Tab is offered whenever a second document is open in EITHER pane", () => {
    const registry = registryWith(tabCommands(deps) as ReturnType<typeof paneCommands>);
    open("a");
    expect(registry.isEnabled("document.nextTab")).toBe(false);
    open("b");
    splitRight();
    expect(activePane().tabOrder.length).toBe(1);
    expect(registry.isEnabled("document.nextTab")).toBe(true);
  });
});

describe("the empty context still describes one pane", () => {
  test("`pane.count` defaults to 1 — the grid is never zero panes", () => {
    expect(emptyContext().pane.count).toBe(1);
  });
});

describe("closing lands on the MRU tab, not the rightmost", () => {
  test("the tab you were in before is the one you land on", () => {
    open("a");
    open("b");
    open("c");
    activateTab("a");
    activateTab("b");
    closeTab("b");
    expect(workspace.activeTabId).toBe("a");
  });

  test("closing a background tab leaves the focus where it was", () => {
    open("a");
    open("b");
    closeTab("a");
    expect(workspace.activeTabId).toBe("b");
  });
});
