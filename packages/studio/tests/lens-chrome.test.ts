/**
 * What a LENS pane's chrome says, and what it deliberately does not offer.
 *
 * Presence and identity only. Every geometric claim about this surface — that the `⟲` trigger fits
 * the bar's leading slot at the splitter's 320px floor without pushing the three axes into a second
 * row, that the one-chip strip does not collapse to zero height, that the preset popover's
 * `bottom-end` placement does not open off the left edge in the primary pane, that the breakpoint
 * lens's artboard is fitted to its own pane — is a LAYOUT claim, and happy-dom does no layout:
 * every rect here is zero. Those belong to `packages/studio:verify` plus a screenshot, and are
 * named here rather than asserted, because an assertion that cannot fail is worse than no test at
 * all. Two CSS grid bugs shipped green through 8000 tests last round and were found by opening a
 * picture.
 *
 * What CAN fail here is the set of controls: a lens must not offer the two axes that WRITE
 * (`ctx.setCanvasMode(tab, …)` on a tab the pane beside it owns), must not draw the Document Header
 * card (an editing surface over the same frontmatter), must keep the zoom pod (zoom is the one view
 * fact a lens owns), and must draw a derivation chip where an ordinary pane draws tab chips.
 */
import { flush, installMockPlatform, resetStudioState, resetWorkspaceWithTab } from "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Tab } from "../src/tabs/tab";

const paneContext = await import("../src/panels/pane-context");
const tabStrip = await import("../src/panels/tab-strip");
const { jumpSegments } = await import("../src/panels/jump-bar");
const {
  PRIMARY_PANE,
  SECONDARY_PANE,
  closeAllTabs,
  focusPane,
  openTab,
  paneById,
  splitRight,
  workspace,
} = await import("../src/workspace/workspace");
const { setPaneDerivation, applyDerivation, derivationOfPane, noopDerivationDeps } =
  await import("../src/workspace/pane-derive");
const { hasDocumentHeader } = await import("../src/panels/frontmatter-panel");
const { createCommandRegistry } = await import("../src/commands/registry");
const { makeContext } = await import("../src/commands/context");
const { activeRegistry, setActiveRegistry } = await import("../src/commands/active-registry");
const { derivationCommands } = await import("../src/workspace/pane-derive");
const { paneCommands } = await import("../src/workspace/workspace");
const { collabState } = await import("../src/collab/collab-state");
const { activateTab, moveTabToPane } = await import("../src/workspace/workspace");

type Ctx = Parameters<typeof paneContext.mount>[1];

function makeCtx(): Ctx {
  return {
    exportFile: mock(() => {}),
    parseMediaEntries: mock(() => ({
      baseWidth: 1200,
      featureQueries: [] as { name: string; query: string }[],
      sizeBreakpoints: [] as { name: string; query: string; width: number; type: string }[],
    })),
    setCanvasMode: mock((tab: Tab | null, mode: string) => {
      if (tab) {
        tab.session.ui.canvasMode = mode;
      }
    }),
  } as Ctx;
}

let primaryHost: HTMLElement;
let sideHost: HTMLElement;
let stripHost: HTMLElement;

/**
 * A dependency set whose `openFileInPane` really moves a tab, for the tests that drive the command.
 *
 * `noopDerivationDeps()` is the right default here — most of this file asks what the chrome DRAWS —
 * but the strip's bookkeeping is about a pane losing a tab and getting it back, so the opener has
 * to be the shape `files/files.ts` has: reveal an already-open document rather than re-read it.
 */
function openingDeps() {
  return {
    fileExists: () => Promise.resolve(true),
    loadDiff: () => Promise.resolve(null),
    openFileInPane: (paneId: string, path: string) => {
      const existing = [...workspace.tabs.values()].find((tab) => tab.documentPath === path);
      if (existing) {
        moveTabToPane(existing.id, paneId);
        activateTab(existing.id, { focus: false });
      }
    },
  };
}

/** The primary holding a page, the secondary a Code lens on it. */
function lensGrid(): Tab {
  const page = resetWorkspaceWithTab(
    { children: [{ tagName: "p", textContent: "Hi" }], tagName: "div", title: "Home" },
    { documentPath: "pages/index.json", id: "pages/index.json" },
  );
  page.capabilities.modes = ["edit", "design", "preview", "source"];
  openTab({ document: { tagName: "div" }, documentPath: "scratch.json", id: "scratch.json" });
  expect(splitRight()?.id).toBe(SECONDARY_PANE);
  focusPane(PRIMARY_PANE);
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
  return page;
}

/**
 * Two ORDINARY panes: the primary on a page, the secondary on a scratch document.
 *
 * The grid the preset menu is normally opened in, and the one {@link lensGrid} cannot stand in for —
 * a lens draws no ⟲ trigger, so a question about what the menu DOES has to be asked of a pane that
 * has one.
 */
function twoPaneGrid(): Tab {
  const page = resetWorkspaceWithTab(
    { children: [{ tagName: "p", textContent: "Hi" }], tagName: "div", title: "Home" },
    { documentPath: "pages/index.json", id: "pages/index.json" },
  );
  page.capabilities.modes = ["edit", "design", "preview", "source"];
  openTab({ document: { tagName: "div" }, documentPath: "scratch.json", id: "scratch.json" });
  expect(splitRight()?.id).toBe(SECONDARY_PANE);
  focusPane(PRIMARY_PANE);
  return page;
}

function axesOf(host: HTMLElement): string[] {
  return [...host.querySelectorAll(".pc-axis-label")].map((el) => el.textContent?.trim() ?? "");
}

/** One of the pod's two write controls, addressed by the tooltip the author reads. */
function zoomControl(host: HTMLElement, title: string): HTMLElement {
  const button = [...host.querySelectorAll(".pane-zoom sp-action-button")].find((el) =>
    el.getAttribute("title")?.startsWith(title),
  );
  expect(button).toBeDefined();
  return button as HTMLElement;
}

beforeEach(() => {
  closeAllTabs();
  resetStudioState();
  installMockPlatform();
  const registry = createCommandRegistry({
    getContext: () => makeContext({ document: { open: workspace.tabs.size > 0 } }),
  });
  registry.registerAll([
    ...paneCommands({ openFile: () => {}, openFileInPane: () => {} }),
    ...derivationCommands(noopDerivationDeps()),
  ]);
  setActiveRegistry(registry);
  primaryHost = document.createElement("div");
  sideHost = document.createElement("div");
  stripHost = document.createElement("div");
  document.body.append(primaryHost, sideHost, stripHost);
});

afterEach(() => {
  paneContext.dismissPresetMenu();
  paneContext.unmount();
  tabStrip.unmount();
  setActiveRegistry(null);
  primaryHost.remove();
  sideHost.remove();
  stripHost.remove();
  for (const host of document.querySelectorAll('[data-jx-region$="/tabs"]')) {
    host.remove();
  }
  closeAllTabs();
});

