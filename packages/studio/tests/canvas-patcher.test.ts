/**
 * Canvas patcher — surgical DOM updates for style/text edits. Verifies classification rules,
 * in-place style/text application (element identity preserved, no full render), scoped style-tag
 * replacement, and the consumed-document handshake.
 */
import "./with-dom.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  activeCanvasSurface,
  surfaceForPane,
  surfacesShowingTab,
} from "../src/canvas/canvas-surface";
import {
  closeAllTabs,
  focusPane,
  openTab,
  PRIMARY_PANE,
  SECONDARY_PANE,
  splitRight,
  workspace,
} from "../src/workspace/workspace";
import { getPatchConsumer, setPatchConsumer } from "../src/tabs/patch-ops";
import {
  applyDerivation,
  clearPaneDerivation,
  noopDerivationDeps,
  setPaneDerivation,
} from "../src/workspace/pane-derive";
import {
  applyPatchBatch,
  classifyOps,
  consumePatchedDocument,
  escalateToFullRender,
  initCanvasPatcher,
} from "../src/canvas/canvas-patcher";
import { canvasPerf, resetCanvasPerf } from "../src/canvas/canvas-perf";
import { toRaw } from "../src/reactivity";

import type { CanvasSurface } from "../src/canvas/canvas-surface";
import type { CanvasPanel } from "../src/types";
import type { JxMutableNode } from "@jxsuite/schema/types";
import type { Tab } from "../src/tabs/tab";

/* The panels of the FOCUSED pane's stage. Panels belong to a pane's surface now, not to the
   app (`src/canvas/canvas-surface.ts`); the array identity is stable, so a module-level
   binding still sees what the render mutated. */
const canvasPanels = activeCanvasSurface().panels;

let tab: Tab;
let tabCount = 0;
let panel: CanvasPanel;
let rootEl: HTMLElement;
let pEl: HTMLElement;
let spanEl: HTMLElement;
let divEl: HTMLElement;
let emEl: HTMLElement;
/** Written onto the tab under test — the pane's mode IS its tab's mode now. */
let canvasMode = "design";
const ctxCalls = {
  overlays: 0,
  scheduled: 0,
  lastPaneId: "",
};

function doc(): JxMutableNode {
  return toRaw(tab.doc.document) as JxMutableNode;
}

function child(i: number): JxMutableNode {
  return (doc().children as JxMutableNode[])[i]!;
}

beforeEach(() => {
  resetCanvasPerf();
  canvasMode = "design";
  ctxCalls.overlays = 0;
  ctxCalls.scheduled = 0;

  tabCount += 1;
  tab = openTab({
    document: {
      children: [
        { style: { color: "red" }, tagName: "p", textContent: "hello" },
        { tagName: "span", textContent: "world" },
        { children: [{ tagName: "em", textContent: "deep" }], tagName: "div" },
      ],
      tagName: "div",
    },
    id: `patcher-test-${tabCount}`,
  }) as Tab;

  const canvas = document.createElement("div");
  rootEl = document.createElement("div");
  pEl = document.createElement("p");
  pEl.textContent = "hello";
  pEl.style.color = "red";
  pEl.style.pointerEvents = "none";
  spanEl = document.createElement("span");
  spanEl.textContent = "world";
  divEl = document.createElement("div");
  emEl = document.createElement("em");
  emEl.textContent = "deep";
  divEl.append(emEl);
  rootEl.append(pEl, spanEl, divEl);
  canvas.append(rootEl);
  document.body.append(canvas);

  panel = {
    canvas,
    mediaName: "",
    ready: true,
  } as unknown as CanvasPanel;
  canvasPanels.push(panel);

  tab.session.ui.canvasMode = canvasMode;

  initCanvasPatcher({
    renderOverlays: () => {
      ctxCalls.overlays += 1;
    },
    scheduleCanvasRender: (paneId: string) => {
      ctxCalls.scheduled += 1;
      ctxCalls.lastPaneId = paneId;
    },
  });
});

afterEach(() => {
  setPatchConsumer(null);
  canvasPanels.length = 0;
  // `closeAllTabs` resets the pane model but not the stages the panes had; a surface outliving its
  // Pane is exactly the leak the per-pane tests would otherwise carry into the next file.
  surfaceForPane(SECONDARY_PANE).panels.length = 0;
  document.body.innerHTML = "";
  for (const s of document.head.querySelectorAll("style")) {
    s.remove();
  }
  closeAllTabs();
});

