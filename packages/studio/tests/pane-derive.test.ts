/**
 * Derived panes (§18.4) — the five invariants, the pure target resolver, and THE MEMO.
 *
 * The one test here that measures something rather than checking a shape is the memo: a `component`
 * follow observes the SELECTION, the selection moves on every click, and the document root
 * reference is replaced on every keystroke. If either of those re-runs the follow's expensive half,
 * a pane the author leaves open all day re-reads and re-renders a file on every character they
 * type. Everything else in this file is cheap to state and would have been noticed; that one would
 * not.
 */
import { resetStudioState } from "./harness";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  PRIMARY_PANE,
  SECONDARY_PANE,
  activateTab,
  closeAllTabs,
  closePane,
  closeTab,
  focusPane,
  moveTabToPane,
  openTab,
  paneOfTab,
  splitRight,
  workspace,
} from "../src/workspace/workspace";
import {
  DERIVE_PRESETS,
  applyDerivation,
  clearPaneDerivation,
  componentPathUnderSelection,
  derivationCommands,
  derivationOfPane,
  derivedTarget,
  deriveRefusal,
  installDerivationEffects,
  noopDerivationDeps,
  presetRefusal,
  setPaneDerivation,
} from "../src/workspace/pane-derive";
import { canvasPerf, resetCanvasPerf } from "../src/canvas/canvas-perf";
import { componentRegistry } from "../src/files/components";
import { tabOfPane } from "../src/canvas/canvas-surface";
import { createCommandRegistry } from "../src/commands/registry";
import { makeContext } from "../src/commands/context";
import { effectScope, toRaw } from "../src/reactivity";
import { shell } from "../src/shell";
import { transactDoc, mutateUpdateProperty } from "../src/tabs/transact";
import type { DerivationDeps } from "../src/workspace/pane-derive";
import type { PaneDerivation } from "../src/workspace/workspace";
import type { GitDiffState } from "../src/types";
import type { Tab } from "../src/tabs/tab";
import type { EffectScope } from "@vue/reactivity";

// ─── Fixture ──────────────────────────────────────────────────────────────────

/** Every `openFileInPane` the derivation asked for, in order. The follow's whole output. */
const opened: { paneId: string; path: string }[] = [];

/** Every `loadDiff` it asked for, and what the fake platform hands back for the next one. */
const diffsAsked: { path: string; fileStatus: string }[] = [];
let nextDiff: GitDiffState | null = null;

/**
 * Every `fileExists` the locale companion asked for, and the files the fake disk actually holds.
 *
 * Recorded rather than counted, because the interesting assertion is that the SAME wanted path is
 * asked about once however many frames resolve — a probe re-issued per frame is the failure
 * {@link _localeProbes} exists to prevent, and a bare call count cannot tell it from two panes.
 */
const existsAsked: string[] = [];
const filesOnDisk = new Set<string>();

const deps: DerivationDeps = {
  fileExists: (path: string) => {
    existsAsked.push(path);
    return Promise.resolve(filesOnDisk.has(path));
  },
  loadDiff: (path: string, fileStatus: string) => {
    diffsAsked.push({ fileStatus, path });
    return Promise.resolve(nextDiff && { ...nextDiff, filePath: path });
  },
  openFileInPane: (paneId: string, path: string) => {
    opened.push({ paneId, path });
    /* …and it OPENS, through the SAME dedupe the real one has. This used to only RECORD, and a
       fake that never puts a document in the pane makes "the pane is showing what it resolved"
       unassertable — which is how a companion whose document the author closed could sit stranded
       behind its own memo with nothing able to contradict it.
       One `openTab` was still not the real shape. `files/files.ts`'s `openFileInPane` is
       `openFileInTab(path, { focus: false, paneId, preview: true })`, and that function's FIRST
       branch is a dedupe: a document already open is REVEALED, not re-opened, by `revealOpenTab` —
       three cases, of which the third is a documented NO-OP (it is another pane's active tab, and
       moving it would yank the author's own document into the assistant pane and oscillate). That
       third case is the one the companion presets hit constantly, because "the layout of the page
       I am editing" and "the definition of the component I just clicked" are very often already
       open. A one-case fake leaves it as the only path with no coverage at all. */
    const existing = [...workspace.tabs.values()].find((tab) => tab.documentPath === path);
    if (!existing) {
      openTab({
        document: { children: [{ tagName: "header" }, { tagName: "footer" }], tagName: "div" },
        documentPath: path,
        focus: false,
        id: path,
        paneId,
      });
      return;
    }
    const holder = paneOfTab(existing.id);
    if (holder && holder.id !== paneId) {
      if (holder.activeTabId === existing.id) {
        return;
      }
      moveTabToPane(existing.id, paneId);
    }
    activateTab(existing.id, { focus: false });
  },
};

/** A `GitStatusResult` naming exactly `paths` as modified — what a diff lens is refused without. */
function gitStatusFor(...paths: string[]): void {
  shell.git.status = {
    ahead: 0,
    behind: 0,
    branch: "main",
    files: paths.map((path) => ({ path, status: "M" })),
    isRepo: true,
    remotes: [],
  };
}

const PLAIN_DOC = { tagName: "div" };

function open(id: string, document: Record<string, unknown> = PLAIN_DOC) {
  return openTab({ document: { ...document }, documentPath: id, id });
}

/**
 * Two panes: the primary holding `page`, the secondary holding a scratch document of its own.
 *
 * The side pane HAS to hold something, because §18.1 rule 3 removes a pane with no subject — which
 * is exactly the rule a lens changes, and a fixture that stood the pane up by hand would be testing
 * a state the app cannot reach.
 */
function twoPanes(): Tab {
  const page = open("pages/index.json", {
    children: [{ children: [{ tagName: "p" }], tagName: "my-card" }, { tagName: "footer" }],
    tagName: "div",
  });
  open("pages/other.json");
  expect(splitRight()?.id).toBe(SECONDARY_PANE);
  focusPane(PRIMARY_PANE);
  return page;
}

/** A lens on the secondary pane, deriving from the primary. */
function lensOn(preset: "code" | "diff" | "breakpoint", media: string | null = null) {
  const derivation: Extract<PaneDerivation, { kind: "lens" }> = {
    diff:
      preset === "diff"
        ? { currentContent: "", filePath: "x", fileStatus: "M", originalContent: "" }
        : null,
    kind: "lens",
    media,
    mode: preset === "code" ? "source" : preset === "diff" ? "git-diff" : "design",
    preset,
    reason: "",
    sourcePaneId: PRIMARY_PANE,
    status: "loading",
    zoom: 1,
  };
  setPaneDerivation(SECONDARY_PANE, derivation);
  return derivation;
}

/** A companion on the secondary pane, deriving from the primary. */
function companionOn(preset: "layout" | "component") {
  const derivation: PaneDerivation = {
    kind: "companion",
    preset,
    reason: "",
    resolved: null,
    sourcePaneId: PRIMARY_PANE,
    status: "loading",
  };
  setPaneDerivation(SECONDARY_PANE, derivation);
  return derivation;
}

/** A locale companion on the secondary pane, holding `locale` and deriving from the primary. */
function localeCompanionOn(locale: string | null) {
  const derivation: PaneDerivation = {
    kind: "companion",
    locale,
    preset: "locale",
    reason: "",
    resolved: null,
    sourcePaneId: PRIMARY_PANE,
    status: "loading",
  };
  setPaneDerivation(SECONDARY_PANE, derivation);
  return derivation;
}

/** A project declaring `tags`, default first — the shape `resolveI18n` answers for. */
function multilingual(...tags: string[]): void {
  resetStudioState({
    projectConfig: { i18n: { defaultLocale: tags[0], locales: tags } },
  });
}

let scope: EffectScope | null = null;

beforeEach(() => {
  opened.length = 0;
  diffsAsked.length = 0;
  existsAsked.length = 0;
  filesOnDisk.clear();
  nextDiff = null;
  resetStudioState();
  resetCanvasPerf();
  componentRegistry.length = 0;
  shell.git.diffState = null;
  shell.git.status = null;
  shell.layoutSelection = null;
});

afterEach(() => {
  scope?.stop();
  scope = null;
  closeAllTabs();
  componentRegistry.length = 0;
  shell.git.diffState = null;
  shell.git.status = null;
  shell.layoutSelection = null;
});

// ─── The five invariants ──────────────────────────────────────────────────────

describe("the invariants, asserted and never repaired", () => {
  test("D1 · a derivation names another pane that is in the grid", () => {
    twoPanes();
    expect(() => setPaneDerivation(SECONDARY_PANE, lensRecord(SECONDARY_PANE))).toThrow(RangeError);
    expect(() => setPaneDerivation(SECONDARY_PANE, lensRecord("no-such-pane"))).toThrow(RangeError);
    expect(derivationOfPane(SECONDARY_PANE)).toBeNull();
  });

  test("D2 · a lens pane owns no tab, and `applyDerivation` hands back anything it has", () => {
    const page = twoPanes();
    lensOn("code");

    applyDerivation(SECONDARY_PANE, deps);

    expect(workspace.panes[1]!.tabOrder).toEqual([]);
    expect(workspace.panes[1]!.activeTabId).toBeNull();
    // The scratch document is not closed and is not ORPHANED — it went back to the primary.
    expect(workspace.tabs.has("pages/other.json")).toBe(true);
    expect(workspace.panes[0]!.tabOrder).toContain("pages/other.json");
    // And the lens draws the source pane's document, through `tabOfPane`'s one hop.
    expect(tabOfPane(SECONDARY_PANE)?.id).toBe(page.id);
  });

  test("D3 · a tab id is in at most one pane's tabOrder, lens or not", () => {
    twoPanes();
    lensOn("code");
    applyDerivation(SECONDARY_PANE, deps);
    const seen = new Set<string>();
    for (const pane of workspace.panes) {
      for (const id of pane.tabOrder) {
        expect(seen.has(id)).toBe(false);
        seen.add(id);
      }
    }
  });

  test("D4 · closing the source pane clears the survivor's derivation", () => {
    twoPanes();
    // Mintable in this direction too: derive from the SECONDARY, and the primary is the lens.
    setPaneDerivation(PRIMARY_PANE, lensRecord(SECONDARY_PANE));
    closePane(SECONDARY_PANE);
    expect(workspace.panes.map((p) => p.id)).toEqual([PRIMARY_PANE]);
    // Without D4 the survivor would name a pane that is not in the grid: `tabOfPane` answers null
    // And the one remaining stage draws a document that has no pane.
    expect(derivationOfPane(PRIMARY_PANE)).toBeNull();
  });

  test("D5 · only setPaneDerivation / clearPaneDerivation write it", () => {
    twoPanes();
    lensOn("breakpoint", "md");
    expect(derivationOfPane(SECONDARY_PANE)?.kind).toBe("lens");
    clearPaneDerivation(SECONDARY_PANE);
    expect(derivationOfPane(SECONDARY_PANE)).toBeNull();
    // Clearing a pane that is not there is a no-op, not a throw: a stale layout must not strand.
    expect(() => clearPaneDerivation("no-such-pane")).not.toThrow();
  });
});

