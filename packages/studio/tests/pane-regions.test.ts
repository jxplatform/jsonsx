import { flush, installMockPlatform, resetStudioState } from "./harness";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render as litRender } from "lit-html";
import {
  REGION_ATTR,
  SHELL_REGION_HOSTS,
  listRegions,
  paneRegion,
  paneStripRegion,
  resolveAllRegions,
  resolveRegion,
  stampShellRegions,
} from "../src/ui/regions";
import { allCanvasSurfaces, unregisterCanvasSurface } from "../src/canvas/surface-registry";
import {
  PRIMARY_PANE,
  SECONDARY_PANE,
  closeAllTabs,
  openTab,
  splitRight,
} from "../src/workspace/workspace";
import * as paneGrid from "../src/panels/pane-grid";
import * as paneContext from "../src/panels/pane-context";
import * as frontmatter from "../src/panels/frontmatter-panel";
import { renderFieldRow } from "../src/ui/field-row";
import { invalidateMediaCache, renderMediaPicker } from "../src/ui/media-picker";
import { resetShellSurfaces } from "../src/shell";
import {
  ALLOWED_ACTIVE_TAB_READS,
  ALLOWED_FOCUS_IN_PANE_SCOPE,
  ALLOWED_SINGLE_INSTANCE,
  ALLOWED_VIEW_READS,
  BANNED_VIEW_FIELDS,
  checkPaneSingletons,
  countFocusInPaneScope,
  countPerFile,
  diffAgainstAllowed,
  focusReadsInPaneScope,
  report,
} from "../scripts/check-pane-singletons";

const { happyDOM } = globalThis as unknown as { happyDOM: { setURL: (u: string) => void } };
happyDOM.setURL("http://localhost:3000/");

/**
 * The region grammar's fourth derived family, and the guard that keeps it derived.
 *
 * The manifest's `nonDerivedRegions` budget is at its ceiling (12/12) and seven of the ids it names
 * are drawn by stage CONTENT — `pane.primary/library`, `/entry:*`, `/editor`, `/frontmatter`,
 * `/prop:*`. Every one was the literal string `pane.primary`, emitted from a renderer that could
 * only ever be drawing one pane. The moment two stages exist they resolve to two elements and
 * `resolveRegion` takes the LAST, so a shot cropping "the Library" would photograph the side
 * pane's.
 *
 * The property that makes the manifest need no edit: for the primary, the derived id is
 * byte-identical to the literal it replaces.
 */

beforeEach(() => {
  resetStudioState();
  installMockPlatform();
  invalidateMediaCache();
  closeAllTabs();
});

afterEach(() => {
  resetShellSurfaces();
  for (const surface of allCanvasSurfaces()) {
    unregisterCanvasSurface(surface.paneId);
  }
  document.body.innerHTML = "";
});

describe("paneRegion", () => {
  test("reproduces the primary's literal ids byte for byte — this is why no shot moved", () => {
    expect(paneRegion("primary")).toBe("pane.primary");
    expect(paneStripRegion("primary")).toBe("pane.primary/tabs");
    for (const part of [
      "context",
      "zoom",
      "jump",
      "frontmatter",
      "editor",
      "library",
      "library/dropZone",
      "entry",
      "entry/fields",
      "prop:count",
      "entry:posts",
    ]) {
      expect(paneRegion("primary", part)).toBe(`pane.primary/${part}`);
    }
  });

  test("mints the side pane's ids without touching the primary's", () => {
    expect(paneRegion("secondary")).toBe("pane.secondary");
    expect(paneRegion("secondary", "tabs")).toBe("pane.secondary/tabs");
    expect(paneRegion("secondary", "library")).toBe("pane.secondary/library");
  });
});

describe("the shell host table", () => {
  test("no longer claims the stage or the strip — a pane cannot be an application row", () => {
    expect(Object.values(SHELL_REGION_HOSTS)).not.toContain("pane.primary");
    expect(Object.values(SHELL_REGION_HOSTS)).not.toContain("pane.primary/tabs");
    expect(Object.keys(SHELL_REGION_HOSTS)).not.toContain("#canvas-wrap");
    expect(Object.keys(SHELL_REGION_HOSTS)).not.toContain("#tab-strip");
  });
});