describe("classifyOps", () => {
  test("accepts style and leaf-text ops in design mode with ready panels", () => {
    expect(classifyOps(tab, [{ op: "set-style", path: ["children", 0] }]).patchable).toBe(true);
    expect(classifyOps(tab, [{ op: "set-text", path: ["children", 0] }]).patchable).toBe(true);
    expect(
      classifyOps(tab, [{ isEvent: true, key: "onclick", op: "set-prop", path: ["children", 0] }])
        .patchable,
    ).toBe(true);
  });

  test("rejects outside design/edit modes", () => {
    canvasMode = "preview";
    tab.session.ui.canvasMode = "preview";
    const verdict = classifyOps(tab, [{ op: "set-style", path: ["children", 0] }]);
    expect(verdict.patchable).toBe(false);
    expect(verdict.reason).toBe("mode-preview");
  });

  test("rejects when a panel is not ready", () => {
    panel.ready = false;
    expect(classifyOps(tab, [{ op: "set-style", path: ["children", 0] }]).reason).toBe(
      "panels-not-ready",
    );
  });

  test("rejects $switch cases paths but accepts $map template paths", () => {
    expect(classifyOps(tab, [{ op: "set-style", path: ["cases", "a"] }]).reason).toBe(
      "style-on-cases-path",
    );
    // Give the doc a $map container: children[3] = ul with a mapped-array template
    (doc().children as JxMutableNode[]).push({
      children: {
        $prototype: "Array",
        items: ["a", "b"],
        map: { tagName: "li", textContent: "item" },
      } as unknown as JxMutableNode[],
      tagName: "ul",
    });
    expect(
      classifyOps(tab, [{ op: "set-style", path: ["children", 3, "children", "map"] }]).patchable,
    ).toBe(true);
  });

  test("array member node: structural ops on it patch; structural ops inside its template escalate", () => {
    // Array pseudo-element as a member at children[3].
    (doc().children as JxMutableNode[]).push({
      $prototype: "Array",
      items: ["a", "b"],
      map: { children: [{ tagName: "span" }], tagName: "li" },
    } as unknown as JxMutableNode);

    // Removing/moving the array node itself is a normal sibling splice → patchable.
    expect(classifyOps(tab, [{ op: "remove", path: ["children", 3] }]).patchable).toBe(true);
    expect(
      classifyOps(tab, [{ fromPath: ["children", 3], op: "move", toIndex: 0, toParentPath: [] }])
        .patchable,
    ).toBe(true);
    // Inserting a sibling next to the array (parent is the root children array) → patchable.
    expect(classifyOps(tab, [{ index: 3, op: "insert", parentPath: [] }]).patchable).toBe(true);

    // Structural edits *inside* the repeater template escalate (the perimeter holds one instance).
    expect(
      classifyOps(tab, [{ index: 1, op: "insert", parentPath: ["children", 3, "map"] }]).reason,
    ).toBe("structure-on-map-path");
    expect(
      classifyOps(tab, [{ op: "remove", path: ["children", 3, "map", "children", 0] }]).reason,
    ).toBe("structure-on-map-path");
  });

  test("rejects text ops on nodes with children, innerHTML, or custom-element tags", () => {
    expect(classifyOps(tab, [{ op: "set-text", path: [] }]).reason).toBe("text-with-children");
    child(0).innerHTML = "<b>x</b>";
    expect(classifyOps(tab, [{ op: "set-text", path: ["children", 0] }]).reason).toBe(
      "text-with-innerhtml",
    );
    delete child(0).innerHTML;
    child(0).tagName = "my-widget";
    expect(classifyOps(tab, [{ op: "set-text", path: ["children", 0] }]).reason).toBe(
      "text-on-custom-element",
    );
  });

  test("accepts structural and non-event prop ops", () => {
    expect(classifyOps(tab, [{ index: 0, op: "insert", parentPath: [] }]).patchable).toBe(true);
    expect(classifyOps(tab, [{ op: "remove", path: ["children", 0] }]).patchable).toBe(true);
    expect(
      classifyOps(tab, [{ fromPath: ["children", 0], op: "move", toIndex: 1, toParentPath: [] }])
        .patchable,
    ).toBe(true);
    expect(
      classifyOps(tab, [{ isEvent: false, key: "href", op: "set-prop", path: ["children", 0] }])
        .patchable,
    ).toBe(true);
  });

  test("rejects root replaces, and structural ops inside a nested component instance", () => {
    expect(classifyOps(tab, [{ op: "replace", path: [] }]).reason).toBe("replace-root");
    // A hyphenated ROOT is a component definition opened as its own document — its children are the
    // Document's own light DOM, so it patches (see the definition-root test below). The boundary is a
    // Component INSTANCE nested inside the document.
    doc().tagName = "my-app";
    expect(classifyOps(tab, [{ index: 0, op: "insert", parentPath: [] }]).patchable).toBe(true);
    (doc().children as JxMutableNode[]).push({ children: [{ tagName: "p" }], tagName: "x-card" });
    expect(classifyOps(tab, [{ index: 0, op: "insert", parentPath: ["children", 3] }]).reason).toBe(
      "structure-in-custom-element",
    );
  });
});