function lensRecord(sourcePaneId: string): PaneDerivation {
  return {
    diff: null,
    kind: "lens",
    media: null,
    mode: "source",
    preset: "code",
    reason: "",
    sourcePaneId,
    status: "loading",
    zoom: 1,
  };
}

// ─── derivedTarget is pure ────────────────────────────────────────────────────

describe("derivedTarget answers each preset, and writes nothing", () => {
  test("null for a pane that is not derived", () => {
    twoPanes();
    expect(derivedTarget(SECONDARY_PANE)).toBeNull();
    expect(derivedTarget("no-such-pane")).toBeNull();
  });

  test("a lens is ready, and carries the mode and media the pane draws in", () => {
    twoPanes();
    lensOn("code");
    expect(derivedTarget(SECONDARY_PANE)).toEqual({
      diffPath: null,
      kind: "lens",
      media: null,
      mode: "source",
      path: null,
      probePath: null,
      reason: "",
      select: null,
      status: "ready",
    });
  });

  test("a breakpoint lens naming a media the document does not declare is unavailable", () => {
    twoPanes();
    lensOn("breakpoint", "xxl");
    const target = derivedTarget(SECONDARY_PANE)!;
    expect(target.status).toBe("unavailable");
    expect(target.reason).toContain("xxl");
  });

  test("a diff lens on a file with no changes against HEAD is unavailable, and says so", () => {
    twoPanes();
    const derivation = lensOn("diff");
    derivation.diff = null;
    expect(derivedTarget(SECONDARY_PANE)).toMatchObject({
      reason: "Nothing to compare — this file matches HEAD.",
      status: "unavailable",
    });
  });

  /* FINDING 4. The lens rendered a frozen snapshot of whatever the Git panel last opened.
     `derivationFor` copied `shell.git.diffState` — an app-level slot written only by a click on a
     row IN THE GIT PANEL, carrying THAT file's path — and nothing ever re-read it. So the target
     was `ready` while the pane drew a comparison of a completely different document, under a chip
     labelled with the source pane's. Each of the three assertions below fails against that code:
     the first because a stale `diff` made the target ready, the second because the target carried
     no `diffPath` to load, the third because switching the source tab changed nothing at all. */
  test("a diff lens targets the SOURCE pane's document, not the slot the Git panel wrote", () => {
    const page = twoPanes();
    const derivation = lensOn("diff");
    // The Git panel has some OTHER file's comparison on screen. That is not this pane's subject.
    derivation.diff = { filePath: "some/OTHER/file.md" } as never;
    shell.git.diffState = derivation.diff;
    gitStatusFor(page.documentPath!);

    expect(derivedTarget(SECONDARY_PANE)).toMatchObject({
      diffPath: "pages/index.json",
      reason: "",
      status: "loading",
    });

    // With the right file's comparison in hand it is ready, and asks for nothing more.
    derivation.diff = { filePath: "pages/index.json" } as never;
    expect(derivedTarget(SECONDARY_PANE)).toMatchObject({ diffPath: null, status: "ready" });

    // …and it FOLLOWS: the source pane switching tabs re-targets the comparison.
    gitStatusFor("pages/index.json", "pages/other.json");
    workspace.panes[0]!.activeTabId = "pages/other.json";
    expect(derivedTarget(SECONDARY_PANE)).toMatchObject({
      diffPath: "pages/other.json",
      status: "loading",
    });
  });

  test("a layout companion resolves the page's layout, and holds when there is none", () => {
    const page = twoPanes();
    page.doc.document.$layout = "layouts/base.json";
    expect(derivedTarget(SECONDARY_PANE)).toBeNull();
    companionOn("layout");
    expect(derivedTarget(SECONDARY_PANE)).toMatchObject({
      path: "layouts/base.json",
      status: "ready",
    });
    page.doc.document.$layout = false;
    expect(derivedTarget(SECONDARY_PANE)).toMatchObject({
      path: null,
      reason: "This page has no layout.",
      status: "unavailable",
    });
  });

  /* FINDING 2. `presetRefusal("code")` was evaluated ONCE, when the lens was made, and a lens is a
     standing view of a pane that keeps changing: one click on the source pane's Editor axis put
     both panes in Code over the same file.

       models: ["file:///pages/index.json","file:///pages/index.json"] — distinct URIs: 1 of 2

     Real Monaco throws `Cannot create model because a model with the same URI already exists`,
     inside the floating `void mountSourceEditor(…)` in `canvas/canvas-render.ts` — an unhandled
     rejection and a blank Code pane. Unreachable before derived panes, because one document could
     only be on screen once. The refusal has to be a standing answer, not a gate at creation. */
  test("a Code lens goes unavailable when the source pane starts showing Code too", () => {
    const page = twoPanes();
    lensOn("code");
    expect(derivedTarget(SECONDARY_PANE)).toMatchObject({ status: "ready" });

    page.session.ui.canvasMode = "source";

    expect(derivedTarget(SECONDARY_PANE)).toMatchObject({
      reason: "The pane this one follows is showing Code — one document has one editor.",
      status: "unavailable",
    });
    // …and back, because the author flipping the source pane to Design is the fix for it.
    page.session.ui.canvasMode = "design";
    expect(derivedTarget(SECONDARY_PANE)).toMatchObject({ status: "ready" });
  });

  test("a derivation whose source pane shows nothing is unavailable, not a crash", () => {
    twoPanes();
    lensOn("code");
    workspace.panes[0]!.activeTabId = null;
    expect(derivedTarget(SECONDARY_PANE)).toMatchObject({ status: "unavailable" });
  });

  test("it is PURE — resolving twenty times changes no state", () => {
    const page = twoPanes();
    page.doc.document.$layout = "layouts/base.json";
    const derivation = companionOn("layout");
    for (let i = 0; i < 20; i++) {
      derivedTarget(SECONDARY_PANE);
    }
    expect(derivation.resolved).toBeNull();
    expect(derivation.status).toBe("loading");
    expect(opened).toEqual([]);
  });
});

// ─── The memo — the one number that matters ──────────────────────────────────

describe("the component follow memoises on its ANSWER", () => {
  function withCard(): Tab {
    const page = twoPanes();
    componentRegistry.push({ path: "components/card.json", tagName: "my-card" } as never);
    return page;
  }

  test("typing 20 characters into the page costs ZERO retargets and ZERO opens", async () => {
    /* THE test. The follow's inputs are the source tab's identity and its selection; the document
       root is read only by the RESOLVERS, which run in the rAF where nothing is tracking — so a
       transaction, which replaces `tab.doc.document`, must not re-resolve anything. Move the
       resolution into the effect and this climbs with every keystroke. */
    const page = withCard();
    page.session.selection = [["children", 0, "children", 0]];
    companionOn("component");
    scope = effectScope();
    scope.run(() => {
      installDerivationEffects(SECONDARY_PANE, deps);
    });
    await frame();
    expect(opened).toEqual([{ paneId: SECONDARY_PANE, path: "components/card.json" }]);
    expect(canvasPerf.derivedRetargets).toBe(1);
    /* TWO resolves to land one document, and the second one is the price of the memo being able to
       expire. The follow observes THIS pane's `activeTabId` so that closing the companion's
       document re-asks the question; the open that lands the document changes that field, so the
       effect runs once more and the next frame re-resolves — to the same answer, which the memo
       makes free. It is per open, not per keystroke, which is the whole claim below. */
    await frame();
    const settled = canvasPerf.derivedResolves;
    expect(settled).toBe(2);

    for (let i = 0; i < 20; i++) {
      transactDoc(page, (t) => mutateUpdateProperty(t, ["children", 1], "textContent", `x${i}`));
      // A frame per keystroke, because the rAF hop DEDUPES: batching them would hide twenty
      // Re-resolutions behind one frame and the assertion below could not fail.
      await frame();
    }

    /* Not one more open, and — the claim that actually costs something — not one more RESOLVE.
       Measured against the natural mistake: resolving INSIDE the effect (`void derivedTarget(paneId)`
       beside the selection read) makes this 21, because `transactDoc` replaces the document root,
       the resolver reads it, and the effect therefore re-runs on every character. Keeping the
       resolution in the rAF callback is what makes a pane an author leaves open all day free —
       tracking is a property of WHERE a read happens, and there is no active effect there. */
    expect(canvasPerf.derivedRetargets).toBe(1);
    expect(canvasPerf.derivedResolves).toBe(settled);
    expect(opened).toHaveLength(1);
    console.log(
      `[pane-derive] 20 keystrokes with a component follow live: ` +
        `${canvasPerf.derivedResolves} resolve(s), ${canvasPerf.derivedRetargets} retarget(s), ` +
        `${opened.length} open(s)`,
    );
  });

  test("moving the selection WITHIN one component instance costs zero retargets", async () => {
    const page = withCard();
    page.session.selection = [["children", 0]];
    companionOn("component");
    scope = effectScope();
    scope.run(() => {
      installDerivationEffects(SECONDARY_PANE, deps);
    });
    await frame();
    expect(canvasPerf.derivedRetargets).toBe(1);

    // The paragraph INSIDE the card, then the card again, then the paragraph — one definition.
    for (const path of [
      ["children", 0, "children", 0],
      ["children", 0],
      ["children", 0, "children", 0],
    ]) {
      page.session.selection = [path];
      await frame();
    }
    expect(canvasPerf.derivedRetargets).toBe(1);
    expect(opened).toHaveLength(1);
  });

  /* The follow's ONE tracked input for this preset. Every other test here either resolves to the
     same answer (so a dead subscription is invisible) or calls `derivedTarget` by hand (so it never
     goes through the effect at all) — which is how `void source?.session.selection` could be
     deleted with the suite still green and the component companion reduced to a static pane
     wearing a follow's chip. This is the transition that needs the subscription: nothing resolved,
     then a click inside an instance. */
  test("clicking into a component RE-POINTS the pane — the follow observes the selection", async () => {
    const page = withCard();
    // `<footer>` is inside no component, so the companion has resolved nothing yet.
    page.session.selection = [["children", 1]];
    companionOn("component");
    scope = effectScope();
    scope.run(() => {
      installDerivationEffects(SECONDARY_PANE, deps);
    });
    await frame();
    expect(opened).toEqual([]);

    page.session.selection = [["children", 0, "children", 0]];
    await frame();
    expect(opened).toEqual([{ paneId: SECONDARY_PANE, path: "components/card.json" }]);
  });

  test("a selection with no component under it HOLDS the last definition", async () => {
    const page = withCard();
    page.session.selection = [["children", 0]];
    companionOn("component");
    scope = effectScope();
    scope.run(() => {
      installDerivationEffects(SECONDARY_PANE, deps);
    });
    await frame();

    // `<footer>` is not inside any component. The pane keeps the card rather than blanking, which
    // Is the difference between a pane you leave open and one that flickers as you work.
    page.session.selection = [["children", 1]];
    await frame();
    expect(derivedTarget(SECONDARY_PANE)).toMatchObject({ path: null, status: "ready" });
    expect(derivationOfPane(SECONDARY_PANE)).toMatchObject({ resolved: "components/card.json" });
    expect(opened).toHaveLength(1);
  });

  test("componentPathUnderSelection walks UP to the nearest instance", () => {
    const page = withCard();
    expect(componentPathUnderSelection(null)).toBeNull();
    page.session.selection = [];
    expect(componentPathUnderSelection(page)).toBeNull();
    page.session.selection = [["children", 0, "children", 0]];
    expect(componentPathUnderSelection(page)).toBe("components/card.json");
    page.session.selection = [["children", 1]];
    expect(componentPathUnderSelection(page)).toBeNull();
  });

  test("with nothing resolved yet and no component under the cursor, it says what to click", () => {
    const page = twoPanes();
    componentRegistry.push({ path: "components/card.json", tagName: "my-card" } as never);
    page.session.selection = [["children", 1]];
    companionOn("component");
    expect(derivedTarget(SECONDARY_PANE)).toMatchObject({
      path: null,
      reason: "Select an element inside a component to see its definition.",
      status: "unavailable",
    });
  });

  test("the retarget is scheduled ONCE per frame however many times the follow fires", async () => {
    const page = withCard();
    page.session.selection = [["children", 0]];
    companionOn("component");
    scope = effectScope();
    scope.run(() => {
      installDerivationEffects(SECONDARY_PANE, deps);
    });
    // Three selection moves inside one frame. The rAF dedupe is what stops an effect that writes
    // `pane.tabOrder` from re-entering itself — `panels/pane-grid.ts` names the same hazard.
    page.session.selection = [["children", 0, "children", 0]];
    page.session.selection = [["children", 0]];
    await frame();
    expect(canvasPerf.derivedResolves).toBe(1);
  });

  /* The other half of FINDING 2, and the half a refusal alone does not buy. `lensTarget` answers
     "unavailable" while the source pane is showing Code — but an answer nothing asks for is not an
     answer, and the follow's tracked inputs were the source pane's TAB and (for one preset) its
     selection. A mode flip touches neither, so `derived.status` stayed `ready` and the stage went
     on mounting a second Monaco model on the source pane's URI until something unrelated
     re-resolved. */
  test("a Code lens notices the source pane switching to Code — the follow observes the mode", async () => {
    const page = twoPanes();
    lensOn("code");
    scope = effectScope();
    scope.run(() => {
      installDerivationEffects(SECONDARY_PANE, deps);
    });
    await frame();
    expect(derivationOfPane(SECONDARY_PANE)?.status).toBe("ready");
    /* A settling frame. Invariant D2 hands this pane's tab back to the source pane on the first
       resolve, and that write is one of the follow's tracked inputs — so a retarget is already
       queued, and asserting on the next frame would let it pick the mode flip up whatever the
       effect subscribes to. */
    await frame();

    // One click on the source pane's Editor axis.
    page.session.ui.canvasMode = "source";
    await frame();

    expect(derivationOfPane(SECONDARY_PANE)).toMatchObject({
      reason: "The pane this one follows is showing Code — one document has one editor.",
      status: "unavailable",
    });
  });

  test("a throwing opener is reported, not swallowed, and the frame is released", async () => {
    const page = withCard();
    page.session.selection = [["children", 0]];
    companionOn("component");
    scope = effectScope();
    scope.run(() => {
      installDerivationEffects(SECONDARY_PANE, {
        fileExists: async () => false,
        loadDiff: async () => null,
        openFileInPane: () => {
          throw new Error("boom");
        },
      });
    });
    await frame();
    // The next follow still schedules: a rAF id left behind would wedge the pane permanently.
    page.session.selection = [["children", 1]];
    await frame();
    expect(derivationOfPane(SECONDARY_PANE)).not.toBeNull();
  });
});