describe("uniqueness with two stages standing", () => {
  /*
   * The highest-value assertion in the workstream, and until now it was true BY CONSTRUCTION.
   *
   * It stood up two divs and stamped them with ids it minted by calling `paneRegion(paneId, part)`
   * itself, so "every id resolves to one element" was a restatement of "`paneRegion` returns
   * different strings for different panes" — which the block above already proves. No renderer was
   * imported, so nothing it could observe was capable of emitting a literal `pane.primary/…`, which
   * is the regression its own docstring describes. `ui/media-picker.ts` then stamped
   * `inspector/field:${prop}/browse` on a control the Document Header card draws inside EVERY
   * pane's stage, and this file was green through all of it.
   *
   * So the DOM comes from the app: the real pane grid builds the cells, the real context bar draws
   * ⑦ and ⑩ into each, and the real Document Header card draws into each stage. Every id in the
   * document is then one some renderer actually emitted.
   */
  const paneCtx = {
    exportFile: () => {},
    parseMediaEntries: () => ({ baseWidth: 1280, featureQueries: [], sizeBreakpoints: [] }),
    setCanvasMode: () => {},
  } as unknown as Parameters<typeof paneContext.mount>[1];

  /** A tab with enough head material that the Document Header card draws its SEO block. */
  function openDocTab(id: string, path: string) {
    return openTab({
      document: {
        $head: [
          { attributes: { href: "/favicon.png", rel: "icon" }, tag: "link" },
          { attributes: { content: "/og.png", property: "og:image" }, tag: "meta" },
        ],
        children: [],
        tagName: "div",
        title: "A page",
      },
      documentPath: path,
      id,
    });
  }

  /** The whole shell, both panes, every renderer that stamps a pane-scoped id. */
  async function twoRealPanes() {
    document.body.innerHTML = `<div id="app"><div id="pane-grid"></div><div id="right-panel"></div></div>`;
    stampShellRegions();
    paneGrid.mount();
    openDocTab("regions-left", "pages/left.json");
    openDocTab("regions-right", "pages/right.json");
    expect(splitRight()?.id).toBe(SECONDARY_PANE);
    await flush();

    paneContext.mount(paneGrid.cellForPane(PRIMARY_PANE)!.chrome, paneCtx);
    frontmatter.mount();
    for (const paneId of [PRIMARY_PANE, SECONDARY_PANE]) {
      const cell = paneGrid.cellForPane(paneId)!;
      if (paneId !== PRIMARY_PANE) {
        paneContext.attachPaneChromeHost(paneId, cell.chrome);
      }
      /* Only if the stage's own render has not already handed the card a host. The canvas render
         a new cell schedules mounts one for itself, and attaching a second is how a FIXTURE mints
         the very ambiguity this file is here to detect. */
      if (!frontmatter.documentHeaderHost(paneId)) {
        const card = document.createElement("div");
        cell.stage.append(card);
        frontmatter.attachDocumentHeaderHost(paneId, card);
      }
    }
    frontmatter.render();
    await flush(4);
  }

  afterEach(() => {
    frontmatter.unmount();
    paneContext.unmount();
    paneGrid.unmount();
    closeAllTabs();
  });

  test("every region id the app emits resolves to exactly one element", async () => {
    await twoRealPanes();
    const ids = listRegions();
    const ambiguous = ids.filter(
      (id) => !id.startsWith("overlay") && resolveAllRegions(id).length !== 1,
    );
    console.log(
      `[pane regions] two real panes emitted ${ids.length} region id(s); ` +
        `ambiguous: ${JSON.stringify(ambiguous)}`,
    );
    expect(ambiguous).toEqual([]);
    // And it is not passing by drawing nothing: both panes' stages, strips and bars are addressable.
    for (const id of [
      "pane.primary",
      "pane.secondary",
      "pane.primary/tabs",
      "pane.secondary/tabs",
      "pane.primary/context",
      "pane.secondary/context",
      "pane.primary/frontmatter",
      "pane.secondary/frontmatter",
    ]) {
      expect(ids).toContain(id);
    }
  });

  test("the Document Header's media pickers claim no `inspector/…` id", async () => {
    /* `ui/media-picker.ts` stamped `inspector/field:<prop>/browse` on its Browse button, and the
       Document Header card draws that picker for Icon and og:image inside each pane's STAGE. Two
       panes, two cards, four buttons — and `resolveRegion` takes the LAST, so the id answered with
       the SIDE pane's control, for a field that is not in the Inspector at all. `paneRegion` was
       never going to reach it: an `inspector/…` id on an element outside the Inspector is a wrong
       id, not a wrongly-scoped one. */
    await twoRealPanes();
    const cards = [...document.querySelectorAll(".doc-header")];
    expect(cards).toHaveLength(2);
    const browseButtons = [...document.querySelectorAll(".pane-stage .media-picker-browse")];
    expect(browseButtons.length).toBeGreaterThanOrEqual(4);
    // Not one of them carries a region id, and none of them answers to the Inspector's.
    for (const button of browseButtons) {
      expect(button.getAttribute(REGION_ATTR)).toBeNull();
    }
    expect(listRegions().filter((id) => id.startsWith("inspector/field:"))).toEqual([]);
    expect(resolveRegion("inspector/field:icon/browse")).toBeNull();
    console.log(
      `[pane regions] ${browseButtons.length} Document Header Browse control(s) across 2 panes, ` +
        `0 of them stamped; resolveRegion("inspector/field:icon/browse") = ` +
        `${String(resolveRegion("inspector/field:icon/browse"))}`,
    );
  });

  test("`inspector/field:<prop>/browse` is DERIVED, and finds the Inspector's own control", async () => {
    await twoRealPanes();
    // The Inspector's row, built by the same two functions the properties panel uses.
    const inspector = document.querySelector("#right-panel") as HTMLElement;
    litRender(
      renderFieldRow({
        hasValue: true,
        label: "Image",
        prop: "image",
        widget: renderMediaPicker("image", "/hero.png", () => {}),
      }),
      inspector,
    );
    const own = inspector.querySelector<HTMLElement>(".media-picker-browse");
    expect(own).not.toBeNull();
    expect(resolveRegion("inspector/field:image/browse")).toBe(own);
    // The bare field id still answers with the row, exactly as it always has.
    expect(resolveRegion("inspector/field:image")?.dataset.prop).toBe("image");
    // A prop the Inspector is not showing resolves to nothing rather than to a card's control.
    expect(resolveRegion("inspector/field:icon/browse")).toBeNull();
  });
});