describe("consumed-document handshake", () => {
  test("consumePatchedDocument is one-shot per marked reference, per pane", () => {
    const consumer = getPatchConsumer()!;
    consumer.markConsumed(toRaw(tab.doc.document) as object, tab);
    expect(consumePatchedDocument(tab.doc.document, PRIMARY_PANE)).toBe(true);
    expect(canvasPerf.skippedFullRenders).toBe(1);
    expect(consumePatchedDocument(tab.doc.document, PRIMARY_PANE)).toBe(false);
  });

  test("a mark reaching TWO panes lets both skip, and counts two skips", () => {
    /* Fails against a `WeakSet<object>` of references: the first pane's doc-effect deletes the one
       mark and the second full-renders every surgically patched edit, while `skippedFullRenders`
       still reports a single skip. Both panes display the SAME tab, which is what a derived pane
       is — reached here through `splitRight` plus a hand-placed `activeTabId`, because the
       displaying relation is all `surfacesShowingTab` reads. */
    const other = openTab({ document: { tagName: "div" }, documentPath: "/p/other.json", id: "o" });
    expect(splitRight()?.id).toBe(SECONDARY_PANE);
    workspace.panes.find((pane) => pane.id === PRIMARY_PANE)!.activeTabId = tab.id;
    workspace.panes.find((pane) => pane.id === SECONDARY_PANE)!.activeTabId = tab.id;

    const consumer = getPatchConsumer()!;
    consumer.markConsumed(toRaw(tab.doc.document) as object, tab);
    expect(consumePatchedDocument(tab.doc.document, PRIMARY_PANE)).toBe(true);
    expect(consumePatchedDocument(tab.doc.document, SECONDARY_PANE)).toBe(true);
    expect(canvasPerf.skippedFullRenders).toBe(2);
    expect(consumePatchedDocument(tab.doc.document, PRIMARY_PANE)).toBe(false);
    void other;
  });

  /* FINDING 2. Open Code beside a page and type: the Code view did not move.
     `markConsumed` marked EVERY stage displaying the tab; `classifyOps` SKIPS a stage that cannot
     patch. Two functions, one set, and they disagreed — so the lens was marked as having taken a
     patch it never received (`postPatchToHosts` matches no host for a pane with no artboards), its
     doc-effect returned before `scheduleCanvasRender(paneId)`, and `canvas-render.ts`'s source fast
     path — the ONLY thing that refreshes a source-mode Monaco — never ran. `skippedFullRenders`
     counted it as a win.

     The audit's probe: `primary skips full render: true / CODE LENS skips full render: true`.
     The second `true` is what this test forbids; the first is the two-DESIGN-pane case above, which
     must stay. */
  test("a CODE LENS is not marked as patched — it received no patch and owes a full render", () => {
    const scratch = openTab({
      document: { children: [], tagName: "div" },
      documentPath: "/p/lens-scratch.js",
      id: `patcher-lens-${tabCount}`,
    });
    expect(splitRight()?.id).toBe(SECONDARY_PANE);
    setPaneDerivation(SECONDARY_PANE, {
      diff: null,
      kind: "lens",
      media: null,
      mode: "source",
      preset: "code",
      reason: "",
      sourcePaneId: PRIMARY_PANE,
      status: "ready",
      zoom: 1,
    });
    applyDerivation(SECONDARY_PANE, noopDerivationDeps());
    focusPane(PRIMARY_PANE);
    // Both stages DISPLAY the tab — that is what a lens is.
    expect(surfacesShowingTab(tab).map((s) => s.paneId)).toEqual([PRIMARY_PANE, SECONDARY_PANE]);

    getPatchConsumer()!.markConsumed(toRaw(tab.doc.document) as object, tab);

    /* THE LENS IS ASKED FIRST, and the order is the assertion. A mark is a `Set` of pane ids; ask
       the pane that OWNS the mark first and the set empties, so the lens's answer is "no mark for
       this document at all" and a membership check that ignored the pane id would give the same
       false. Asking the lens while the mark is still live is the only order in which "this mark is
       not yours" and "there is no mark" are different answers. */
    expect(consumePatchedDocument(tab.doc.document, SECONDARY_PANE)).toBe(false);
    // …and the pane that CAN patch skips its full render.
    expect(consumePatchedDocument(tab.doc.document, PRIMARY_PANE)).toBe(true);
    expect(canvasPerf.skippedFullRenders).toBe(1);

    clearPaneDerivation(SECONDARY_PANE);
    void scratch;
  });

  test("escalateToFullRender schedules the showing pane's render and records the reason", () => {
    escalateToFullRender("test-reason", tab);
    expect(ctxCalls.scheduled).toBe(1);
    expect(ctxCalls.lastPaneId).toBe(PRIMARY_PANE);
    expect(canvasPerf.escalations).toBe(1);
    expect(canvasPerf.lastEscalationReason).toBe("test-reason");
  });

  /* …and EVERY stage that was handed the patch, which is the other half of the same plural.
     An escalation is a statement about a stage whose DOM no longer matches its document, and a
     document displayed in two panes was handed the patch in both — so a loop that stopped at the
     first leaves the second showing a picture that does not match, with nothing scheduled to fix
     it and one escalation counted for two stale stages. */
  test("escalateToFullRender schedules BOTH stages when two panes display the tab", () => {
    const other = openTab({ document: { tagName: "div" }, documentPath: "/p/esc.json", id: "esc" });
    expect(splitRight()?.id).toBe(SECONDARY_PANE);
    workspace.panes.find((pane) => pane.id === PRIMARY_PANE)!.activeTabId = tab.id;
    workspace.panes.find((pane) => pane.id === SECONDARY_PANE)!.activeTabId = tab.id;

    escalateToFullRender("two-stage-reason", tab);

    expect(ctxCalls.scheduled).toBe(2);
    expect(ctxCalls.lastPaneId).toBe(SECONDARY_PANE);
    expect(canvasPerf.escalations).toBe(1);
    void other;
  });
});