describe("the context bar in a lens pane", () => {
  test("offers Context only — the two axes that WRITE the source tab are gone", async () => {
    lensGrid();
    paneContext.mount(primaryHost, makeCtx());
    paneContext.attachPaneChromeHost(SECONDARY_PANE, sideHost);
    paneContext.render();
    await flush();

    // The pane that owns the document keeps all three.
    expect(axesOf(primaryHost)).toEqual(["Editor", "View", "Context"]);
    /* The lens keeps only the read-only summary. Editor kind and Canvas view both land in
       `ctx.setCanvasMode(tab, …)`, and that tab belongs to the pane beside this one — a control
       here would flip the document the author is editing. */
    expect(axesOf(sideHost)).toEqual(["Context"]);
    expect(sideHost.querySelector(".pane-context")).not.toBeNull();
  });

  test("keeps the zoom pod, reading the LENS's own scale and not the source tab's", async () => {
    lensGrid();
    // A breakpoint lens: Code has no pan-zoom in either pane, so the pod is absent there for a
    // Reason that has nothing to do with derivation.
    const derived = derivationOfPane(SECONDARY_PANE)!;
    Object.assign(derived, { media: null, mode: "design", preset: "breakpoint", zoom: 0.4 });
    paneContext.attachPaneChromeHost(SECONDARY_PANE, sideHost);
    paneContext.mount(primaryHost, makeCtx());
    await flush();

    expect(sideHost.querySelector(".pane-zoom")).not.toBeNull();
    /* `session.ui.zoom` is per-TAB and the lens shares the source pane's tab, so a pod reading it
       would report the desktop pane's scale and divide the wrong number on the minus button. */
    expect(sideHost.querySelector(".pc-zoom-label")?.textContent?.trim()).toBe("40%");
  });

  /* …AND IT REPAINTS WHEN THE SCALE MOVES. The test above sets `zoom` BEFORE the mount, so it
     proves the READ and says nothing about the subscription — and the subscription is the half
     that can be wrong: `derived.zoom` is not on the tab, so none of the fifteen `tab.session.ui.*`
     reads in this bar's effect track it. Untracked, the pod reports the scale the lens had one
     interaction ago and the author's next ⌘− divides a stale number. Zoom is the ONE view fact a
     lens owns, so it is also the only one this can happen to. */
  test("the zoom pod follows the lens's scale — it is a tracked input, not a first-paint read", async () => {
    lensGrid();
    const derived = derivationOfPane(SECONDARY_PANE)!;
    Object.assign(derived, { media: null, mode: "design", preset: "breakpoint", zoom: 1 });
    paneContext.attachPaneChromeHost(SECONDARY_PANE, sideHost);
    paneContext.mount(primaryHost, makeCtx());
    await flush();
    expect(sideHost.querySelector(".pc-zoom-label")?.textContent?.trim()).toBe("100%");

    (derivationOfPane(SECONDARY_PANE) as { zoom: number }).zoom = 0.5;
    await flush();

    expect(sideHost.querySelector(".pc-zoom-label")?.textContent?.trim()).toBe("50%");
  });

  /* FINDING 10b. The trigger WAS drawn in a lens, and a test locked it in. From there every
     projection row is permanently disabled — a derived pane cannot derive again — the breakpoint
     rows are suppressed outright, and Pin is refused for a projection; the one live row is
     Unsplit, which the derivation chip's ✕ in this pane's own strip already runs. A control that
     can do nothing from where it is drawn is the class this phase has deleted three times.
     Both halves of this test fail against the old template: the lens grew a trigger, and the
     spacer that positions the axes was where the trigger used to live. */
  test("the ⟲ trigger is drawn where it can do something — and a lens is not that place", async () => {
    lensGrid();
    paneContext.attachPaneChromeHost(SECONDARY_PANE, sideHost);
    paneContext.mount(primaryHost, makeCtx());
    await flush();
    expect(primaryHost.querySelectorAll(".pc-derive-trigger")).toHaveLength(1);
    // Counted rather than compared to `null`, for the same reason as the chip assertion in
    // `properties-panel.test.ts`: a happy-dom element in a failure message drags its whole `window`
    // Into the output.
    expect(sideHost.querySelectorAll(".pc-derive-trigger")).toHaveLength(0);
    // The SPACER stays — it is what pushes the axes right, and dropping it with the trigger would
    // Move the one control a lens does draw.
    expect(sideHost.querySelector(".pc-spacer")).not.toBeNull();
  });

  /* FINDING 10a. `renderingSummaryTpl` called `ctx.parseMediaEntries(getEffectiveMedia(...))` and
     threw the result away through `void sizeBreakpoints` — a parse of the document's whole `$media`
     map on every lens-bar render, for a value nothing read. */
  test("the lens's Context summary parses no media map to print one name", async () => {
    lensGrid();
    const ctx = makeCtx();
    const parses = ctx.parseMediaEntries as unknown as {
      mock: { calls: unknown[] };
      mockClear: () => void;
    };
    paneContext.attachPaneChromeHost(SECONDARY_PANE, sideHost);
    paneContext.mount(primaryHost, ctx);
    await flush();

    /* Only the LENS draws for this pass. The pane that owns the tab parses legitimately — its
       rendering-context control offers every breakpoint — so the count has to be attributed, not
       totalled. */
    paneContext.attachPaneChromeHost(PRIMARY_PANE, null);
    parses.mockClear();
    paneContext.render();

    expect(sideHost.querySelector(".pc-static")?.textContent?.trim()).toBe("Base");
    expect(parses.mock.calls).toEqual([]);
  });

  /* FINDING 6. The summary read `tab.session.ui.activeMedia` — the SOURCE tab's field, because a
     lens shares its tab — so the one axis a breakpoint lens is named after named the breakpoint of
     the pane beside it: the stage drew the Tablet artboard and the line under it said "Base".
     `activeMediaOfPane(paneId)` exists for exactly this question and was called nowhere here.

     The docstring above this template says a lens drawn under different params "would be lying
     about what it is a lens of". This was the lie. */
  test("the Context summary names the LENS's breakpoint, not the shared tab's", async () => {
    const page = lensGrid();
    // The pane that owns the tab is looking at the wide artboard.
    page.session.ui.activeMedia = "wide";
    Object.assign(derivationOfPane(SECONDARY_PANE)!, {
      media: "tablet",
      mode: "design",
      preset: "breakpoint",
    });
    paneContext.attachPaneChromeHost(SECONDARY_PANE, sideHost);
    paneContext.mount(primaryHost, makeCtx());
    await flush();

    expect(sideHost.querySelector(".pc-static")?.textContent?.trim()).toBe("Tablet");

    // …and a BASE lens says Base, though the tab it shares is still on `wide`. `null` is the
    // Lens's answer, not a missing one.
    Object.assign(derivationOfPane(SECONDARY_PANE)!, { media: null });
    paneContext.render();
    await flush();
    expect(sideHost.querySelector(".pc-static")?.textContent?.trim()).toBe("Base");
  });
});