// ─── applyDerivation is idempotent ────────────────────────────────────────────

describe("applyDerivation", () => {
  test("is idempotent — running it three times opens the document once", () => {
    const page = twoPanes();
    page.doc.document.$layout = "layouts/base.json";
    companionOn("layout");
    applyDerivation(SECONDARY_PANE, deps);
    applyDerivation(SECONDARY_PANE, deps);
    applyDerivation(SECONDARY_PANE, deps);
    expect(opened).toEqual([{ paneId: SECONDARY_PANE, path: "layouts/base.json" }]);
    expect(canvasPerf.derivedRetargets).toBe(1);
  });

  /* A resolved companion owns a REAL tab, so its strip draws real chips with real ✕s — and closing
     the one it opened stranded the pane. `paneIsEmpty` counts the derivation as a subject, so the
     pane stayed; `derived.resolved` still named the file that had just gone, so every following
     frame found `target.path === derived.resolved` and did nothing; and the stage said "Looking
     for something to show here…" for the rest of the session over a page whose layout was still
     declared and still on disk. Unsplit was the only way out.

     Invisible until this file's `openFileInPane` started opening a document: a fake that only
     records makes "the pane is showing what it resolved" a question nothing can ask. */
  test("closing a companion's document lets the follow open it again", () => {
    const page = twoPanes();
    page.doc.document.$layout = "layouts/base.json";
    companionOn("layout");
    /* `pane.derive` hands the side pane's existing tabs back to the pane the author is in before
       it publishes the derivation — a derivation is a layout action and closes nothing — so a
       companion pane holds exactly the one document its rule opened. Closing it is closing all of
       them, which is the state under test. */
    closeTab("pages/other.json");
    applyDerivation(SECONDARY_PANE, deps);
    expect(tabOfPane(SECONDARY_PANE)?.documentPath).toBe("layouts/base.json");
    expect(opened).toHaveLength(1);

    closeTab("layouts/base.json");
    // The pane survives — a derivation is a subject — and it is showing nothing at all.
    expect(workspace.panes.map((p) => p.id)).toEqual([PRIMARY_PANE, SECONDARY_PANE]);
    expect(tabOfPane(SECONDARY_PANE)).toBeNull();

    applyDerivation(SECONDARY_PANE, deps);

    expect(opened).toHaveLength(2);
    expect(tabOfPane(SECONDARY_PANE)?.documentPath).toBe("layouts/base.json");
  });

  /* …AND SOMETHING HAS TO CALL IT. The test above drives `applyDerivation` by hand, which proves a
     function; the fix is a claim about the app, and the app has to run the function for the claim
     to be true. It did not. The follow's tracked inputs were the SOURCE pane's tab, the selection
     and the layout hit — and a `closeTab` in the FOLLOWING pane touches none of them, so with the
     real effect installed and the real gesture performed:

       resolved: secondary[layouts/base.json]@layouts/base.json*
       closeTab("layouts/base.json") → applyDerivation ran 0 more times
       → secondary[]@-*  derived still {"kind":"companion","resolved":"layouts/base.json"}

     A comment describing a path the code never takes is the fourth of its kind in this package, so
     the assertion here is deliberately about the GESTURE — close the tab, wait a frame, and the
     pane is showing the document again — with nothing driven by hand. */
  test("the follow NOTICES the close: the pane's own tab is a tracked input", async () => {
    const page = twoPanes();
    page.doc.document.$layout = "layouts/base.json";
    /* The derivation FIRST: `paneIsEmpty` counts it as a subject, and without one closing the side
       pane's last tab collapses the pane this test is about. Same order `pane.derive`'s `run`
       uses, and for the same reason. */
    companionOn("layout");
    closeTab("pages/other.json");
    scope = effectScope();
    scope.run(() => {
      installDerivationEffects(SECONDARY_PANE, deps);
    });
    await frame();
    await frame();
    expect(tabOfPane(SECONDARY_PANE)?.documentPath).toBe("layouts/base.json");
    expect(opened).toHaveLength(1);

    closeTab("layouts/base.json");
    expect(tabOfPane(SECONDARY_PANE)).toBeNull();
    await frame();

    expect(opened).toHaveLength(2);
    expect(tabOfPane(SECONDARY_PANE)?.documentPath).toBe("layouts/base.json");
    expect(derivationOfPane(SECONDARY_PANE)).toMatchObject({ resolved: "layouts/base.json" });
  });

  /* THE DOCSTRING'S CENTRAL CLAIM, and nothing asserted it. `installDerivationEffects` reads
     `tabOfPane(derived.sourcePaneId)` — the SOURCE pane's `activeTabId` — and every sentence about
     a projection "following the pane it derives from" rests on that one line. A LENS survives its
     loss because `tabOfPane` hops through `sourcePaneId` anyway, so its stage repaints regardless;
     a COMPANION does not. Point the read at this pane instead (`tabOfPane(paneId)`, which for a
     companion answers its OWN tab) and every existing test still passes, because each of them
     either installs no follow, or changes a field on the tab the follow already has, or switches
     tabs with the resolver driven by hand. This is the gesture none of them make: the author
     switches document in the pane they are working in, and the pane beside it must follow. */
  test("a companion re-resolves when the SOURCE pane switches document", async () => {
    const page = twoPanes();
    page.doc.document.$layout = "layouts/base.json";
    const second = open("pages/second.json");
    second.doc.document.$layout = "layouts/marketing.json";
    // Both live in the PRIMARY; the author is looking at the first one.
    expect(paneOfTab("pages/second.json")?.id).toBe(PRIMARY_PANE);
    activateTab("pages/index.json");
    companionOn("layout");
    scope = effectScope();
    scope.run(() => {
      installDerivationEffects(SECONDARY_PANE, deps);
    });
    await frame();
    await frame();
    expect(opened).toEqual([{ paneId: SECONDARY_PANE, path: "layouts/base.json" }]);

    // The one gesture: a tab switch in the pane this one is a projection OF.
    activateTab("pages/second.json");
    await frame();

    expect(opened).toEqual([
      { paneId: SECONDARY_PANE, path: "layouts/base.json" },
      { paneId: SECONDARY_PANE, path: "layouts/marketing.json" },
    ]);
    expect(tabOfPane(SECONDARY_PANE)?.documentPath).toBe("layouts/marketing.json");
  });

  /* The selection lands AFTER the open, and the fixture is why nothing could tell. The real
     `openFileInPane` is `async` — it reads a file — while this file's fake is synchronous, so
     selecting BEFORE the open still found the document already on screen and both orders passed.
     A fake that resolves on a later microtask is the shape the app has, and under it the wrong
     order writes the selection into whatever the pane was showing a moment ago (where
     {@link selectInPane}'s path guard drops it) and never into the document that arrives. */
  test("the selection lands AFTER the open, not before it — the opener is async", async () => {
    const page = twoPanes();
    page.doc.document.$layout = "layouts/base.json";
    shell.layoutSelection = {
      className: "",
      layoutFile: "layouts/base.json",
      layoutPath: ["children", 0],
      rect: {} as never,
      tagName: "header",
    };
    companionOn("layout");
    const async_: DerivationDeps = {
      ...deps,
      openFileInPane: (paneId, path) =>
        Promise.resolve().then(() => {
          // The point of this stub: the open lands a microtask LATE, so the assertion below
          // `applyDerivation` can see the pane before it has arrived.
          void deps.openFileInPane(paneId, path);
        }),
    };

    applyDerivation(SECONDARY_PANE, async_);
    // Nothing has arrived yet: the pane is still showing the document it already had.
    expect(tabOfPane(SECONDARY_PANE)?.documentPath).toBe("pages/other.json");
    for (let i = 0; i < 4; i++) {
      await Promise.resolve();
    }

    const landed = tabOfPane(SECONDARY_PANE)!;
    expect(landed.documentPath).toBe("layouts/base.json");
    expect(toRaw(landed.session.selection)).toEqual([["children", 0]]);
  });

  test("the no-op dependency set really does nothing, and satisfies the interface", async () => {
    /* `commands/app-commands.ts` builds every record in the app to READ it — the level check, the
       chrome budget and the shot contract all do — and hands this set over rather than stubbing a
       verb it will never call. A stub that threw, or that returned a non-promise, would fail those
       three checks in a bare Bun process with no DOM and a stack that names none of this. */
    const noop = noopDerivationDeps();
    expect(noop.openFileInPane(SECONDARY_PANE, "pages/index.json")).toBeUndefined();
    // oxlint-disable-next-line typescript/await-thenable -- Bun types the matcher `void`; it returns a real Promise and the await is load-bearing.
    await expect(noop.loadDiff("pages/index.json", "M")).resolves.toBeNull();
  });

  test("does nothing at all for a pane that is not derived", () => {
    twoPanes();
    applyDerivation(SECONDARY_PANE, deps);
    applyDerivation("no-such-pane", deps);
    expect(opened).toEqual([]);
  });

  test("records the status and reason the pane draws", () => {
    twoPanes();
    const derivation = lensOn("breakpoint", "xxl");
    applyDerivation(SECONDARY_PANE, deps);
    expect(derivation.status).toBe("unavailable");
    expect(derivation.reason).toContain("xxl");
  });

  /* FINDING 4, the impure half: the lens LOADS its own comparison, once, for the document the
     source pane is showing — and re-loads when that changes. */
  test("a diff lens loads the source document's comparison, once, and re-loads on a tab switch", async () => {
    twoPanes();
    gitStatusFor("pages/index.json", "pages/other.json");
    nextDiff = { currentContent: "b", fileStatus: "M", originalContent: "a" } as GitDiffState;
    const derivation = lensOn("diff");
    derivation.diff = null;

    applyDerivation(SECONDARY_PANE, deps);
    // A SECOND frame before the first read has landed asks for nothing more. Without the in-flight
    // Key every frame of the follow issues another `gitShow`, and the follow runs on every frame.
    applyDerivation(SECONDARY_PANE, deps);
    expect(diffsAsked).toEqual([{ fileStatus: "M", path: "pages/index.json" }]);
    expect(derivation.status).toBe("loading");
    await Promise.resolve();
    await Promise.resolve();
    const loaded = derivationOfPane(SECONDARY_PANE);
    expect(loaded).toMatchObject({ status: "ready" });
    expect(loaded?.kind === "lens" ? loaded.diff?.filePath : null).toBe("pages/index.json");

    // Idempotent: a second frame with the same document asks for nothing.
    applyDerivation(SECONDARY_PANE, deps);
    expect(diffsAsked).toHaveLength(1);

    // The source pane switches tabs and the lens follows — a NEW comparison, not the stale one.
    workspace.panes[0]!.activeTabId = "pages/other.json";
    applyDerivation(SECONDARY_PANE, deps);
    expect(diffsAsked).toEqual([
      { fileStatus: "M", path: "pages/index.json" },
      { fileStatus: "M", path: "pages/other.json" },
    ]);
  });

  test("the working tree moving re-issues the read, so the comparison cannot go stale", async () => {
    /* "Once per path" was a cache with no invalidation: a lens asked when it opened and never
       again, so it went on showing the comparison it read then for as long as it stayed open. That
       was invisible while the artboards merely drew two documents; with change marks on them, the
       tint and the count lie about a file the author is editing while they look at it.
       `shell.git.rev` is the other half of the key — bumped by every save and by every refresh
       that follows a commit, discard, checkout or pull. */
    twoPanes();
    gitStatusFor("pages/index.json");
    nextDiff = { currentContent: "b", fileStatus: "M", originalContent: "a" } as GitDiffState;
    const derivation = lensOn("diff");
    derivation.diff = null;

    applyDerivation(SECONDARY_PANE, deps);
    await Promise.resolve();
    await Promise.resolve();
    expect(diffsAsked).toHaveLength(1);

    // Still idempotent while nothing has moved.
    applyDerivation(SECONDARY_PANE, deps);
    expect(diffsAsked).toHaveLength(1);

    shell.git.rev += 1;
    applyDerivation(SECONDARY_PANE, deps);
    expect(diffsAsked).toEqual([
      { fileStatus: "M", path: "pages/index.json" },
      { fileStatus: "M", path: "pages/index.json" },
    ]);
  });

  /* FINDING 1, and it is round one's finding 4 still live behind a comment claiming it was fixed.
     `derivedTarget` learned to TARGET the source document; nothing ever cleared the comparison the
     lens was holding, and `canvas/canvas-render.ts`'s `if (!gitDiffState)` reads that field. So the
     stage went on drawing another file's comparison — with the notice, the loading state and the
     "unavailable" sentence all sitting behind a branch that could not be reached.

       after a source-tab switch: derivation unavailable, stage still draws pages/index.json's diff
       a brand-new lens, first paint: " Original SOMEBODY-ELSE-OLD Current SOMEBODY-ELSE-NEW " */
  test("a comparison that is not this document's is CLEARED, so the stage can say so", () => {
    twoPanes();
    gitStatusFor("pages/index.json", "pages/other.json");
    const derivation = lensOn("diff");
    derivation.diff = { filePath: "pages/index.json" } as never;
    applyDerivation(SECONDARY_PANE, deps);
    // The right file's comparison in hand: nothing to clear, nothing to fetch.
    expect(derivation.diff).not.toBeNull();
    expect(derivation.status).toBe("ready");

    // The source pane switches document. What this lens is holding is now somebody else's file.
    workspace.panes[0]!.activeTabId = "pages/other.json";
    applyDerivation(SECONDARY_PANE, deps);
    expect(derivation.diff).toBeNull();
    expect(derivation.status).toBe("loading");

    // …and so is a source document with no changes at all: there is nothing to draw, and the pane
    // Must not draw the last thing it happened to have.
    derivation.diff = { filePath: "pages/other.json" } as never;
    shell.git.status = {
      ahead: 0,
      behind: 0,
      branch: "main",
      files: [],
      isRepo: true,
      remotes: [],
    };
    applyDerivation(SECONDARY_PANE, deps);
    expect(derivation.diff).toBeNull();
    expect(derivation.reason).toBe("Nothing to compare — this file matches HEAD.");
  });

  /* A LATE ANSWER TO A QUESTION NOBODY IS ASKING ANY MORE. `loadDiffFor`'s continuation runs a
     microtask-turn after the pane may have moved on, so it re-checks three things before writing:
     the pane still derives, it is still a diff lens, and — the one nothing could tell right from
     wrong about — the path it asked for is still the path the pane wants.

     The observable half is the FAILED read, and it took a while to find because a successful late
     answer self-heals: it writes the old file's comparison, and the very next resolve clears a
     comparison that is not the source document's. A failure writes `_diffLoads` instead, which is
     the pane's ONE in-flight slot — so a late `null` for `pages/index.json` overwrites the record
     of the `pages/other.json` request that is still outstanding, and the next frame, finding no
     in-flight load for the document it wants, asks for the same comparison a second time. Every
     frame after it does the same. */
  test("a read that FAILS after the source moved on does not evict the live request", async () => {
    twoPanes();
    gitStatusFor("pages/index.json", "pages/other.json");
    const releases: ((state: GitDiffState | null) => void)[] = [];
    const slow: DerivationDeps = {
      ...deps,
      loadDiff: (path, fileStatus) => {
        diffsAsked.push({ fileStatus, path });
        return new Promise<GitDiffState | null>((resolve) => {
          releases.push(resolve);
        });
      },
    };
    const derivation = lensOn("diff");
    derivation.diff = null;

    applyDerivation(SECONDARY_PANE, slow);
    expect(diffsAsked).toEqual([{ fileStatus: "M", path: "pages/index.json" }]);

    // The author switches tabs in the source pane while the read is still in flight. The lens is
    // Now about a different document, and asks for that one.
    workspace.panes[0]!.activeTabId = "pages/other.json";
    applyDerivation(SECONDARY_PANE, slow);
    expect(diffsAsked).toHaveLength(2);

    // The FIRST read comes back empty, for a file this pane is no longer about.
    releases[0]!(null);
    await Promise.resolve();
    await Promise.resolve();

    // The live request is untouched, so ten more frames add nothing…
    for (let i = 0; i < 10; i++) {
      applyDerivation(SECONDARY_PANE, slow);
    }
    expect(diffsAsked).toHaveLength(2);
    // …and the pane is still waiting for its own comparison, not wearing the other file's refusal.
    expect(derivation.status).toBe("loading");
    expect(derivation.reason).toBe("");
  });

  /* …AND THE PANE ITSELF GOING AWAY IS THE CASE THE SHAPE GUARD IS FOR. Dropping the derivation
     is caught one line lower, by the `_diffLoads` path check: `writeDerivation` forgets the pane's
     in-flight answer, so the landing read finds no request of its own and returns. CLOSING THE
     PANE does not go through that writer — `closePane` removes the record and `_diffLoads` is a
     module map keyed by pane id, so the request is still on file — and the only thing standing
     between the resolver and `live.diff = state` on `undefined` is `live?.kind !== "lens" ||
     live.preset !== "diff"`. Without it the author's ✕ on a loading Diff lens produces a
     `TypeError` in the `.catch`, reported as a git failure they never caused. Nothing is written
     either way, so the console is half the assertion. */
  test("a load that lands after the pane was CLOSED writes nothing, and says nothing", async () => {
    twoPanes();
    gitStatusFor("pages/index.json");
    nextDiff = { currentContent: "b", fileStatus: "M", originalContent: "a" } as GitDiffState;
    lensOn("diff").diff = null;
    const logged: unknown[] = [];
    const console_ = console.error;
    console.error = (...args: unknown[]) => logged.push(args[0]);
    try {
      applyDerivation(SECONDARY_PANE, deps);
      expect(diffsAsked).toHaveLength(1);

      // The ✕ on the lens's own chip, pressed while the comparison was still being read.
      closePane(SECONDARY_PANE);
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      console.error = console_;
    }
    expect(workspace.panes.map((pane) => pane.id)).toEqual([PRIMARY_PANE]);
    expect(logged).toEqual([]);
  });

  test("a load that lands after the pane stopped deriving writes nothing", async () => {
    twoPanes();
    gitStatusFor("pages/index.json");
    nextDiff = { currentContent: "b", fileStatus: "M", originalContent: "a" } as GitDiffState;
    const derivation = lensOn("diff");
    derivation.diff = null;
    applyDerivation(SECONDARY_PANE, deps);

    // The author closed the lens while the read was in flight. A resolver that wrote anyway would
    // Be reviving a derivation the pane no longer has.
    clearPaneDerivation(SECONDARY_PANE);
    await Promise.resolve();
    await Promise.resolve();
    expect(derivationOfPane(SECONDARY_PANE)).toBeNull();
  });

  test("a REJECTED read is reported, not swallowed", async () => {
    twoPanes();
    gitStatusFor("pages/index.json");
    const logged: unknown[] = [];
    const console_ = console.error;
    console.error = (...args: unknown[]) => logged.push(args[0]);
    try {
      lensOn("diff");
      applyDerivation(SECONDARY_PANE, {
        fileExists: async () => false,
        loadDiff: () => Promise.reject(new Error("git exploded")),
        openFileInPane: () => {},
      });
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      console.error = console_;
    }
    expect(logged).toContain("loadDiff error:");
  });

  test("a comparison that cannot be read is SAID, not retried forever", async () => {
    twoPanes();
    gitStatusFor("pages/index.json");
    nextDiff = null;
    const derivation = lensOn("diff");

    applyDerivation(SECONDARY_PANE, deps);
    await Promise.resolve();
    await Promise.resolve();
    expect(derivation.status).toBe("unavailable");
    expect(derivation.reason).toBe("Could not read this file's comparison against HEAD.");

    // Ten more frames ask for nothing: a failed load is an answer, not a reason to spin.
    for (let i = 0; i < 10; i++) {
      applyDerivation(SECONDARY_PANE, deps);
    }
    expect(diffsAsked).toHaveLength(1);
    /* …and it STILL SAYS SO. The refusal used to be written straight onto `derived.status`, where
       the very next resolve overwrote it with `loading` — so the pane asked for nothing and said
       "Loading this file's changes…" for the rest of the session. Ten frames later is exactly
       where that showed up, and the assertion above walked past it. */
    expect(derivation.status).toBe("unavailable");
    expect(derivation.reason).toBe("Could not read this file's comparison against HEAD.");
  });

  /* FINDING 8. `panels/properties-panel.ts:570` claimed "the selection is carried by the derivation
     instead", and nothing carried it: `layoutPath` had no consumer outside the canvas hit test,
     `derivationFor("layout")` stored `{resolved: null}`, and `applyDerivation` called
     `openFileInPane` with no selection at all. The regression the deleted `openLayoutAtNode`
     existed to prevent — dropped into a layout file with nothing selected, left to find the header
     again by eye — was back, and the comment denied it.

     The secondary half is here too: the old code opened `selection.layoutFile`, the file the
     clicked chrome came FROM, while the new path resolved the page's own `$layout` — a different
     answer for a nested chain. */
  test("Open Layout → opens the file the clicked chrome came from, at the node that was clicked", async () => {
    const page = twoPanes();
    // The page's own layout is `base`; the header the author clicked came from `marketing`, which
    // `base` wraps. They are different files, and the author meant the one they clicked.
    page.doc.document.$layout = "layouts/base.json";
    shell.layoutSelection = {
      className: "site-header",
      layoutFile: "layouts/marketing.json",
      layoutPath: ["children", 0, "children", 2],
      rect: { height: 0, left: 0, top: 0, width: 0 } as never,
      tagName: "header",
    };
    companionOn("layout");

    const target = derivedTarget(SECONDARY_PANE)!;
    expect(target).toMatchObject({ path: "layouts/marketing.json", status: "ready" });
    expect(toRaw(target.select ?? [])).toEqual(["children", 0, "children", 2]);

    applyDerivation(SECONDARY_PANE, deps);
    expect(opened).toEqual([{ paneId: SECONDARY_PANE, path: "layouts/marketing.json" }]);

    // The open is what puts a tab in the pane; the selection lands on the far side of it.
    const layoutTab = workspace.tabs.get("layouts/marketing.json")!;
    expect(tabOfPane(SECONDARY_PANE)).toBe(layoutTab);
    await Promise.resolve();
    await Promise.resolve();
    expect(toRaw(layoutTab.session.selection)).toEqual([["children", 0, "children", 2]]);
  });

  test("clicking a SECOND element of the same layout moves the selection without re-opening", async () => {
    const page = twoPanes();
    page.doc.document.$layout = "layouts/base.json";
    shell.layoutSelection = {
      className: "",
      layoutFile: "layouts/base.json",
      layoutPath: ["children", 0],
      rect: {} as never,
      tagName: "header",
    };
    companionOn("layout");
    applyDerivation(SECONDARY_PANE, deps);
    const layoutTab = workspace.tabs.get("layouts/base.json")!;
    await Promise.resolve();
    await Promise.resolve();
    expect(toRaw(layoutTab.session.selection)).toEqual([["children", 0]]);

    shell.layoutSelection = {
      className: "",
      layoutFile: "layouts/base.json",
      layoutPath: ["children", 1],
      rect: {} as never,
      tagName: "footer",
    };
    applyDerivation(SECONDARY_PANE, deps);
    expect(toRaw(layoutTab.session.selection)).toEqual([["children", 1]]);
    // One open, not two — the memo is on the PATH and the path did not change.
    expect(opened).toHaveLength(1);

    /* …and the write is guarded: re-running with the same answer must not touch
       `session.selection`, which is a reactive write that repaints the Inspector, the overlays and
       the block bar on every frame the follow fires. */
    const before = layoutTab.session.selection;
    applyDerivation(SECONDARY_PANE, deps);
    expect(layoutTab.session.selection).toBe(before);
  });

  test("the layout follow OBSERVES the hit — clicking other chrome re-points the pane", async () => {
    /* Without this subscription "Open Layout →" is a one-shot: the pane opens the file the first
       click named and then sits there while the author clicks header after header. It is the one
       extra input the layout preset tracks, and it is a human gesture rather than a keystroke, so
       it costs nothing — which is the trade this test records. */
    const page = twoPanes();
    page.doc.document.$layout = "layouts/base.json";
    companionOn("layout");
    scope = effectScope();
    scope.run(() => {
      installDerivationEffects(SECONDARY_PANE, deps);
    });
    await frame();
    expect(opened).toEqual([{ paneId: SECONDARY_PANE, path: "layouts/base.json" }]);
    /* A SETTLING FRAME, and it is load-bearing. The open below writes this pane's `activeTabId`,
       which the follow observes so that closing the document re-asks the question — so a retarget
       is already queued when the test changes its input. Asserting on the next frame would let
       that pending frame pick the change up whatever the effect tracks, and the subscription this
       test is about would be unfalsifiable. */
    await frame();

    shell.layoutSelection = {
      className: "",
      layoutFile: "layouts/marketing.json",
      layoutPath: ["children", 0],
      rect: {} as never,
      tagName: "header",
    };
    await frame();
    expect(opened).toEqual([
      { paneId: SECONDARY_PANE, path: "layouts/base.json" },
      { paneId: SECONDARY_PANE, path: "layouts/marketing.json" },
    ]);
  });

  /* FINDING 4. {@link installDerivationEffects}'s docstring said the layout preset "follows the
     source tab's identity and its `$layout`", and it followed the identity only: the resolver's
     read happens inside `queueRetarget`'s rAF, where no effect is active, and an untracked read is
     not an observation. So changing a page's layout in the Inspector left the companion on the old
     file indefinitely. The pure half was right the whole time and nothing called it. */
  test("changing the page's layout MOVES the companion — the follow observes $layout", async () => {
    const page = twoPanes();
    page.doc.document.$layout = "layouts/base.json";
    companionOn("layout");
    scope = effectScope();
    scope.run(() => {
      installDerivationEffects(SECONDARY_PANE, deps);
    });
    await frame();
    expect(opened).toEqual([{ paneId: SECONDARY_PANE, path: "layouts/base.json" }]);
    // A settling frame, for the reason spelled out in the layout-hit test above: the open queues
    // A retarget of its own, and asserting before it lands makes the subscription unfalsifiable.
    await frame();

    // The Inspector's layout picker, which writes exactly this field.
    page.doc.document.$layout = "layouts/marketing.json";
    await frame();
    expect(opened).toEqual([
      { paneId: SECONDARY_PANE, path: "layouts/base.json" },
      { paneId: SECONDARY_PANE, path: "layouts/marketing.json" },
    ]);

    /* The retarget is still memoised on the ANSWER. Twenty keystrokes replace the document root
       twenty times, so this follow does re-resolve — that is the stated cost of observing a field
       on the document at all — but the expensive half, the file read, happens once per real
       change. A regression here is a pane an author leaves open all day re-reading a file on every
       character they type. */
    const opensBefore = opened.length;
    for (let i = 0; i < 20; i++) {
      transactDoc(page, (t) => mutateUpdateProperty(t, ["children", 1], "textContent", `x${i}`));
      await frame();
    }
    expect(opened).toHaveLength(opensBefore);
    expect(canvasPerf.derivedRetargets).toBe(2);
  });

  /* The selection is written into the document the derivation is ABOUT, and only that one. Without
     the path guard a layout companion whose pane the author has since moved to another document
     writes the layout's node path into whatever is on screen — a selection pointing at a node that
     document may not have, which the Inspector, the overlays and the block bar all then draw. */
  test("the selection lands only in the document the derivation resolved", async () => {
    const page = twoPanes();
    page.doc.document.$layout = "layouts/base.json";
    shell.layoutSelection = {
      className: "",
      layoutFile: "layouts/base.json",
      layoutPath: ["children", 0],
      rect: {} as never,
      tagName: "header",
    };
    companionOn("layout");
    applyDerivation(SECONDARY_PANE, deps);
    expect(opened).toEqual([{ paneId: SECONDARY_PANE, path: "layouts/base.json" }]);

    /* The pane is showing something else — a note the author opened beside the page while the
       companion's own document had not landed yet. The follow keeps running; it must not write
       here. */
    const notes = openTab({
      document: { children: [{ tagName: "p" }], tagName: "div" },
      documentPath: "notes.json",
      focus: false,
      id: "notes.json",
      paneId: SECONDARY_PANE,
    });
    await Promise.resolve();
    await Promise.resolve();
    applyDerivation(SECONDARY_PANE, deps);

    expect(tabOfPane(SECONDARY_PANE)?.id).toBe("notes.json");
    expect(toRaw(notes.session.selection)).toEqual([]);
  });

  test("with no layout hit, the companion falls back to the page's own $layout", () => {
    const page = twoPanes();
    page.doc.document.$layout = "layouts/base.json";
    companionOn("layout");
    expect(derivedTarget(SECONDARY_PANE)).toMatchObject({
      path: "layouts/base.json",
      select: null,
    });
    expect(derivedTarget(SECONDARY_PANE)?.select).toBeNull();
  });
});