// ─── Per-pane gating (P8): every question is asked of the pane showing the tab ───────

describe("the gate is per pane, not per app", () => {
  /**
   * Put `tab` in the primary pane and a second document in the secondary, with the SECOND pane
   * focused. This is the shape the whole section is about: the edit under test belongs to a stage
   * nobody is looking at.
   */
  function splitWithSecondPaneFocused(): { otherTab: Tab; otherSurface: CanvasSurface } {
    const otherTab = openTab({
      document: { children: [], tagName: "div" },
      documentPath: "/p/other.js",
      id: `patcher-other-${tabCount}`,
    }) as Tab;
    otherTab.session.ui.canvasMode = "source";
    expect(splitRight()?.id).toBe(SECONDARY_PANE);
    expect(workspace.activePaneId).toBe(SECONDARY_PANE);
    return { otherSurface: surfaceForPane(SECONDARY_PANE), otherTab };
  }

  test("a tab on screen in the UNFOCUSED pane still patches", () => {
    splitWithSecondPaneFocused();
    // Before this, the gate asked `isTabActive(tab)` — the keyboard's pane — and refused.
    expect(classifyOps(tab, [{ op: "set-style", path: ["children", 0] }]).patchable).toBe(true);
  });

  test("the other pane's mid-mount canvas cannot refuse this pane's edit", () => {
    const { otherSurface } = splitWithSecondPaneFocused();
    otherSurface.panels.push({ canvas: document.createElement("div"), ready: false } as never);
    // The readiness test used to run over one global panel list, so an artboard still mounting in
    // The OTHER pane escalated an edit typed into this one.
    expect(classifyOps(tab, [{ op: "set-style", path: ["children", 0] }]).patchable).toBe(true);
    // This pane's own un-ready artboard still refuses, which is the rule that was always right.
    panel.ready = false;
    expect(classifyOps(tab, [{ op: "set-style", path: ["children", 0] }]).reason).toBe(
      "panels-not-ready",
    );
  });

  test("the mode read is the showing pane's, not the focused pane's", () => {
    const { otherTab } = splitWithSecondPaneFocused();
    // The focused pane is in Code; the pane showing `tab` is in Design and patches.
    expect(otherTab.session.ui.canvasMode).toBe("source");
    expect(classifyOps(tab, [{ op: "set-style", path: ["children", 0] }]).patchable).toBe(true);
    // Flip only the SHOWING pane's tab and the same batch is refused, naming that mode.
    tab.session.ui.canvasMode = "source";
    expect(classifyOps(tab, [{ op: "set-style", path: ["children", 0] }]).reason).toBe(
      "mode-source",
    );
  });

  test("an escalation rebuilds only the pane whose stage fell behind", () => {
    splitWithSecondPaneFocused();
    escalateToFullRender("boom", tab);
    expect(ctxCalls.scheduled).toBe(1);
    expect(ctxCalls.lastPaneId).toBe(PRIMARY_PANE);
  });

  test("a CODE LENS beside the page is SKIPPED, not counted as a rejection", () => {
    /* The one that would have killed surgical patching outright. A lens draws the source pane's
       document, so `surfacesShowingTab` names both stages — and a Code lens has no artboards and
       is in no patchable mode. Folded into `every`, it rejects the batch as `mode-source` or
       `no-panels`, and every keystroke in the page full-renders BOTH stages. Only when NO showing
       stage can take the patch is the mode a rejection. */
    const scratch = openTab({
      document: { children: [], tagName: "div" },
      documentPath: "/p/scratch.js",
      id: `patcher-scratch-${tabCount}`,
    });
    expect(splitRight()?.id).toBe(SECONDARY_PANE);
    setPaneDerivation(SECONDARY_PANE, {
      diff: null,
      kind: "lens",
      media: null,
      mode: "source",
      preset: "code",
      reason: "",
      sourcePaneId: PRIMARY_PANE,
      status: "ready",
      zoom: 1,
    });
    applyDerivation(SECONDARY_PANE, noopDerivationDeps());
    focusPane(PRIMARY_PANE);

    // Both stages display `tab`; only the primary can patch, and that is enough.
    expect(surfacesShowingTab(tab).map((s) => s.paneId)).toEqual([PRIMARY_PANE, SECONDARY_PANE]);
    expect(classifyOps(tab, [{ op: "set-style", path: ["children", 0] }]).patchable).toBe(true);

    // …and when the SOURCE pane cannot patch either, the mode is a rejection again.
    tab.session.ui.canvasMode = "source";
    expect(classifyOps(tab, [{ op: "set-style", path: ["children", 0] }]).reason).toBe(
      "mode-source",
    );
    tab.session.ui.canvasMode = canvasMode;
    clearPaneDerivation(SECONDARY_PANE);
    void scratch;
  });

  test("a tab no pane is showing rejects, and its escalation schedules nothing", () => {
    const background = tab;
    openTab({ document: { children: [], tagName: "div" }, id: `patcher-fg-${tabCount}` });
    expect(classifyOps(background, [{ op: "set-style", path: ["children", 0] }])).toEqual({
      patchable: false,
      reason: "inactive-tab",
    });
    // The reason is still counted — a swallowed escalation no counter saw is the bug
    // `__jxCanvasPerf` exists to prevent.
    const before = canvasPerf.escalations;
    escalateToFullRender("off-screen", background);
    expect(canvasPerf.escalations).toBe(before + 1);
    expect(ctxCalls.scheduled).toBe(0);
  });
});