describe("the preset menu's rows", () => {
  test("every row is a COMMAND with its arguments — there is no `pane.showDerivePresets`", () => {
    lensGrid();
    const rows = paneContext.presetRows(PRIMARY_PANE);
    expect(rows.map((row) => row.command)).toEqual([
      "pane.derive",
      "pane.derive",
      "pane.derive",
      "pane.derive",
      "pane.derive", // "Same page at Base" — one row per declared breakpoint
      "pane.pin",
      "pane.unsplit",
    ]);
    expect(rows[0]).toMatchObject({ args: { preset: "code" }, label: "Code" });
    expect(rows[1]).toMatchObject({ args: { preset: "layout" } });
    /* The BASE breakpoint row omits `media` entirely rather than passing `""`. `optionalStringArg`
       refuses an empty string on purpose, so a row that said `media: ""` threw
       `expected a non-empty string, got ""` the moment anyone clicked it — which is exactly what it
       did, in a browser, after 8000 green unit tests. */
    const base = rows.find((row) => row.label === "Same page at Base")!;
    expect(base.args).toEqual({ preset: "breakpoint" });
  });

  test("a row that cannot run carries the sentence saying why, not a hidden row", () => {
    const page = lensGrid();
    page.session.ui.canvasMode = "source";
    const code = paneContext.presetRows(PRIMARY_PANE).find((row) => row.label === "Code")!;
    expect(code.disabled).toBe("a source pane that is not already showing Code");
    // …and Pin is refused for a lens with the sentence §18.4 is wrong about.
    const pin = paneContext.presetRows(PRIMARY_PANE).find((row) => row.command === "pane.pin")!;
    expect(pin.disabled).toContain("project the document already open beside them");
  });

  /* FINDING 5. `presetRows(paneId)` asked `registry.disabledReason("pane.derive")`, and a registry
     resolves its context from the FOCUS — so the same pane's rows changed answer depending on where
     the author had last clicked. The audit's probe:

       rows(SECONDARY) with SECONDARY focused: null (enabled)
       rows(SECONDARY) with the LENS focused:  "an open document in a pane that is not itself
                                               derived"

     Same pane, same question, two answers. The pair below fails against that spelling: the first
     because the PRIMARY's rows were disabled while the lens held the keyboard, the second because
     the SECONDARY's were enabled while the primary did. */
  test("a pane's rows are the same wherever the keyboard is — the menu is not a focus read", () => {
    lensGrid();
    const reasonsFor = (paneId: string) =>
      paneContext
        .presetRows(paneId)
        .filter((row) => row.command === "pane.derive")
        .map((row) => row.disabled);

    focusPane(PRIMARY_PANE);
    const primaryFocused = { lens: reasonsFor(SECONDARY_PANE), page: reasonsFor(PRIMARY_PANE) };
    focusPane(SECONDARY_PANE);
    const lensFocused = { lens: reasonsFor(SECONDARY_PANE), page: reasonsFor(PRIMARY_PANE) };

    expect(lensFocused).toEqual(primaryFocused);
    /* …and the answers are the right ones. The page's Code row can run; every one of the lens's
       rows carries the derived sentence, whichever preset it is, because a derived pane cannot
       derive again. (The page's Layout and Diff rows carry their OWN per-preset refusals — that is
       `presetRefusal`, and it was never the focus-dependent half.) */
    expect(primaryFocused.page[0]).toBeNull();
    expect(
      primaryFocused.lens.every(
        (reason) => reason === "an open document in a pane that is not itself derived",
      ),
    ).toBe(true);
  });

  /* A derived pane's menu lists NO breakpoint rows. Every projection row it does list is disabled
     — a derived pane cannot derive again — and the breakpoint rows are suppressed outright rather
     than repeated once per declared size, because "one disabled row per breakpoint" is a menu that
     grows with the document and can never run a single entry.
     The focus test below cannot see this: it compares the two focus states with each other, and a
     menu that grew rows would grow the same rows in both. */
  test("a derived pane is offered no breakpoint rows at all", () => {
    const page = lensGrid();
    page.doc.document.$media = { "--": "400px", tablet: "(min-width: 768px)" };
    const labels = (paneId: string) =>
      paneContext.presetRows(paneId).map((row) => row.label as string);

    // The pane that owns the document gets one row per declared size, plus base.
    expect(labels(PRIMARY_PANE).filter((l) => l.startsWith("Same page at"))).toEqual([
      "Same page at Base",
      "Same page at Tablet",
    ]);
    expect(labels(SECONDARY_PANE).filter((l) => l.startsWith("Same page at"))).toEqual([]);
  });

  /* FINDING 7, the refusal half. "Layout" was offered on a page with no layout and produced a pane
     with a derivation, no tabs and nothing drawn anywhere. */
  /* THE BREAKPOINT ROWS HAVE THEIR OWN REFUSAL, and they are built in a second loop that could
     drop it while every projection row above kept theirs. {@link MODE_FOR_PRESET} exists for
     exactly this row — over the Project Settings document the menu offered "Same page at Base",
     whose stage can only draw an empty artboard — and `presetRefusal`'s half of that is covered by
     `pane-derive.test.ts`. What was not covered is the WIRING: `deriveReason ?? presetRefusal(…)`
     in the breakpoint loop, whose left side is `null` for an ordinary pane, so dropping the right
     side puts a live row over a document that cannot draw it. */
  test("a breakpoint row carries the refusal for the size it names", () => {
    const page = twoPaneGrid();
    page.capabilities.modes = ["settings", "stylebook", "source"];
    const breakpoints = paneContext
      .presetRows(PRIMARY_PANE)
      .filter((row) => (row.args as { preset?: string }).preset === "breakpoint");

    expect(breakpoints.length).toBeGreaterThan(0);
    for (const row of breakpoints) {
      expect(row.disabled).toBe("a document with a Design view — this one declares none");
    }

    // …and a document that declares Design gets them live, so the row is not simply always dead.
    page.capabilities.modes = ["edit", "design", "preview", "source"];
    expect(
      paneContext
        .presetRows(PRIMARY_PANE)
        .filter((row) => (row.args as { preset?: string }).preset === "breakpoint")
        .every((row) => row.disabled === null),
    ).toBe(true);
  });

  /* "Same page in ⟨language⟩" — one row per locale the PROJECT declares, which is the axis that
     makes these rows different from every other one in this menu: the breakpoints come from the
     document and the locales come from `project.json`, so a monolingual project has no rows here
     at all rather than a disabled one. The label is the AUTONYM, because a menu that says "French"
     is unreadable to precisely the person it exists for. */
  test("a locale row per declared locale, labelled in that language, carrying its tag", () => {
    twoPaneGrid();
    const localeRows = () =>
      paneContext
        .presetRows(PRIMARY_PANE)
        .filter((row) => (row.args as { preset?: string }).preset === "locale");

    // A project with no `i18n` block: the menu is the menu it has always been.
    expect(localeRows()).toEqual([]);

    resetStudioState({
      projectConfig: { i18n: { defaultLocale: "en", locales: ["en", "fr", "ar"] } },
    });
    expect(localeRows().map((row) => row.label)).toEqual([
      "Same page in English",
      "Same page in français",
      "Same page in العربية",
    ]);
    /* Every row names a real tag. Unlike the base BREAKPOINT row there is no omit-the-argument
       case — the default locale is a tag like any other, and `translationPathFor` is what knows
       its file is the unprefixed one. */
    expect(localeRows().map((row) => row.args)).toEqual([
      { locale: "en", preset: "locale" },
      { locale: "fr", preset: "locale" },
      { locale: "ar", preset: "locale" },
    ]);
    expect(localeRows().every((row) => row.disabled === null)).toBe(true);
  });

  /* THE LOCALE ROW CARRIES ITS OWN REFUSAL, in the second loop that could drop it while every
     projection row above kept theirs. Its left side (`deriveReason`) is null for an ordinary pane,
     so dropping the right side puts a live row over a project that has one language and over a
     document that has never been saved — and choosing either throws a `RangeError` out of a click
     handler. */
  test("a locale row states why it cannot run", () => {
    const page = twoPaneGrid();
    resetStudioState({ projectConfig: { i18n: { defaultLocale: "en", locales: ["en"] } } });
    const localeRows = () =>
      paneContext
        .presetRows(PRIMARY_PANE)
        .filter((row) => (row.args as { preset?: string }).preset === "locale");

    expect(localeRows()).toHaveLength(1);
    expect(localeRows()[0]?.disabled).toBe(
      "a project that declares more than one locale — see Project Settings › Locales",
    );

    // …and a second language makes the rows live, so the refusal is not simply always there.
    resetStudioState({ projectConfig: { i18n: { defaultLocale: "en", locales: ["en", "fr"] } } });
    expect(localeRows().every((row) => row.disabled === null)).toBe(true);

    // An unsaved document has nowhere for a sibling to be, and the row says that instead.
    page.documentPath = null;
    expect(localeRows().every((row) => row.disabled === "a document that has been saved")).toBe(
      true,
    );
  });

  /* A derived pane lists NO locale rows, for the breakpoint rows' reason: every one of them would
     be disabled with the same sentence, and a menu that grows one dead row per language the
     project speaks is a menu that grows to say nothing. */
  test("a derived pane is offered no locale rows at all", () => {
    lensGrid();
    resetStudioState({ projectConfig: { i18n: { defaultLocale: "en", locales: ["en", "fr"] } } });
    const localeLabels = (paneId: string) =>
      paneContext
        .presetRows(paneId)
        .map((row) => row.label as string)
        .filter((label) => label.startsWith("Same page in"));

    expect(localeLabels(PRIMARY_PANE)).toEqual(["Same page in English", "Same page in français"]);
    expect(localeLabels(SECONDARY_PANE)).toEqual([]);
  });

  /* THE OTHER EXIT'S REASON. `pane.unsplit`'s enablement is a fact about the GRID rather than about
     a pane, so the menu computes it here instead of asking the registry — and a row that computes
     its own answer can compute `null` unconditionally, which is a live "Close Side Pane" on a grid
     with no side pane. The sentence is the command record's own `requires`, so the tooltip and the
     palette agree. */
  test("Close Side Pane states why it cannot run on a one-pane grid", () => {
    resetWorkspaceWithTab(
      { children: [{ tagName: "p" }], tagName: "div" },
      { documentPath: "pages/index.json", id: "pages/index.json" },
    );
    const unsplit = () =>
      paneContext.presetRows(PRIMARY_PANE).find((row) => row.command === "pane.unsplit")!;
    expect(workspace.panes).toHaveLength(1);
    expect(unsplit().disabled).toBe("a second pane");

    openTab({ document: { tagName: "div" }, documentPath: "scratch.json", id: "scratch.json" });
    expect(splitRight()?.id).toBe(SECONDARY_PANE);
    expect(unsplit().disabled).toBeNull();
  });

  test("Layout is refused up front on a page that declares none, with the sentence saying so", () => {
    const page = lensGrid();
    const layoutRow = () => paneContext.presetRows(PRIMARY_PANE).find((r) => r.label === "Layout")!;
    expect(layoutRow().disabled).toBe("a page with a layout — this one declares none");
    page.doc.document.$layout = "layouts/base.json";
    expect(layoutRow().disabled).toBeNull();
  });
});