// ─── Refusals ────────────────────────────────────────────────────────────────

describe("per-preset refusals are run-time, one sentence each", () => {
  test("Code is refused when the source pane is already showing Code", () => {
    const page = twoPanes();
    expect(presetRefusal("code", PRIMARY_PANE, null)).toBeNull();
    page.session.ui.canvasMode = "source";
    expect(presetRefusal("code", PRIMARY_PANE, null)).toBe(
      "a source pane that is not already showing Code",
    );
  });

  /* FINDING 4, the refusal half. It read `shell.git.diffState === null`, so the row was refused
     for a page that genuinely has changes — every page, until the author happened to click a row
     in the Git panel first — and offered the moment SOME OTHER file's diff was on screen. Both
     assertions below fail against that spelling. */
  test("Diff is refused for a file with no changes against HEAD, and offered for one that has", () => {
    twoPanes();
    // A diff of another file is loaded in the Git panel. That says nothing about THIS document.
    shell.git.diffState = { filePath: "some/OTHER/file.md" } as never;
    gitStatusFor("some/OTHER/file.md");
    expect(presetRefusal("diff", PRIMARY_PANE, null)).toBe("a file with changes against HEAD");

    // …and this page has changes, with nothing in the Git panel at all.
    shell.git.diffState = null;
    gitStatusFor("pages/index.json");
    expect(presetRefusal("diff", PRIMARY_PANE, null)).toBeNull();
  });

  test("an untracked or deleted file is refused — there is no pair of texts to compare", () => {
    twoPanes();
    shell.git.status = {
      ahead: 0,
      behind: 0,
      branch: "main",
      files: [{ path: "pages/index.json", status: "?" }],
      isRepo: true,
      remotes: [],
    };
    expect(presetRefusal("diff", PRIMARY_PANE, null)).toBe("a file with changes against HEAD");
  });

  test("a breakpoint the document does not declare is refused by name", () => {
    const page = twoPanes();
    expect(presetRefusal("breakpoint", PRIMARY_PANE, null)).toBeNull();
    expect(presetRefusal("breakpoint", PRIMARY_PANE, "md")).toContain("declares");
    page.doc.document.$media = { "--": "800px", md: "(min-width: 768px)" };
    expect(presetRefusal("breakpoint", PRIMARY_PANE, "md")).toBeNull();
  });

  /* FINDING 10. `presetRefusal` never consulted `tab.capabilities.modes` — the format's own answer
     to what a document can be shown as — so every preset was offered over every document. Over the
     Project Settings document (`["settings", "stylebook", "source"]`) the menu offered "Same page
     at Base", whose stage can only draw an empty artboard, and "Component definition", whose rule
     can never resolve because nothing in a settings form is a component instance. Both left the
     author a pane to close. */
  test("a preset is refused when the document declares no view it could draw in", () => {
    const page = twoPanes();
    page.capabilities.modes = ["settings", "stylebook", "source"];

    expect(presetRefusal("breakpoint", PRIMARY_PANE, null)).toBe(
      "a document with a Design view — this one declares none",
    );
    expect(presetRefusal("component", PRIMARY_PANE, null)).toBe(
      "a document with a Design view — this one declares none",
    );
    // Code is still offered, because this document really does declare a source view.
    expect(presetRefusal("code", PRIMARY_PANE, null)).toBeNull();

    // …and a document with no source view is refused Code, by the same rule.
    page.capabilities.modes = ["settings"];
    expect(presetRefusal("code", PRIMARY_PANE, null)).toBe(
      "a document with a Code view — this one declares none",
    );

    // A page declares both, and none of the five is refused for this reason.
    page.capabilities.modes = ["edit", "design", "preview", "source"];
    expect(presetRefusal("breakpoint", PRIMARY_PANE, null)).toBeNull();
    expect(presetRefusal("component", PRIMARY_PANE, null)).toBeNull();
  });

  test("every preset is refused when the pane has no document", () => {
    twoPanes();
    workspace.panes[0]!.activeTabId = null;
    for (const preset of DERIVE_PRESETS) {
      expect(presetRefusal(preset, PRIMARY_PANE, null)).toBe("an open document");
    }
  });

  /* FINDING 7. `presetRefusal` returned null for `layout` unconditionally, so "Layout" was offered
     on a page with no layout: `applyDerivation` returned without opening, the companion pane held a
     derivation and no tabs, `paneIsEmpty` would not collapse it, and the strip and the stage both
     drew nothing. Refused up front instead, because a page's layout is a stable fact rather than a
     rule waiting on the next click — which is exactly why `component` is still offered. */
  test("Layout is refused on a page that declares none; component is offered anyway", () => {
    const page = twoPanes();
    expect(presetRefusal("layout", PRIMARY_PANE, null)).toBe(
      "a page with a layout — this one declares none",
    );
    page.doc.document.$layout = "layouts/base.json";
    expect(presetRefusal("layout", PRIMARY_PANE, null)).toBeNull();
    /* `component` is a STANDING RULE — "select an element inside a component" resolves on the
       author's next click — so refusing it for the state it is designed to sit in would delete the
       preset. Its empty state is rendered instead; see the notice test in `lens-chrome`. */
    page.doc.document.$layout = false;
    expect(presetRefusal("component", PRIMARY_PANE, null)).toBeNull();
  });

  /* THE PROJECT'S DEFAULT IS PART OF THE GATE, and a comment on {@link MODE_FOR_PRESET} used to
     claim the opposite — "a document with no design board has no layout either", offered as the
     reason `layout` needs no declared-mode check. `getEffectiveLayoutPath` falls back to
     `projectConfig.defaults.layout`, which every starter sets, so the row IS live over a document
     that declares no Design view. That is the answer this preset gives on purpose — the companion
     opens a real layout file the author can edit, unlike the empty artboard `breakpoint` would
     draw — but it is a fact about the project rather than about the document, and a fact stated
     only in prose is the class of claim this round is retiring. */
  test("Layout's gate is the layout RESOLVING, which the project's default satisfies", () => {
    const page = twoPanes();
    // The Project Settings shape: no Design view, no `$layout` of its own.
    page.capabilities.modes = ["stylebook", "source"];
    try {
      resetStudioState();
      expect(presetRefusal("layout", PRIMARY_PANE, null)).toBe(
        "a page with a layout — this one declares none",
      );

      resetStudioState({ projectConfig: { defaults: { layout: "layouts/base.json" } } });
      expect(presetRefusal("layout", PRIMARY_PANE, null)).toBeNull();

      // …and a document that opts OUT with `$layout: false` is refused whatever the default says.
      page.doc.document.$layout = false;
      expect(presetRefusal("layout", PRIMARY_PANE, null)).toBe(
        "a page with a layout — this one declares none",
      );
    } finally {
      resetStudioState();
    }
  });
});