// ─── Iframe canvas host (Phase 3a): narrower classify gate + post-over-bridge apply ─────

describe("iframe canvas host gating", () => {
  test("classification is host-agnostic: the iframe admits the full surgical op set", () => {
    // After Phase 3b the iframe applies every op the legacy patcher does (in-place, structural
    // Relocation, and subtree re-renders), so classify no longer rejects anything extra in iframe
    // Mode — an op the iframe can't apply escalates at apply time instead.
    expect(classifyOps(tab, [{ op: "set-style", path: ["children", 0] }]).patchable).toBe(true);
    expect(classifyOps(tab, [{ op: "set-text", path: ["children", 0] }]).patchable).toBe(true);
    expect(classifyOps(tab, [{ op: "remove", path: ["children", 0] }]).patchable).toBe(true);
    expect(
      classifyOps(tab, [{ fromPath: ["children", 0], op: "move", toIndex: 1, toParentPath: [] }])
        .patchable,
    ).toBe(true);
    expect(classifyOps(tab, [{ index: 0, op: "insert", parentPath: [] }]).patchable).toBe(true);
    expect(classifyOps(tab, [{ op: "replace", path: ["children", 0] }]).patchable).toBe(true);
    expect(classifyOps(tab, [{ key: "id", op: "set-prop", path: ["children", 0] }]).patchable).toBe(
      true,
    );
  });

  test("admits patches on a panel with no parent-side render context — iframe-mode panel state", () => {
    // In iframe mode the parent never runs a legacy in-realm render, so the panel holds no
    // Parent-side render scope; classification keys only off `ready`, never escalating on its
    // Absence (it did once, escalating every iframe edit to a full render).
    expect(classifyOps(tab, [{ op: "set-style", path: ["children", 0] }]).patchable).toBe(true);
    expect(classifyOps(tab, [{ op: "remove", path: ["children", 0] }]).patchable).toBe(true);
    expect(classifyOps(tab, [{ index: 0, op: "insert", parentPath: [] }]).patchable).toBe(true);
  });

  test("apply leaves the parent DOM untouched and throws when no iframe host is ready", () => {
    const before = pEl.textContent;
    expect(() =>
      applyPatchBatch(tab, [{ op: "set-text", path: ["children", 0] }], {
        docOps: [
          {
            forward: { key: "textContent", op: "set-key", path: ["children", 0], value: "X" },
            inverse: { key: "textContent", op: "set-key", path: ["children", 0], value: "hello" },
          },
        ],
        fmOps: [],
        invertible: true,
        ops: [{ op: "set-text", path: ["children", 0] }],
      }),
    ).toThrow(/no-ready-iframe-host/);
    // In iframe mode the parent owns no canvas DOM — the edit crosses the bridge, never mutates here.
    expect(pEl.textContent).toBe(before);
  });
});