describe("the preset menu, opened", () => {
  /** The rows of the popover the trigger opened — scoped to its own named slot, not the document. */
  function menuItems(): HTMLElement[] {
    const menu = document.querySelector('[aria-label="Show beside this pane"]');
    return menu ? ([...menu.querySelectorAll("sp-menu-item")] as HTMLElement[]) : [];
  }

  test("the trigger opens it, a row runs its command with its arguments, and it dismisses", async () => {
    lensGrid();
    paneContext.mount(primaryHost, makeCtx());
    await flush();
    const trigger = primaryHost.querySelector(".pc-derive-trigger") as HTMLElement;

    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    const rows = menuItems();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((row) => row.textContent?.trim())).toContain("Layout");

    // A row that CAN run does; the menu closes either way.
    const layout = rows.find((row) => row.textContent?.trim() === "Layout")!;
    layout.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(menuItems()).toHaveLength(0);
  });

  test("a disabled row runs nothing — the reason is on the row, not a missing row", async () => {
    const page = lensGrid();
    page.session.ui.canvasMode = "source";
    paneContext.mount(primaryHost, makeCtx());
    await flush();
    (primaryHost.querySelector(".pc-derive-trigger") as HTMLElement).dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    await flush();
    const code = menuItems().find((row) => row.textContent?.trim() === "Code")!;
    expect(code.hasAttribute("disabled")).toBe(true);
    code.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    // Still one lens — the one the fixture made — and no second derivation was published.
    expect(derivationOfPane(SECONDARY_PANE)?.preset).toBe("code");
  });

  /* …AND IT DOES NOT TAKE THE KEYBOARD ON THE WAY. The assertion above cannot see the guard at
     all: `pane.derive` refuses the same row twice more on its own — `enablement` reads the focused
     pane and `run` re-asks {@link presetRefusal} — so a disabled row that DID run still published
     nothing, and the state was identical either way. What the guard alone buys is everything the
     handler does BEFORE the command: `focusPane(row.pane)`, which moves the author's keyboard into
     a pane on the strength of a row that cannot act, and a `CommandUnavailableError` thrown out of
     a click listener. The focus is the observable half, and it is the user-visible one. */
  test("a disabled row does not even take the focus — the whole click is inert", async () => {
    twoPaneGrid();
    paneContext.attachPaneChromeHost(SECONDARY_PANE, sideHost);
    paneContext.mount(primaryHost, makeCtx());
    await flush();
    expect(workspace.activePaneId).toBe(PRIMARY_PANE);

    // The SIDE pane's own menu, opened without a pointerdown — the keyboard path (see FINDING 3).
    (sideHost.querySelector(".pc-derive-trigger") as HTMLElement).dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    await flush();
    // `scratch.json` declares no layout, so this row is refused before the command is reached.
    const layout = menuItems().find((row) => row.textContent?.trim() === "Layout")!;
    expect(layout.hasAttribute("disabled")).toBe(true);

    layout.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();

    expect(workspace.activePaneId).toBe(PRIMARY_PANE);
    expect(derivationOfPane(SECONDARY_PANE)).toBeNull();
  });

  /* FINDING 3. The previous round made the row's ANSWER a pure function of the pane and left its
     ACTION resolving the focus: `pane.derive`'s `run` is `activePane()` / `sidePane()`, and
     `pane.unsplit`'s is `workspace.activePaneId`. So a row read off the SECONDARY pane's menu, and
     correctly reported as enabled for the secondary, derived from the PRIMARY when pressed — and
     `PresetRow` carried no pane, so a row could not even say what it was about.

     Reachable by keyboard and only by keyboard, which is why a browser pass missed it:
     `panels/pane-grid.ts` focuses a pane on POINTERDOWN, and a keyboard activation of a menu item
     fires `click` alone. The probe:

       keyboard: the SECONDARY's Code row says disabled = null; focus before = primary; ran
       after: secondary derived from "primary" — the author's own document moved away

     `click` with no `pointerdown` first is exactly that keyboard activation. */
  test("a row runs against the pane whose menu it is in, not the pane holding the keyboard", async () => {
    twoPaneGrid();
    paneContext.attachPaneChromeHost(SECONDARY_PANE, sideHost);
    paneContext.mount(primaryHost, makeCtx());
    await flush();
    expect(workspace.activePaneId).toBe(PRIMARY_PANE);

    const trigger = sideHost.querySelector(".pc-derive-trigger") as HTMLElement;
    expect(trigger).not.toBeNull();
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    const code = menuItems().find((row) => row.textContent?.trim() === "Code")!;
    expect(code.hasAttribute("disabled")).toBe(false);

    code.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();

    // The SECONDARY is the source of the projection, and the primary is the pane holding it.
    expect(derivationOfPane(PRIMARY_PANE)).toMatchObject({
      preset: "code",
      sourcePaneId: SECONDARY_PANE,
    });
    expect(derivationOfPane(SECONDARY_PANE)).toBeNull();
    // …and the row said so before it ran, which is the half `PresetRow` could not express.
    expect(paneContext.presetRows(SECONDARY_PANE).every((row) => row.pane === SECONDARY_PANE)).toBe(
      true,
    );
  });

  test("with no registry there is nothing to run, so nothing opens", async () => {
    lensGrid();
    setActiveRegistry(null);
    paneContext.mount(primaryHost, makeCtx());
    await flush();
    (primaryHost.querySelector(".pc-derive-trigger") as HTMLElement).dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    await flush();
    expect(menuItems()).toHaveLength(0);
  });
});