// ─── The pane-scoped predicates ──────────────────────────────────────────────

describe("deriveRefusal — a pure predicate OF THE PANE", () => {
  /* The `activeTabId !== null` half. `presetRefusal` answers "an open document" for the same
     state, so every preset test walked past this one — but the MENU asks `deriveRefusal` first and
     uses its answer for every row, and `pane.derive`'s `enablement` is this predicate and nothing
     else. Without the tab check the ⟲ trigger is live on the welcome screen: choosing a row calls
     `pane.derive`, whose `run` resolves `presetRefusal` and throws a `RangeError` out of a click
     handler for a pane with nothing in it. */
  test("a pane with no document cannot derive, and it is the command's own sentence", () => {
    twoPanes();
    expect(deriveRefusal(PRIMARY_PANE)).toBeNull();

    workspace.panes[0]!.activeTabId = null;
    expect(deriveRefusal(PRIMARY_PANE)).toBe(
      "an open document in a pane that is not itself derived",
    );
    // The same sentence the command's `requires` carries, so the tooltip and the refusal agree.
    const record = derivationCommands(deps).find((command) => command.id === "pane.derive")!;
    expect(record.requires).toBe("an open document in a pane that is not itself derived");
  });

  test("a pane that is already derived cannot derive again, and an unknown pane cannot either", () => {
    twoPanes();
    lensOn("code");
    expect(deriveRefusal(SECONDARY_PANE)).toBe(
      "an open document in a pane that is not itself derived",
    );
    expect(deriveRefusal("no-such-pane")).toBe(
      "an open document in a pane that is not itself derived",
    );
  });
});