describe("the singleton guard", () => {
  test("names every field that moved onto the surface", () => {
    expect([...BANNED_VIEW_FIELDS]).toEqual([
      "panzoomWrap",
      "centerObserver",
      "needsCenter",
      "panX",
      "panY",
      "monacoEditor",
      "renderGeneration",
    ]);
  });

  test("both allow-lists are empty — the inventory is cleared, not budgeted", () => {
    expect(ALLOWED_VIEW_READS).toEqual({});
    expect(ALLOWED_SINGLE_INSTANCE).toEqual({});
  });

  test("the third rule is the general one: stage geometry may not consult the focus", () => {
    /* `BANNED_VIEW_FIELDS` is a list of NAMES, and the pan/zoom scale was never one of them — it
       was injected into `canvas/canvas-utils.ts` as `getZoom`/`setZoomDirect`, both spelled
       `activeTab.value`, so this checker was green through the whole of P8 while the unfocused
       pane drew at the focused tab's scale. The rule that replaces the omission is "per-stage
       state is reached through a surface", and its mechanical form is that the geometry module
       does not read `activeTab`. The two allowed occurrences are the import and `requireTab`, in
       the canvas view COMMANDS, whose subject is the focused pane by definition. */
    expect(ALLOWED_ACTIVE_TAB_READS).toEqual({ "src/canvas/canvas-utils.ts": 2 });
  });

  test("it counts a focused-tab read where the geometry lives", async () => {
    const counts = await countPerFile(["src/canvas/canvas-utils.ts"], /\bactiveTab\b/g);
    expect(counts.get("src/canvas/canvas-utils.ts")).toBe(2);
    // And the injected getters really are gone — the seam the four failures hid behind.
    const nothingInjected = await countPerFile(
      ["src/canvas/canvas-utils.ts"],
      /\b(initCanvasUtils|setZoomDirect)\b/g,
    );
    expect([...nothingInjected]).toEqual([]);
  });

  test("passes against the tree it guards", async () => {
    expect(await checkPaneSingletons()).toEqual([]);
  });

  test("the fourth rule is the general one: a function GIVEN a pane may not ask for the focus", () => {
    /* Rules 1 and 2 are lists of names, rule 3 is a list of files, and each was written after a
       failure the next one walked straight past. This is the sentence all four were reaching for:
       a function that has been told which pane it is about does not get to consult the focus. */
    expect(ALLOWED_FOCUS_IN_PANE_SCOPE).toEqual({});
  });

  test("it counts a focus read in the BODY of a pane-scoped function, and only there", () => {
    // The shape the pane context bar had: drawn per pane, resolving through the focused tab.
    expect(
      focusReadsInPaneScope(`
        function renderPane(paneId: string, host: HTMLElement) {
          const tab = activeTab.value;
          host.textContent = tab?.id ?? "";
        }
      `),
    ).toBe(1);
    // The shape `renderStylebookMode` had — a surface in, the focused tab consulted anyway.
    expect(
      focusReadsInPaneScope(`
        export function renderStylebookMode(surface: CanvasSurface, ctx: StylebookCtx) {
          const tab = activeTab.value;
          return tab;
        }
      `),
    ).toBe(1);
    // And the mode read, which is the same defect one layer down.
    expect(
      focusReadsInPaneScope(`
        function exportTpl(paneId: string, ctx: Ctx) {
          return ctx.getCanvasMode() === "source";
        }
      `),
    ).toBe(1);
  });

  test("a DEFAULT is the opposite of the defect, and is not counted", () => {
    /* `surface: CanvasSurface = activeCanvasSurface()` is a signature saying, in public, "the
       focused pane when you do not say" — eleven of the geometry verbs are written that way on
       purpose, and a rule that fired on them would be one nobody could keep green. */
    expect(
      focusReadsInPaneScope(`
        export function resetZoom(surface: CanvasSurface = activeCanvasSurface()) {
          surface.panX = 0;
        }
      `),
    ).toBe(0);
  });

  test("a function that takes only a TAB is not pane-scoped — it may ask whether it is focused", () => {
    expect(
      focusReadsInPaneScope(`
        export function isTabActive(tab: Tab | null): boolean {
          return tab !== null && activeTab.value === tab;
        }
      `),
    ).toBe(0);
  });

  test("the module that OWNS focus is excluded rather than allow-listed", async () => {
    /* `focusPane` and `closePane` both take a `paneId` and both WRITE `workspace.activePaneId` —
       that is the definition of moving focus. Putting the one legitimate writer in a table of
       things that must not come back would be a lie about what the table is. */
    const owner = await Bun.file("src/workspace/workspace.ts").text();
    expect(focusReadsInPaneScope(owner)).toBeGreaterThan(0);
    const counted = await countFocusInPaneScope(["src/workspace/workspace.ts"]);
    expect(counted.size).toBe(0);
  });

  test("a path that no longer exists counts as zero, not as a crash", async () => {
    /* Both lists name PATHS. A checker that threw on a renamed file would be one nobody could run
       to find out whether the rule still holds — which is the state it would be reporting on. */
    const counts = await countPerFile(["src/does/not/exist.ts"], /let active\b/g);
    expect([...counts]).toEqual([]);
    // The fourth rule reads the same files and owes the same answer.
    expect([...(await countFocusInPaneScope(["src/does/not/exist.ts"]))]).toEqual([]);
  });

  test("`report` says which rule broke and hands back an exit code", () => {
    const errors: string[] = [];
    const logs: string[] = [];
    const realError = console.error;
    const realLog = console.log;
    console.error = (line: string) => errors.push(line);
    console.log = (line: string) => logs.push(line);
    try {
      expect(report([])).toBe(0);
      expect(logs.at(-1)).toContain("no per-stage state");
      expect(report(["src/view.ts: 1 per-stage `view.*` read(s), 0 allowed"])).toBe(1);
    } finally {
      console.error = realError;
      console.log = realLog;
    }
    // The failure NAMES the file and points at where the state belongs — a checker that only said
    // "failed" would send the next reader back to the source to find out what it meant.
    expect(errors.join("\n")).toContain("src/view.ts: 1 per-stage");
    expect(errors.join("\n")).toContain("src/canvas/surface-registry.ts");
  });

  test("fails BOTH ways — a new occurrence, and a stale entry", () => {
    const overBudget = diffAgainstAllowed(new Map([["a.ts", 2]]), { "a.ts": 1 }, "thing(s)");
    expect(overBudget).toHaveLength(1);
    expect(overBudget[0]).toContain("2 thing(s), 1 allowed");

    const stale = diffAgainstAllowed(new Map(), { "b.ts": 3 }, "thing(s)");
    expect(stale).toHaveLength(1);
    expect(stale[0]).toContain("ratchet the entry down");

    expect(diffAgainstAllowed(new Map([["c.ts", 1]]), { "c.ts": 1 }, "thing(s)")).toEqual([]);
  });
});