describe("the tab strip in a derived pane", () => {
  /* FINDING 7, the strip half. A COMPANION whose rule has not resolved owns no tab either — its
     document is not open YET, or the selection has nothing under it — and the strip's second
     branch drew `nothing`: no chip, no ✕, no way out, and `paneIsEmpty` will not collapse the pane
     because the derivation counts as a subject. Both assertions fail against the `kind === "lens"`
     branch alone. */
  test("an unresolved COMPANION draws its chip too, naming what it is a projection OF", async () => {
    lensGrid();
    setPaneDerivation(SECONDARY_PANE, {
      kind: "companion",
      preset: "component",
      reason: "Select an element inside a component to see its definition.",
      resolved: null,
      sourcePaneId: PRIMARY_PANE,
      status: "unavailable",
    });
    focusPane(SECONDARY_PANE);
    tabStrip.mount(stripHost);
    await flush();

    expect(stripHost.querySelector(".tab-derivation-preset")?.textContent?.trim()).toBe(
      "Component definition",
    );
    // The pane owns no tab, so "what it is a projection of" is the SOURCE pane's document.
    expect(stripHost.querySelector(".tab-derivation-of")?.textContent?.trim()).toBe("/");
    // …and the ✕ is there, which is the only way out of a pane that draws nothing.
    expect(stripHost.querySelector(".tab-strip-overflow")).not.toBeNull();
  });

  test("draws ONE derivation chip and no tab chips", async () => {
    lensGrid();
    /* `hostFor` falls back to the primary's host for a pane with no stamped region, and `render`
       gives a shared host to the FOCUSED pane — so focusing the lens is how a test with one host
       makes the lens the pane that draws. */
    focusPane(SECONDARY_PANE);
    tabStrip.mount(stripHost);
    await flush();

    expect(stripHost.querySelector(".tab-derivation")).not.toBeNull();
    expect(stripHost.querySelectorAll(".tab-strip-tab")).toHaveLength(0);
    // The chip names the projection AND the document it is a projection of.
    expect(stripHost.querySelector(".tab-derivation-preset")?.textContent?.trim()).toBe("Code");
    // `tabLabel` prints a page's ROUTE, and `pages/index.json` is the home route.
    expect(stripHost.querySelector(".tab-derivation-of")?.textContent?.trim()).toBe("/");
  });

  /* "no document" IS A NAME, and it is the one state the chip has no other way to say. A
     derivation whose source pane is showing nothing is a state `derivedTarget` composes an answer
     for ("The pane this one follows has no document open."), so the strip has to render it too —
     and the fallback is the only thing standing between that and a chip that reads
     "Diff vs HEAD ·" with nothing after it, or throws on `tabLabel(null)`. */
  test("a chip whose source pane shows nothing says so, rather than trailing off", async () => {
    lensGrid();
    focusPane(SECONDARY_PANE);
    tabStrip.mount(stripHost);
    await flush();
    expect(stripHost.querySelector(".tab-derivation-of")?.textContent?.trim()).toBe("/");

    // The pane this one follows loses its document — the welcome-screen state, beside a projection.
    paneById(PRIMARY_PANE)!.activeTabId = null;
    await flush();

    expect(stripHost.querySelector(".tab-derivation-of")?.textContent?.trim()).toBe("no document");
    // The chip's tooltip says the same thing, so hover and label cannot disagree.
    expect(stripHost.querySelector(".tab-derivation")?.getAttribute("title")).toBe(
      "Code · no document",
    );
  });

  /* A DERIVED PANE FORGETS WHICH TAB IT LAST SHOWED, and that is one line in the chip branch.
     `_lastActive` decides whether the strip scrolls its active chip into view, and a pane drawing
     a chip is showing no tab at all — so without the reset a pane that derives and comes straight
     back to the SAME document is never scrolled to it: the field still names that document and the
     comparison below the render finds nothing to do. The gesture is the ordinary one and it is why
     "comes straight back" is not contrived — `pane.derive` hands the side pane's tabs back to the
     pane the author is in (§18.4's "nothing is closed"), and a layout companion whose rule resolves
     to the file that was just handed over brings it right back. Driven through the command, with a
     real opener, because the sequence IS the test. */
  test("a derived pane forgets its last active tab, so coming back scrolls to it", async () => {
    const page = resetWorkspaceWithTab(
      { children: [{ tagName: "p" }], tagName: "div" },
      { documentPath: "pages/index.json", id: "pages/index.json" },
    );
    page.capabilities.modes = ["edit", "design", "preview", "source"];
    page.doc.document.$layout = "layouts/base.json";
    openTab({
      document: { tagName: "div" },
      documentPath: "layouts/base.json",
      id: "layouts/base.json",
    });
    expect(splitRight()?.id).toBe(SECONDARY_PANE);
    focusPane(PRIMARY_PANE);

    /* Scoped to the SIDE pane's host: the primary's strip scrolls too — it gains and loses the
       handed-back tab in the same gesture — so an unscoped counter answers "somebody scrolled",
       which is true either way. */
    const scrolled: Element[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
      scrolled.push(this);
    };
    const registry = createCommandRegistry({
      getContext: () => makeContext({ document: { open: true } }),
    });
    registry.registerAll(derivationCommands(openingDeps()));
    setActiveRegistry(registry);
    /* Its OWN host, stamped with the pane's strip region, so the side pane keeps drawing while the
       keyboard stays in the primary — `pane.derive`'s source is the FOCUSED pane, and one shared
       host draws the focused one. */
    const sideStripHost = document.createElement("div");
    sideStripHost.dataset.jxRegion = tabStrip.paneStripRegion(SECONDARY_PANE);
    document.body.append(sideStripHost);
    try {
      tabStrip.mount(stripHost);
      await flush();
      expect(sideStripHost.querySelectorAll(".tab-strip-tab")).toHaveLength(1);
      scrolled.length = 0;

      await registry.run("pane.derive", { preset: "layout" });
      await flush();

      // Back where it started, under a derivation — and the strip scrolled to it.
      expect(paneById(SECONDARY_PANE)!.activeTabId).toBe("layouts/base.json");
      expect(sideStripHost.querySelectorAll(".tab-strip-tab")).toHaveLength(1);
      expect(scrolled.filter((el) => sideStripHost.contains(el))).not.toHaveLength(0);
    } finally {
      Element.prototype.scrollIntoView = original;
      sideStripHost.remove();
    }
  });

  /* The chip is a BREAKPOINT lens's only name. `PRESET_LABELS.breakpoint` is the sentence fragment
     "Same page at", finished by the media — so a chip that dropped the media said "Same page at"
     and stopped, in the one pane whose entire purpose is being at a named size. Nothing asserted
     the finished label: the strip tests all use a Code lens, whose label is a whole word. */
  test("a breakpoint lens's chip finishes its sentence with the breakpoint", async () => {
    lensGrid();
    Object.assign(derivationOfPane(SECONDARY_PANE)!, {
      media: "tablet",
      mode: "design",
      preset: "breakpoint",
    });
    focusPane(SECONDARY_PANE);
    tabStrip.mount(stripHost);
    await flush();
    expect(stripHost.querySelector(".tab-derivation-preset")?.textContent?.trim()).toBe(
      "Same page at Tablet",
    );

    // The base lens says Base, which is a name and not an absence.
    Object.assign(derivationOfPane(SECONDARY_PANE)!, { media: null });
    await flush();
    expect(stripHost.querySelector(".tab-derivation-preset")?.textContent?.trim()).toBe(
      "Same page at Base",
    );
  });

  /* The same finding as the breakpoint chip, one preset along. `PRESET_LABELS.locale` is the
     fragment "Same page in", finished by the locale's autonym — and a companion is the family whose
     chip is NOT interchangeable with a tab chip, because the pane may be holding no tab yet. A chip
     that dropped the tag read "Same page in" over a document in a language it never named, which is
     the one thing the author opened the pane to be told. */
  test("a locale companion's chip finishes its sentence with the language", async () => {
    lensGrid();
    setPaneDerivation(SECONDARY_PANE, {
      kind: "companion",
      locale: "fr",
      preset: "locale",
      reason: "",
      resolved: null,
      sourcePaneId: PRIMARY_PANE,
      status: "loading",
    });
    focusPane(SECONDARY_PANE);
    tabStrip.mount(stripHost);
    await flush();

    expect(stripHost.querySelector(".tab-derivation-preset")?.textContent?.trim()).toBe(
      "Same page in français",
    );

    /* A record with no tag draws the em dash rather than trailing off — the same promise the "no
       document" fallback makes one test up. `pane.derive` refuses to build one, so this is the
       hand-built state a stale session or a bad argument could still produce. */
    Object.assign(derivationOfPane(SECONDARY_PANE)!, { locale: null });
    await flush();
    expect(stripHost.querySelector(".tab-derivation-preset")?.textContent?.trim()).toBe(
      "Same page in —",
    );
  });

  /* THE CHIP'S LABEL IS A RENDER INPUT, and re-deriving a pane rewrites it in place. `pane.derive`
     over a pane that is already derived is refused, but `applyDerivation` and the preset menu both
     mutate the record, and the strip's effect reads fifteen tab facts and two derivation ones —
     drop the `preset` read and the chip keeps the words it was painted with while the stage draws
     something else. The sibling `media` read has this test one function down; `kind` deliberately
     has none, because it cannot move without `preset` moving (see the read itself). */
  test("re-pointing a lens at another preset relabels its chip", async () => {
    lensGrid();
    focusPane(SECONDARY_PANE);
    tabStrip.mount(stripHost);
    await flush();
    expect(stripHost.querySelector(".tab-derivation-preset")?.textContent?.trim()).toBe("Code");

    Object.assign(derivationOfPane(SECONDARY_PANE)!, { mode: "git-diff", preset: "diff" });
    await flush();

    expect(stripHost.querySelector(".tab-derivation-preset")?.textContent?.trim()).toBe(
      "Diff vs HEAD",
    );
  });

  /* THE CHIP ROW'S OWN mousedown, and it is the only thing that can focus a derived pane from its
     strip. `panels/pane-grid.ts` focuses a pane on pointerdown over its CELL; a strip host lives
     inside that cell in the shipped shell, but the handler is what makes the gesture work in the
     one-stage shell §18.3 still hands between panes, and it is what the ✕ below depends on — drop
     it and every gesture in this row runs against whichever pane happens to hold the keyboard.
     Asked with a host per pane, because the assertion is about the UNFOCUSED pane's row and a
     shared host is given to the focused one by design. */
  test("mousedown on the chip row focuses ITS pane, not the one holding the keyboard", async () => {
    lensGrid();
    const sideStrip = document.createElement("div");
    sideStrip.dataset.jxRegion = tabStrip.paneStripRegion(SECONDARY_PANE);
    document.body.append(sideStrip);
    try {
      focusPane(PRIMARY_PANE);
      tabStrip.mount(stripHost);
      await flush();
      expect(sideStrip.querySelector(".tab-derivation")).not.toBeNull();

      (sideStrip.querySelector(".tab-strip-row") as HTMLElement).dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true }),
      );
      await flush();

      expect(workspace.activePaneId).toBe(SECONDARY_PANE);
    } finally {
      sideStrip.remove();
    }
  });

  test("its ✕ runs Unsplit — the lens's only exit — and clicking the row focuses the pane", async () => {
    lensGrid();
    focusPane(PRIMARY_PANE);
    tabStrip.mount(stripHost);
    await flush();
    // The primary draws into the shared host while it has focus; the row's mousedown is what moves
    // Focus to the pane a click lands in.
    (stripHost.querySelector(".tab-strip-row") as HTMLElement).dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true }),
    );
    await flush();
    focusPane(SECONDARY_PANE);
    await flush();

    const close = stripHost.querySelector(".tab-strip-overflow") as HTMLElement;
    expect(close).not.toBeNull();
    close.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    // Unsplit collapsed the grid and left the document standing.
    expect(workspace.panes.map((pane) => pane.id)).toEqual([PRIMARY_PANE]);
  });

  /* THE PROJECTION CLOSES, NOT THE PANE HOLDING THE AUTHOR'S WORK. A derivation is mintable in
     either direction — the test above in this file derives the PRIMARY from the secondary through
     the documented gesture — and `pane.unsplit`'s subject was "the pane beside me, unless I am in
     it". The chip's ✕ focuses its own pane first, so with a derived primary the command read the
     focus, saw `PRIMARY`, and closed the secondary:

       before: primary[pages/index.json]*companion  secondary[scratch.json]  focus=secondary
       after : primary[pages/index.json, scratch.json]                       focus=primary

     The author pressed the projection's exit and lost the pane they were working in. `closePane`
     will not remove the primary — it redirects to "collapse the other pane instead", which IS that
     outcome — so for the one pane that cannot leave the grid the exit is ending the derivation. */
  test("a derived PRIMARY exits by dropping its projection, and the other pane survives", async () => {
    twoPaneGrid();
    const layout = openTab({
      document: { tagName: "div" },
      documentPath: "layouts/base.json",
      focus: false,
      id: "layouts/base.json",
      paneId: PRIMARY_PANE,
    });
    setPaneDerivation(PRIMARY_PANE, {
      kind: "companion",
      preset: "layout",
      reason: "",
      resolved: "layouts/base.json",
      sourcePaneId: SECONDARY_PANE,
      status: "ready",
    });
    paneById(PRIMARY_PANE)!.activeTabId = layout.id;
    focusPane(SECONDARY_PANE);

    (activeRegistry() as { run: (id: string) => unknown }).run("pane.unsplit");

    // Both panes are still here, and the secondary still holds the document the author was in.
    expect(workspace.panes.map((pane) => pane.id)).toEqual([PRIMARY_PANE, SECONDARY_PANE]);
    expect(paneById(SECONDARY_PANE)!.tabOrder).toEqual(["scratch.json"]);
    // …and the projection is over: an ordinary pane holding an ordinary tab.
    expect(derivationOfPane(PRIMARY_PANE)).toBeNull();
    expect(paneById(PRIMARY_PANE)!.tabOrder).toContain("layouts/base.json");
  });

  /* A LENS owns no tab, so ending its derivation would leave the primary with no subject at all —
     §18.1 rule 3 — and the repair for an empty primary is the redirect above. That case therefore
     still collapses, which is what unsplitting a Code lens should give you: the document. */
  test("a derived PRIMARY that owns nothing collapses instead, leaving the document", async () => {
    twoPaneGrid();
    setPaneDerivation(PRIMARY_PANE, {
      diff: null,
      kind: "lens",
      media: null,
      mode: "source",
      preset: "code",
      reason: "",
      sourcePaneId: SECONDARY_PANE,
      status: "ready",
      zoom: 1,
    });
    paneById(PRIMARY_PANE)!.tabOrder = [];
    paneById(PRIMARY_PANE)!.activeTabId = null;
    focusPane(SECONDARY_PANE);

    (activeRegistry() as { run: (id: string) => unknown }).run("pane.unsplit");

    expect(workspace.panes.map((pane) => pane.id)).toEqual([PRIMARY_PANE]);
    expect(derivationOfPane(PRIMARY_PANE)).toBeNull();
    expect(paneById(PRIMARY_PANE)!.tabOrder).toContain("scratch.json");
  });
});