// ─── The commands ────────────────────────────────────────────────────────────

describe("pane.derive and pane.pin", () => {
  function registry() {
    const reg = createCommandRegistry({
      getContext: () => makeContext({ document: { open: workspace.tabs.size > 0 } }),
    });
    reg.registerAll(derivationCommands(deps));
    return reg;
  }

  test("Show Beside This… publishes a lens in the side pane and does NOT move the focus", async () => {
    const page = twoPanes();
    const reg = registry();
    await reg.run("pane.derive", { preset: "code" });

    const derived = derivationOfPane(SECONDARY_PANE)!;
    expect(derived).toMatchObject({ kind: "lens", preset: "code", sourcePaneId: PRIMARY_PANE });
    // The lens draws the primary's document.
    expect(tabOfPane(SECONDARY_PANE)?.id).toBe(page.id);
    // An assistant pane does not take the keyboard.
    expect(workspace.activePaneId).toBe(PRIMARY_PANE);
  });

  /* WHAT `derivationFor` PUTS IN THE RECORD, which nothing checked. Every other test in this file
     builds its derivation by hand through {@link lensOn}, so the one function the COMMAND uses to
     build one had no assertion on either of its two decisions at all. Both are the whole of a
     preset: `mode` is what `canvasModeOfPane` hands the stage — collapse it to `"design"` and a
     Code lens draws the design board and a Diff lens never enters `git-diff` — and `media` is what
     the breakpoint lens is FOR, so dropping it draws Base under a chip naming a size. */
  test("each preset builds the canvas mode its pane will draw in", async () => {
    const page = twoPanes();
    page.capabilities.modes = ["design", "edit", "preview", "source"];
    gitStatusFor("pages/index.json");
    const reg = registry();
    const modeAfter = async (preset: string, args: Record<string, unknown> = {}) => {
      clearPaneDerivation(SECONDARY_PANE);
      await reg.run("pane.derive", { preset, ...args });
      const derived = derivationOfPane(SECONDARY_PANE);
      return derived?.kind === "lens" ? derived.mode : null;
    };
    expect(await modeAfter("code")).toBe("source");
    expect(await modeAfter("diff")).toBe("git-diff");
    expect(await modeAfter("breakpoint")).toBe("design");
    // …and it is the pane's mode, not the tab's: the source document is untouched.
    expect(page.session.ui.canvasMode).not.toBe("git-diff");
  });

  test("a breakpoint lens keeps the size it was asked for; every other preset keeps none", async () => {
    const page = twoPanes();
    page.doc.document.$media = { tablet: "(min-width: 768px)" };
    page.capabilities.modes = ["design", "edit", "preview", "source"];
    const reg = registry();
    await reg.run("pane.derive", { media: "tablet", preset: "breakpoint" });
    const lens = derivationOfPane(SECONDARY_PANE);
    expect(lens?.kind === "lens" ? lens.media : "—").toBe("tablet");

    clearPaneDerivation(SECONDARY_PANE);
    // The same argument handed to a preset that has no breakpoint is IGNORED, not stored: a Code
    // Lens carrying a media would report one through `activeMediaOfPane` and draw at another.
    await reg.run("pane.derive", { media: "tablet", preset: "code" });
    const code = derivationOfPane(SECONDARY_PANE);
    expect(code?.kind === "lens" ? code.media : "—").toBeNull();
  });

  test("it CLOSES NOTHING — the side pane's tabs go back to the pane you are in", async () => {
    const page = twoPanes();

    await registry().run("pane.derive", { preset: "code" });

    expect(workspace.tabs.has("pages/other.json")).toBe(true);
    expect(workspace.panes[0]!.tabOrder).toContain("pages/other.json");
    expect(workspace.panes[1]!.tabOrder).toEqual([]);
    expect(tabOfPane(SECONDARY_PANE)?.id).toBe(page.id);
  });

  test("a refused preset throws a RangeError naming what it needs", () => {
    const page = twoPanes();
    page.session.ui.canvasMode = "source";
    expect(() => registry().run("pane.derive", { preset: "code" })).toThrow(
      /not already showing Code/,
    );
    expect(derivationOfPane(SECONDARY_PANE)).toBeNull();
  });

  test("a pane that is already derived cannot derive again, and says why", () => {
    twoPanes();
    const reg = registry();
    expect(reg.isEnabled("pane.derive")).toBe(true);
    lensOn("code");
    focusPane(SECONDARY_PANE);
    expect(reg.isEnabled("pane.derive")).toBe(false);
    expect(reg.disabledReason("pane.derive")).toBe(
      "an open document in a pane that is not itself derived",
    );
  });

  test("a companion preset builds a companion, and the follow opens its document", async () => {
    const page = twoPanes();
    page.doc.document.$layout = "layouts/base.json";
    await registry().run("pane.derive", { preset: "layout" });
    expect(derivationOfPane(SECONDARY_PANE)).toMatchObject({
      kind: "companion",
      preset: "layout",
      resolved: "layouts/base.json",
    });
    expect(opened).toEqual([{ paneId: SECONDARY_PANE, path: "layouts/base.json" }]);
  });

  /* BOTH of them, because `derivationFor`'s family test is `preset === "layout" || preset ===
     "component"` and only the first disjunct was ever exercised. Drop the second and `component`
     builds a LENS: a pane that owns no tab, projects the source document in `design` mode, is
     refused Pin, and never opens a definition at all — the whole preset, silently replaced by a
     second copy of the page. The two families are the design's load-bearing distinction (§14.1),
     so the assertion is on `kind` rather than on anything the preset happens to draw. */
  test("BOTH companion presets build companions — component is not a lens", async () => {
    const page = twoPanes();
    page.capabilities.modes = ["design", "edit", "preview", "source"];
    componentRegistry.push({ path: "components/card.json", tagName: "my-card" } as never);
    page.session.selection = [["children", 0, "children", 0]];
    const reg = registry();

    await reg.run("pane.derive", { preset: "component" });
    expect(derivationOfPane(SECONDARY_PANE)).toMatchObject({
      kind: "companion",
      preset: "component",
      resolved: "components/card.json",
    });
    // A lens would own no tab and would draw the source document; a companion owns its own.
    expect(tabOfPane(SECONDARY_PANE)?.documentPath).toBe("components/card.json");
    expect(paneOfTab("components/card.json")?.id).toBe(SECONDARY_PANE);
  });

  test("Pin promotes a COMPANION's tab and drops the derivation", async () => {
    twoPanes();
    const reg = registry();
    const layout = openTab({
      document: { tagName: "div" },
      documentPath: "layouts/base.json",
      focus: false,
      id: "layouts/base.json",
      paneId: SECONDARY_PANE,
      preview: true,
    });
    companionOn("layout");
    expect(reg.isEnabled("pane.pin")).toBe(true);

    await reg.run("pane.pin");
    expect(layout.preview).toBe(false);
    expect(derivationOfPane(SECONDARY_PANE)).toBeNull();
    expect(workspace.panes[1]!.tabOrder).toContain("layouts/base.json");
  });

  test("Pin is REFUSED for a lens, with the sentence that says why", () => {
    twoPanes();
    const reg = registry();
    lensOn("code");
    expect(reg.isEnabled("pane.pin")).toBe(false);
    expect(reg.disabledReason("pane.pin")).toContain(
      "Code, Diff and breakpoint views project the document already open beside them",
    );
    // Running it past its own gate is refused BY THE REGISTRY, with the same sentence — never a
    // Second tab for a path that already has one.
    expect(() => reg.run("pane.pin")).toThrow(/project the document already open beside them/);
  });
});