// ─── Rich-commit subsumption (set-text swallowed by a same-path children replace) ───

describe("rich-commit batch subsumption", () => {
  test("set-text + set-prop(children) on the SAME node classifies patchable", () => {
    // Simulate the post-mutation state a rich inline commit leaves behind: the node now HAS
    // Children (classification runs after the mutation), which a lone set-text would reject.
    const node = (tab.doc.document.children as Record<string, unknown>[])[0]!;
    node.children = ["a ", { tagName: "strong", textContent: "b" }];
    delete node.textContent;

    const verdict = classifyOps(tab, [
      { op: "set-text", path: ["children", 0] },
      { key: "children", op: "set-prop", path: ["children", 0] },
    ]);
    expect(verdict.patchable).toBe(true);

    // The subsumption is path-exact: the same batch with the children op on ANOTHER node still
    // Rejects the set-text.
    expect(
      classifyOps(tab, [
        { op: "set-text", path: ["children", 0] },
        { key: "children", op: "set-prop", path: ["children", 1] },
      ]).reason,
    ).toBe("text-with-children");
  });
});

// ─── Custom-element ancestors: by-path replaces patch, index splices escalate ────

describe("custom-element ancestor classification", () => {
  /** Add an eer-intro-style component child wrapping a rich paragraph (markdown class-directive). */
  function addComponentSubtree() {
    (doc().children as JxMutableNode[]).push({
      children: [{ children: ["call ", { tagName: "strong", textContent: "now" }], tagName: "p" }],
      tagName: "eer-intro",
    });
  }

  test("a splice with a component ANCESTOR but a plain parent is patchable", () => {
    addComponentSubtree();
    // `<eer-intro><p>call <strong>now</strong></p></eer-intro>` — the splice parent is the <p>, a
    // Plain container whose light-DOM child order is its own. Slot projection at the component
    // Boundary above it changes where the <p> renders, not the order of the <p>'s children. This is
    // The real-content case: markdown class-directive pages put every editable block inside a
    // Component, so pressing Enter there used to force a full render (reloading embedded iframes).
    const paragraph = ["children", 3, "children", 0];
    expect(classifyOps(tab, [{ index: 1, op: "insert", parentPath: paragraph }]).patchable).toBe(
      true,
    );
    expect(
      classifyOps(tab, [{ op: "remove", path: [...paragraph, "children", 1] }]).patchable,
    ).toBe(true);
    expect(
      classifyOps(tab, [
        {
          fromPath: [...paragraph, "children", 1],
          op: "move",
          toIndex: 0,
          toParentPath: paragraph,
        },
      ]).patchable,
    ).toBe(true);
  });

  test("a rich text commit INSIDE a component is patchable (embedded-iframe CLS regression)", () => {
    addComponentSubtree();
    // The rich-commit shape: clear text + set children on the paragraph inside <eer-intro>. The
    // Iframe swaps the paragraph by its stamped data-jx-path — slot redistribution is irrelevant —
    // So this must NOT escalate (a full render reloads embedded iframes on the page).
    const verdict = classifyOps(tab, [
      { op: "set-text", path: ["children", 3, "children", 0] },
      { key: "children", op: "set-prop", path: ["children", 3, "children", 0] },
    ]);
    expect(verdict.patchable).toBe(true);
    // A lone prop change on the nested node patches too.
    expect(
      classifyOps(tab, [{ key: "title", op: "set-prop", path: ["children", 3, "children", 0] }])
        .patchable,
    ).toBe(true);
  });

  test("a component DEFINITION opened as its own document patches at its root", () => {
    // Component definitions have hyphenated root tagNames (`examples/components/*.json` all do), but
    // The canvas renders the definition's own body — its children are ordinary light DOM, not an
    // Instance's slot content. Escalating here made every structural edit to any component a full
    // Render. Same carve-out isIslandBoundary makes for the caret.
    doc().tagName = "fetch-demo";
    expect(classifyOps(tab, [{ index: 0, op: "insert", parentPath: [] }]).patchable).toBe(true);
    expect(classifyOps(tab, [{ op: "remove", path: ["children", 0] }]).patchable).toBe(true);
    expect(
      classifyOps(tab, [{ fromPath: ["children", 0], op: "move", toIndex: 1, toParentPath: [] }])
        .patchable,
    ).toBe(true);
  });

  test("a splice whose IMMEDIATE parent is a component still escalates", () => {
    addComponentSubtree();
    // Splices pick their insertion reference with `parentEl.childNodes[i]`. When the parent itself is
    // A component its children may be rendered by the component rather than as light DOM, so an
    // Insert would land in the wrong place rather than fail loudly — stay conservative here.
    expect(classifyOps(tab, [{ index: 1, op: "insert", parentPath: ["children", 3] }]).reason).toBe(
      "structure-in-custom-element",
    );
    expect(classifyOps(tab, [{ op: "remove", path: ["children", 3, "children", 0] }]).reason).toBe(
      "structure-in-custom-element",
    );
    expect(
      classifyOps(tab, [
        {
          fromPath: ["children", 3, "children", 0],
          op: "move",
          toIndex: 0,
          toParentPath: ["children", 2],
        },
      ]).reason,
    ).toBe("structure-in-custom-element");
  });

  test("a replace under an innerHTML parent or inside a repeater template still escalates", () => {
    (doc().children as JxMutableNode[]).push({
      children: [{ tagName: "b", textContent: "x" }],
      innerHTML: "<b>x</b>",
      tagName: "div",
    });
    expect(
      classifyOps(tab, [{ key: "children", op: "set-prop", path: ["children", 3, "children", 0] }])
        .reason,
    ).toBe("structure-with-innerhtml");
    (doc().children as JxMutableNode[]).push({
      $prototype: "Array",
      map: { children: [{ tagName: "span" }], tagName: "li" },
      tagName: "ul",
    } as never);
    expect(
      classifyOps(tab, [
        { key: "children", op: "set-prop", path: ["children", 4, "map", "children", 0] },
      ]).reason,
    ).toBe("structure-on-map-path");
  });
});