/* THE ONE STYLE CLAIM THIS FILE CAN MAKE, and it was an exclusion for a round because the claim
   above it — that the one-chip strip keeps the tab row's HEIGHT — is a computed height, and
   happy-dom lays nothing out. That is still true. But the RULE the height rests on is a
   DECLARATION, and happy-dom does resolve the cascade for declarations: `getComputedStyle` on an
   element in the document returns the padding and border a stylesheet gave it. The height is
   `packages/studio:verify`'s and a screenshot's; the declaration is here.

   It is not a tautology. The stylesheet is read from disk, the elements are the ones
   `derivationChipTpl` and `tabChip` actually emit, and the two are compared against each other
   rather than against numbers copied out of the CSS — so renaming `.tab-derivation` on either side,
   or letting the two boxes drift apart, is a failure. A `find` string in the mutation gate could
   check none of that: rename the class in all four places and it still matches once. */
describe("the derivation chip's box", () => {
  test("a derivation chip's row keeps the tab row's vertical box", async () => {
    const page = twoPaneGrid();
    page.doc.document.$layout = "layouts/base.json";
    const style = document.createElement("style");
    style.textContent = readFileSync(new URL("../styles/shell.css", import.meta.url), "utf8");
    document.head.append(style);
    const sideStripHost = document.createElement("div");
    sideStripHost.dataset.jxRegion = tabStrip.paneStripRegion(SECONDARY_PANE);
    document.body.append(sideStripHost);
    try {
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
      tabStrip.mount(stripHost);
      await flush();

      const chip = sideStripHost.querySelector(".tab-derivation");
      const tab = stripHost.querySelector(".tab-strip-tab");
      expect(chip).not.toBeNull();
      expect(tab).not.toBeNull();
      const chipBox = getComputedStyle(chip as Element);
      const tabBox = getComputedStyle(tab as Element);

      /* The chip's row is a `4px` inset plus the `2px` underline a tab chip reserves, so the two
         rows sit on one baseline grid. Asserted as an equality — the numbers are the tab chip's,
         whatever they become — plus one absolute check, so a stylesheet that failed to load (every
         box `0px`, every equality trivially true) cannot pass. */
      expect([chipBox.paddingTop, chipBox.paddingBottom, chipBox.borderBottomWidth]).toEqual([
        tabBox.paddingTop,
        tabBox.paddingBottom,
        tabBox.borderBottomWidth,
      ]);
      expect(tabBox.paddingTop).toBe("4px");
      expect(tabBox.borderBottomWidth).toBe("2px");
    } finally {
      style.remove();
      sideStripHost.remove();
    }
  });
});