// ─── §18.1 rule 3, restated: a pane with no SUBJECT is a hole ────────────────

describe("the lifecycle of a derived pane", () => {
  test("Unsplit collapses a lens pane and leaves you with the document", () => {
    const page = twoPanes();
    lensOn("code");
    applyDerivation(SECONDARY_PANE, deps);
    closePane(SECONDARY_PANE);
    expect(workspace.panes.map((p) => p.id)).toEqual([PRIMARY_PANE]);
    expect(workspace.activeTabId).toBe(page.id);
  });

  test("a lens pane is NOT collapsed for having an empty tab order", () => {
    twoPanes();
    lensOn("code");
    applyDerivation(SECONDARY_PANE, deps);
    // `detachTab`'s and `closeTab`'s emptiness test is `paneIsEmpty`, which counts the derivation as
    // A subject. Spelled `tabOrder.length === 0`, this pane would vanish the instant it was made.
    const stray = open("scratch.json");
    closeTab(stray.id);
    expect(workspace.panes.map((p) => p.id)).toEqual([PRIMARY_PANE, SECONDARY_PANE]);
  });

  test("the source tab closing while others remain IS the follow, working", () => {
    const page = twoPanes();
    lensOn("code");
    applyDerivation(SECONDARY_PANE, deps);
    // The scratch document came back to the primary with D2, so the primary holds two.
    expect(tabOfPane(SECONDARY_PANE)?.id).toBe(page.id);
    closeTab(page.id);
    expect(tabOfPane(SECONDARY_PANE)?.id).toBe("pages/other.json");
  });

  test("closing the LAST document collapses to one primary and a welcome screen", () => {
    const page = twoPanes();
    lensOn("code");
    applyDerivation(SECONDARY_PANE, deps);
    closeTab("pages/other.json");
    closeTab(page.id);
    /* `detachTab` exempts the primary, `closeTab` calls `closePane(PRIMARY_PANE)`, and `closePane`
       redirects that to the OTHER pane. Nothing states this anywhere, which is why it is written
       down here: one primary, no tab, no derivation. */
    expect(workspace.panes.map((p) => p.id)).toEqual([PRIMARY_PANE]);
    expect(workspace.activeTabId).toBeNull();
    expect(derivationOfPane(PRIMARY_PANE)).toBeNull();
  });

  test("⌘W in a FOCUSED lens pane closes the SOURCE document, and the last one collapses the lens", () => {
    const page = twoPanes();
    lensOn("code");
    applyDerivation(SECONDARY_PANE, deps);
    focusPane(SECONDARY_PANE);

    /* The getter hop's one consequence, and it is coherent: a lens has no document of its own, so
       "the document I am in" is the source pane's. Without the hop, focusing the lens would make
       `activeTab` null and the Inspector, the toolbar, ⌘S and undo would all print "no document"
       over a stage that is visibly drawing one. */
    expect(workspace.activeTabId).toBe(page.id);
    closeTab(workspace.activeTabId!);
    expect(workspace.tabs.has(page.id)).toBe(false);
    // One document left, so the lens simply follows it — this is the follow, not a collapse.
    expect(tabOfPane(SECONDARY_PANE)?.id).toBe("pages/other.json");

    // Closing that one leaves nothing to project, and the grid goes back to one primary.
    closeTab(workspace.activeTabId!);
    expect(workspace.tabs.size).toBe(0);
    expect(workspace.panes.map((p) => p.id)).toEqual([PRIMARY_PANE]);
  });

  test("a lens pane resolves its source document for every focused read", () => {
    const page = twoPanes();
    lensOn("breakpoint", null);
    focusPane(SECONDARY_PANE);
    expect(workspace.activeTabId).toBe(page.id);
    // …and a lens whose source pane holds nothing answers null rather than a stale id.
    workspace.panes[0]!.activeTabId = null;
    expect(workspace.activeTabId).toBeNull();
  });
});

// ─── The locale companion ────────────────────────────────────────────────────

/**
 * `locale` is a COMPANION, and the two halves that makes true: the record carries a tag, and the
 * pane refuses to open a file that is not there.
 *
 * Jx has no message catalogue (§13.3) — a translation is a different file in a different directory
 * — so a preset that changed only the chip would be the defect this module's header warns about.
 * The probe is the other half: `companionTarget` is pure, so "is there a French copy" is a question
 * only the disk can answer, and answering it wrongly is either a blank pane (a path that does not
 * exist) or a sentence about a missing translation shown for every frame before the answer lands.
 */
describe("the locale companion — a different FILE, and only when it is there", () => {
  function registry() {
    const reg = createCommandRegistry({
      getContext: () => makeContext({ document: { open: workspace.tabs.size > 0 } }),
    });
    reg.registerAll(derivationCommands(deps));
    return reg;
  }

  /** Issue → answer → re-enter: the three microtask turns a probe takes to become a status. */
  async function settleProbe(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  test("the refusal names one missing thing at a time", () => {
    const page = twoPanes();
    // No `i18n` block at all: this is not a projection the project has.
    expect(presetRefusal("locale", PRIMARY_PANE, null, "fr")).toBe(
      "a project that declares more than one locale — see Project Settings › Locales",
    );
    // One declared locale is still monolingual — there is no OTHER language to show.
    multilingual("en");
    expect(presetRefusal("locale", PRIMARY_PANE, null, "en")).toBe(
      "a project that declares more than one locale — see Project Settings › Locales",
    );

    multilingual("en", "fr");
    /* A DOCUMENT WITH NO PATH has nowhere for a sibling to be. Without this the next answer would
       be `translationPathFor`'s, which is a sentence about locales for a problem about saving. */
    page.documentPath = null;
    expect(presetRefusal("locale", PRIMARY_PANE, null, "fr")).toBe(
      "a document that has been saved",
    );

    page.documentPath = "pages/index.json";
    // A tag the project does not declare, and the missing argument, get the same answer.
    expect(presetRefusal("locale", PRIMARY_PANE, null, "de")).toBe(
      "a locale this project declares",
    );
    expect(presetRefusal("locale", PRIMARY_PANE, null)).toBe("a locale this project declares");
    expect(presetRefusal("locale", PRIMARY_PANE, null, "fr")).toBeNull();
  });

  /* THE RECORD IS A COMPANION AND IT CARRIES THE TAG. Both halves are the preset: a lens would
     draw a second copy of the same page under a chip naming another language, and a companion with
     no tag has no file to resolve — `companionTarget` would answer "no path in that locale" about
     a locale nobody named. */
  test("the preset builds a companion carrying its tag, not a lens over the same page", async () => {
    twoPanes();
    multilingual("en", "fr");
    filesOnDisk.add("pages/fr/index.json");

    await registry().run("pane.derive", { locale: "fr", preset: "locale" });

    expect(derivationOfPane(SECONDARY_PANE)).toMatchObject({
      kind: "companion",
      locale: "fr",
      preset: "locale",
    });
  });

  test("the pane opens the translation the build would serve, once it is known to exist", async () => {
    twoPanes();
    multilingual("en", "fr");
    filesOnDisk.add("pages/fr/index.json");
    localeCompanionOn("fr");

    /* NOTHING IS OPENED ON THE STRENGTH OF A PATH ALONE. The pane holds for exactly as long as the
       probe is out, which is the frame `applyDerivation` cannot skip: a path that turns out not to
       be there is a blank pane, and a blank pane is what §18.4's last paragraph refuses. */
    applyDerivation(SECONDARY_PANE, deps);
    expect(opened).toEqual([]);
    expect(derivationOfPane(SECONDARY_PANE)?.status).toBe("loading");

    await settleProbe();
    expect(existsAsked).toEqual(["pages/fr/index.json"]);
    expect(opened).toEqual([{ paneId: SECONDARY_PANE, path: "pages/fr/index.json" }]);
    expect(derivationOfPane(SECONDARY_PANE)).toMatchObject({
      resolved: "pages/fr/index.json",
      status: "ready",
    });
  });

  /* THE DEFAULT LOCALE IS A ROW LIKE ANY OTHER, and `prefix-except-default` is why its file is the
     unprefixed one. A companion that spelled every locale as a directory would send the author of
     `pages/fr/about.json` to `pages/en/about.json`, which nothing serves and nothing has. */
  test("the default locale resolves to the unprefixed path, from a translated document", async () => {
    open("pages/fr/about.json");
    open("scratch.json");
    expect(splitRight()?.id).toBe(SECONDARY_PANE);
    focusPane(PRIMARY_PANE);
    multilingual("en", "fr");
    filesOnDisk.add("pages/about.json");

    await registry().run("pane.derive", { locale: "en", preset: "locale" });
    await settleProbe();

    expect(opened).toEqual([{ paneId: SECONDARY_PANE, path: "pages/about.json" }]);
  });

  /* A TERMINAL ANSWER, not a hold and not a blank. `component` holds when its rule resolves to
     nothing because the next click may resolve it; a language nobody has written stays unwritten
     until somebody writes it, and a pane that quietly went on showing the previous document under
     a chip reading "Same page in français" would be lying in the one place the author is looking.
     Forcing the probe's answer to `true` — the mutant — opens `pages/fr/index.json`, which is not
     there, and `openFileInPane` fails into a blank pane. */
  test("a locale with no copy yet is unavailable IN WORDS, and nothing is opened", async () => {
    twoPanes();
    multilingual("en", "fr");

    await registry().run("pane.derive", { locale: "fr", preset: "locale" });
    await settleProbe();

    expect(opened).toEqual([]);
    const derived = derivationOfPane(SECONDARY_PANE)!;
    expect(derived.status).toBe("unavailable");
    // The autonym, and the recovery: the sentence says which language and what to do about it.
    expect(derived.reason).toContain("français");
    expect(derived.reason).toContain("Languages");
  });

  test("the probe is issued once per wanted path however many frames resolve", async () => {
    twoPanes();
    multilingual("en", "fr", "de");
    localeCompanionOn("fr");

    applyDerivation(SECONDARY_PANE, deps);
    applyDerivation(SECONDARY_PANE, deps);
    await settleProbe();
    applyDerivation(SECONDARY_PANE, deps);
    await settleProbe();
    expect(existsAsked).toEqual(["pages/fr/index.json"]);

    /* …and a DIFFERENT wanted path is a different question. Retargeting the source pane at another
       document — or the author choosing another language — must ask again, or the second locale
       inherits the first one's answer. */
    localeCompanionOn("de");
    applyDerivation(SECONDARY_PANE, deps);
    await settleProbe();
    expect(existsAsked).toEqual(["pages/fr/index.json", "pages/de/index.json"]);
  });

  /* A READ THAT LANDS AFTER THE QUESTION CHANGED IS NOT AN ANSWER. `fileExists` is a real disk
     read, so the author choosing another language while one is out is ordinary rather than exotic
     — and without the guard the pane that is now asking about German would be handed French's
     answer, then re-resolve on the strength of it. `loadDiffFor` carries the same hazard for the
     same reason; this is its half of it. */
  test("a probe that lands after the pane moved on is dropped, not written onto the new question", async () => {
    twoPanes();
    multilingual("en", "fr", "de");
    filesOnDisk.add("pages/fr/index.json");
    let answer: (exists: boolean) => void = () => {};
    const slow: DerivationDeps = {
      ...deps,
      fileExists: (path: string) => {
        existsAsked.push(path);
        return new Promise<boolean>((resolve) => {
          answer = resolve;
        });
      },
    };

    localeCompanionOn("fr");
    applyDerivation(SECONDARY_PANE, slow);
    // The author picks another language while the first read is still out.
    localeCompanionOn("de");
    answer(true);
    await settleProbe();

    /* NOTHING HAPPENED: no file opened on French's answer, and — the sharper half — no re-resolve,
       which is what would have asked German's question through the stale read's own `deps`. */
    expect(opened).toEqual([]);
    expect(existsAsked).toEqual(["pages/fr/index.json"]);

    // German then asks for itself, and gets its own answer: nobody has written that copy either.
    applyDerivation(SECONDARY_PANE, deps);
    await settleProbe();
    expect(existsAsked).toEqual(["pages/fr/index.json", "pages/de/index.json"]);
    expect(derivationOfPane(SECONDARY_PANE)?.status).toBe("unavailable");
  });

  /* A READ THAT THROWS IS THE PLATFORM FAILING, not the translation being absent — the two must
     not become the same sentence, or a backend that is down tells every author their copies have
     all disappeared. The probe stays out, the pane goes on holding, and the reason is on the
     console where a platform failure belongs. */
  test("a REJECTED probe is reported, not turned into a missing translation", async () => {
    twoPanes();
    multilingual("en", "fr");
    const logged: unknown[] = [];
    const console_ = console.error;
    console.error = (...args: unknown[]) => logged.push(args[0]);
    try {
      localeCompanionOn("fr");
      applyDerivation(SECONDARY_PANE, {
        ...deps,
        fileExists: () => Promise.reject(new Error("no disk")),
      });
      await settleProbe();
    } finally {
      console.error = console_;
    }
    expect(logged).toContain("fileExists error:");
    expect(derivationOfPane(SECONDARY_PANE)?.status).toBe("loading");
    expect(opened).toEqual([]);
  });

  /* A NEW DERIVATION IS A NEW QUESTION, and `writeDerivation` is the one place that forgets. The
     probe outliving the derivation that asked it means a pane pointed at `fr` a second time —
     after the author created the file — would still be holding "there is no French copy". */
  test("writing a derivation forgets the probe, so the same locale is asked again", async () => {
    twoPanes();
    multilingual("en", "fr");
    localeCompanionOn("fr");
    applyDerivation(SECONDARY_PANE, deps);
    await settleProbe();
    expect(derivationOfPane(SECONDARY_PANE)?.status).toBe("unavailable");

    // The author writes the file, and points the pane at French again.
    filesOnDisk.add("pages/fr/index.json");
    localeCompanionOn("fr");
    applyDerivation(SECONDARY_PANE, deps);
    await settleProbe();

    expect(existsAsked).toEqual(["pages/fr/index.json", "pages/fr/index.json"]);
    expect(derivationOfPane(SECONDARY_PANE)?.status).toBe("ready");
  });

  /* THE REFUSAL RUNS ONCE; THE TARGET RUNS EVERY FRAME. `presetRefusal` cannot see a locale removed
     from `project.json` after the companion opened, so `companionTarget` re-reads the project's
     list every time it resolves and says so — trap 12's second half. */
  test("a locale the project stopped declaring goes unavailable, with words", async () => {
    twoPanes();
    multilingual("en", "fr");
    filesOnDisk.add("pages/fr/index.json");
    localeCompanionOn("fr");
    applyDerivation(SECONDARY_PANE, deps);
    await settleProbe();
    expect(derivationOfPane(SECONDARY_PANE)?.status).toBe("ready");

    multilingual("en");
    applyDerivation(SECONDARY_PANE, deps);
    expect(derivationOfPane(SECONDARY_PANE)).toMatchObject({
      reason: "This document has no path in that locale.",
      status: "unavailable",
    });
  });

  /* A DERIVATION WITH NO TAG, and a document no locale can address, are the same answer: there is
     no path to open. The first is reachable only through a hand-built record — `pane.derive`
     refuses it — and the second is ordinary, because a layout is shared by every language. */
  test("a document no locale can address, and a companion with no tag, both say so", async () => {
    twoPanes();
    multilingual("en", "fr");

    localeCompanionOn(null);
    applyDerivation(SECONDARY_PANE, deps);
    expect(derivationOfPane(SECONDARY_PANE)?.reason).toBe(
      "This document has no path in that locale.",
    );

    tabOfPane(PRIMARY_PANE)!.documentPath = "layouts/base.json";
    localeCompanionOn("fr");
    applyDerivation(SECONDARY_PANE, deps);
    expect(derivationOfPane(SECONDARY_PANE)).toMatchObject({
      reason: "This document has no path in that locale.",
      status: "unavailable",
    });
    expect(existsAsked).toEqual([]);
  });
});

/** One animation frame — `queueRetarget`'s hop, and the microtasks an open would settle in. */
async function frame(): Promise<void> {
  await new Promise((resolve) => {
    requestAnimationFrame(() => resolve(null));
  });
  await Promise.resolve();
}