describe("what a lens does NOT draw", () => {
  test("no Document Header card — it is an editing surface over a document this pane does not own", () => {
    const page = lensGrid();
    /* The gate is `derivationOfPane(paneId)?.kind !== "lens"` inside `renderCanvasImpl`, so the
       test states the two halves it composes: the document HAS a header, and the pane is a lens. */
    expect(hasDocumentHeader(page)).toBe(true);
    expect(derivationOfPane(SECONDARY_PANE)?.kind).toBe("lens");
  });

  test("the jump bar's leading verb becomes Keep, and a lens refuses it", () => {
    const page = lensGrid();
    const derived = derivationOfPane(SECONDARY_PANE);
    const [, file] = jumpSegments(page, derived);
    expect(file).toMatchObject({ command: "pane.pin", kind: "file" });
    // An ordinary pane still offers Open.
    const [, ordinary] = jumpSegments(page, null);
    expect(ordinary).toMatchObject({ command: "palette.openFiles" });
  });

  test("a lens pane owns no tab, so nothing in the strip can close a document", () => {
    lensGrid();
    expect(paneById(SECONDARY_PANE)!.tabOrder).toEqual([]);
    expect(workspace.panes.flatMap((pane) => pane.tabOrder)).toEqual([
      "pages/index.json",
      "scratch.json",
    ]);
  });

  /* NOR THE READ-ONLY BANNER, which is a statement about a COLLAB SESSION the source tab is in.
     `readOnlyBannerTemplate(tab)` takes the tab the pane is DISPLAYING, and a lens displays the
     pane's document beside it — so the banner appeared twice, once in the pane whose session it
     describes and once under a projection that publishes nothing to anybody. The suppression is
     one ternary in `paneChromeTemplate` and both halves have to be asserted: the banner is drawn
     where it belongs, and only there. */
  test("no read-only banner — the collab session belongs to the pane beside it", async () => {
    const page = lensGrid();
    const state = collabState(page);
    state.active = true;
    state.readOnly = true;
    try {
      paneContext.attachPaneChromeHost(SECONDARY_PANE, sideHost);
      paneContext.mount(primaryHost, makeCtx());
      await flush();

      expect(primaryHost.querySelectorAll('[data-kind="read-only"]')).toHaveLength(1);
      expect(sideHost.querySelectorAll('[data-kind="read-only"]')).toHaveLength(0);
    } finally {
      state.active = false;
      state.readOnly = false;
    }
  });
});

describe("what a lens's chrome reads about ITS pane", () => {
  /* THE POD IS DRAWN FROM `derived.mode`, and the bar's own comment used to deny it — it listed
     `mode` among the derivation fields "no template here reads at all". `zoomPodTpl` asks
     `canvasModeOfPane`, which for a lens answers the derivation's mode, and that answer decides
     whether the pod exists: `source` has no pan-zoom surface, `design` has one. Same pane, same
     tab, one field changed. The deletion of the `void` reads was still right — `render()` runs
     inside the bar's effect, so a value a template reads is already a dependency, which this test
     also demonstrates by not touching anything else. */
  test("the pod is drawn from the LENS's mode, not from the tab's", async () => {
    lensGrid();
    paneContext.attachPaneChromeHost(SECONDARY_PANE, sideHost);
    paneContext.mount(primaryHost, makeCtx());
    await flush();
    // A Code lens: no panzoom surface, so no pod.
    expect(sideHost.querySelectorAll(".pane-zoom")).toHaveLength(0);

    (derivationOfPane(SECONDARY_PANE) as { mode: string }).mode = "design";
    await flush();

    expect(sideHost.querySelectorAll(".pane-zoom")).toHaveLength(1);
  });

  /* THE BUTTONS TAKE A SURFACE, not just the readout. Every zoom verb defaults its `surface`
     argument to `activeCanvasSurface()` — the FOCUSED pane's — so an unfocused lens's `−` read the
     focused pane's scale, divided that, and wrote the result onto the focused pane's tab: the
     author pressed zoom-out on the projection and the document beside it shrank. The readout is
     covered above; these are the two controls that WRITE, and they are separate expressions. */
  test("the zoom buttons drive THIS pane's stage, not the focused one", async () => {
    const page = lensGrid();
    const derived = derivationOfPane(SECONDARY_PANE)!;
    Object.assign(derived, { media: null, mode: "design", preset: "breakpoint", zoom: 1 });
    page.session.ui.zoom = 2;
    paneContext.attachPaneChromeHost(SECONDARY_PANE, sideHost);
    paneContext.mount(primaryHost, makeCtx());
    await flush();
    // The keyboard is in the pane that OWNS the document, which is the whole hazard.
    expect(workspace.activePaneId).toBe(PRIMARY_PANE);

    const lensZoom = () => (derivationOfPane(SECONDARY_PANE) as { zoom: number }).zoom;

    zoomControl(sideHost, "Zoom out").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(lensZoom()).toBeCloseTo(1 / 1.2, 5);
    expect(page.session.ui.zoom).toBe(2);

    zoomControl(sideHost, "Zoom in").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(lensZoom()).toBeCloseTo(1, 5);
    expect(page.session.ui.zoom).toBe(2);
  });
});
