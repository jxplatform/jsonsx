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
  analyzeFocusScope,
  ALLOWED_FOCUS_IN_PANE_SCOPE,
  ALLOWED_FOCUS_WRITES,
  ALLOWED_SINGLE_INSTANCE,
  ALLOWED_VIEW_READS,
  BANNED_VIEW_FIELDS,
  checkPaneSingletons,
  countFocusInPaneScope,
  countPerFile,
  describeFocusSites,
  diffAgainstAllowed,
  FOCUS_NAMES,
  FOCUS_WRITE_RE,
  focusSitesInPaneScope,
  report,
  withFocusDetail,
} from "../scripts/check-pane-singletons";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  /*
   * 30s, and the number is the rule's own cost. Rule 4 parses every module under `src/` with the
   * TypeScript compiler rather than matching a regex over its text — ~2s standalone, and more under
   * `--coverage` on a loaded machine. Bun's 5s default is a budget for a unit test; this is a
   * compiler run, and the alternative to paying for it is the eight shapes a regex walks past.
   */
  test("passes against the tree it guards", async () => {
    expect(await checkPaneSingletons()).toEqual([]);
  }, 30_000);

  test("the fourth rule's residue is three entries, and each names what it is", () => {
    /* Rules 1 and 2 are lists of names, rule 3 is a list of files, and each was written after a
       failure the next one walked straight past. This is the sentence all four were reaching for:
       a function that has been told which pane it is about does not get to consult the focus.

       It was empty under the regex and has two entries under the AST rule, which is the rule
       working rather than the tree regressing: the bottom dock's function editor is app-level and
       its `container` is not a stage, and `renderCssVarsEditor` reaches the focus one hop away
       through `pushProjectStylesToCanvas()` — a real two-pane defect in `style/live-preview.ts`
       that no body scan could ever have named.

       The THIRD arrived with the `disabledReason`/`isEnabled` widening (§18.4's preset menu asked a
       registry — which resolves its context from the focus — about a pane it had been handed by
       name). It is `panels/jump-bar.ts`, and it is real debt of the same shape: `segmentTpl`
       renders every crumb's enablement from the registry, so an unfocused pane's address states the
       FOCUSED pane's answers. No crumb is visibly wrong today; `selection.*` is the one that will
       be, and the fix is the per-pane predicate the preset menu took, which the selection crumbs do
       not have yet. */
    expect(ALLOWED_FOCUS_IN_PANE_SCOPE).toEqual({
      "src/panels/editors.ts": 1,
      "src/panels/jump-bar.ts": 1,
      "src/settings/css-vars-editor.ts": 1,
    });
  });

  /* The widening itself, asserted where a reviewer can see what it now names. Rule 4 walks ONE hop
     into a subject-less local function; it cannot follow a method on a registry VALUE, dispatched
     by a string id to a closure registered in another module — that is type-directed whole-program
     dataflow through a runtime map. What it CAN decide from one identifier is that the question was
     asked at all, and asking it from a pane-scoped function is the defect whether or not the
     particular command happens to read the focus today. */
  test("asking a registry whether a command is enabled counts as a focus read", () => {
    expect([...FOCUS_NAMES]).toContain("disabledReason");
    expect([...FOCUS_NAMES]).toContain("isEnabled");
  });

  test("the fifth rule: only `focusPane` moves the focus, and its list is empty", async () => {
    /* Rules 1–4 all match READS, and for four rounds that was the whole shape being chased. The
       mirror image went unnamed for as long: `settings/settings-document.ts` set
       `workspace.activePaneId = pane.id` directly, which moves the keyboard without
       `resetTabCycle`, `promoteMru` or `syncTreeSelection` — so Ctrl-Tab still cycled from the pane
       the author had left, the MRU disagreed with the screen, and the tree kept pointing at the old
       pane's document. */
    expect(ALLOWED_FOCUS_WRITES).toEqual({});
    const writes = await countPerFile(
      ["src/**/*.ts"],
      FOCUS_WRITE_RE,
      "src/workspace/workspace.ts",
    );
    console.log(`[pane-singletons] focus writes outside workspace.ts: ${[...writes.keys()]}`);
    expect([...writes]).toEqual([]);
    // And the owner really does still write it — a rule whose only writer had vanished would be
    // Green for the wrong reason.
    const owner = await countPerFile(["src/workspace/workspace.ts"], FOCUS_WRITE_RE);
    expect(owner.get("src/workspace/workspace.ts")).toBeGreaterThan(0);
  });

  /**
   * The twenty-two shapes the rule is measured against, written to disk and parsed.
   *
   * Thirteen were the AST rule's original table; the last eight are the four blind spots the
   * widening closed, each with the counter-case that proves the widening did not swallow the brake
   * it narrowed. **A** is a pane object whose parameter is named `state` or `canvasEl` rather than
   * `pane`; **B** is the arity brake, which hid every helper that happened to take arguments; **C**
   * is a transparent forwarder, which laundered a focus read behind a name.
   *
   * On disk because the rule is an AST check now: it asks the TypeScript compiler for a source
   * file, and a compiler takes a path. They go to a temp directory rather than into `tests/`
   * precisely BECAUSE they are deliberately broken code — half of them would not type-check, and a
   * fixture that has to compile is a fixture that cannot hold the shape being tested.
   */
  const FIXTURES: { file: string; why: string; expected: number; source: string }[] = [
    // ── The four the regex already caught. They must keep being caught. ──
    {
      expected: 1,
      file: "plain.ts",
      source: `function renderPane(paneId: string, host: HTMLElement) {
          host.textContent = activeTab.value?.id ?? "";
        }`,
      why: "a plain function — the shape the pane context bar had",
    },
    {
      expected: 1,
      file: "arrow-block.ts",
      source: `const draw = (surface: CanvasSurface) => {
          return activeTab.value;
        };`,
      why: "an arrow with a block body",
    },
    {
      expected: 1,
      file: "method.ts",
      source: `class Stage {
          paint(paneId: string) {
            return activeTab.value;
          }
        }`,
      why: "a class method",
    },
    {
      expected: 1,
      file: "if-surface.ts",
      source: `function fit(surface: CanvasSurface) {
          if (surface) {
            return getCanvasMode();
          }
          return null;
        }`,
      why: "a read inside a branch, not directly in the body",
    },
    // ── The eight it walked past. ──
    {
      expected: 1,
      file: "arrow-template.ts",
      source: "const label = (paneId: string) => `pane ${paneId} ${activeTab.value?.id}`;",
      why: "an arrow whose body is a template literal — there is no `{` to match",
    },
    {
      expected: 1,
      file: "arrow-html.ts",
      source: "const row = (paneId: string) => html`<b>${activeTab.value?.id}</b>`;",
      why: "`=> html`…`` with no block — how half this package renders",
    },
    {
      expected: 1,
      file: "return-brace.ts",
      source: `function sizes(paneId: string): { w: number } {
          return { w: activeTab.value ? 1 : 0 };
        }`,
      why: "a return type containing a brace — the type's `{` closed the header",
    },
    {
      expected: 1,
      file: "return-fn-type.ts",
      source: `function bind(surface: CanvasSurface): (x: number) => void {
          return () => {
            void activeTab.value;
          };
        }`,
      why: "a return type that is a function type — the `=>` closed the header",
    },
    {
      expected: 1,
      file: "return-promise.ts",
      source: `async function load(paneId: string): Promise<{ id: string }> {
          return { id: activeTab.value?.id ?? "" };
        }`,
      why: "`Promise<{…}>` — the brace again, one generic deeper",
    },
    {
      expected: 1,
      file: "param-pane.ts",
      source: `function strip(pane: Pane) {
          return activePane().id;
        }`,
      why: "a parameter named `pane` — the name list held `paneId` only",
    },
    {
      expected: 1,
      file: "param-container.ts",
      source: `function mount(container: HTMLElement) {
          return getCanvasMode();
        }`,
      why: "a parameter named `container` — `paneOfContainer` is the derived route",
    },
    {
      expected: 0,
      file: "hop-reader.ts",
      source: `export function isPageDocument() {
          return Boolean(activeTab.value?.documentPath);
        }
        export default function isPageMode() {
          return getCanvasMode();
        }`,
      why: "the zero-argument readers themselves take no pane, so they are not the defect",
    },
    {
      expected: 2,
      file: "hop-caller.ts",
      source: `import isPageMode, { isPageDocument } from "./hop-reader";
        export function documentHeaderTemplate(tab: Tab, paneId: string) {
          return isPageDocument() ? isPageMode() : "";
        }`,
      why: "finding 3: focus reached through a HELPER, one hop away, named import and default",
    },
    // ── The four blind spots the widening closed. ──
    {
      expected: 1,
      file: "host-state.ts",
      source: `function onSelection(state: HostState) {
          state.selectionPath = activeTab.value?.session.selection?.[0] ?? null;
        }`,
      why: "A: a pane object whose parameter is named neither `pane` nor `surface`",
    },
    {
      expected: 1,
      file: "typed-only.ts",
      source: `export function label(h: DragHost, p: CanvasPanel) {
          return activeTab.value?.doc.document?.tagName ?? p.mediaName ?? h.tabId;
        }`,
      why: "A: the TYPE says it even when the name does not — `DragHost`, `CanvasPanel`",
    },
    {
      expected: 1,
      file: "canvas-el.ts",
      source: `export function mount(gen: number, doc: Doc, canvasEl: HTMLElement) {
          return { colorScheme: activeTab.value?.session.ui.previewColorScheme, gen };
        }`,
      why: "A: `canvasEl` is an artboard, and `tabOfContainer` is the route from it",
    },
    {
      expected: 0,
      file: "arity-reader.ts",
      source: `export function renderFmField(field: string, value: string) {
          return transactDoc(activeTab.value, () => value);
        }
        export function ghostLabel(src: Src, data: Data) {
          return activeTab.value?.doc.document?.tagName ?? "node";
        }`,
      why: "B: the readers themselves are subject-less, so the defect is at their call sites",
    },
    {
      expected: 2,
      file: "arity-caller.ts",
      source: `import { ghostLabel, renderFmField } from "./arity-reader";
        export function card(tab: Tab, paneId: string) {
          return [renderFmField("title", "x"), ghostLabel(src, data)];
        }`,
      why: "B: a helper with PARAMETERS is not a helper that was told which pane — the arity brake",
    },
    {
      expected: 1,
      file: "subject-reader.ts",
      source: `export function updateUi(tab: Tab, field: string) {
          return activeTab.value === tab ? field : "";
        }
        export function fitPane(paneId: string) {
          return activePane().id === paneId;
        }`,
      why: "B: the tab-scoped helper is exempt; the pane-scoped one is charged at its OWN site",
    },
    {
      expected: 0,
      file: "subject-caller.ts",
      source: `import { fitPane, updateUi } from "./subject-reader";
        export function bar(tab: Tab, paneId: string) {
          return [updateUi(tab, "zoom"), fitPane(paneId)];
        }`,
      why: "B: …so the brake still holds for the shapes it was written for",
    },
    {
      expected: 1,
      file: "forwarder.ts",
      source: `export function getActivePanel() {
          return activeCanvasSurface().panels[0] ?? activeTab.value;
        }
        export function revealScroller() {
          return getActivePanel()?.scrollContainer ?? null;
        }
        export function revealBy(surface: CanvasSurface, offsetY: number) {
          const scroller = revealScroller();
          return scroller ? scroller.scrollTop - offsetY : null;
        }`,
      why: "C: a transparent forwarder is one frame of stack, not one hop of reasoning",
    },
    {
      expected: 0,
      file: "not-a-forwarder.ts",
      source: `import { getActivePanel } from "./forwarder";
        export function summarise() {
          const panel = getActivePanel();
          const n = panel ? 1 : 0;
          return n;
        }
        export function draw(surface: CanvasSurface) {
          return summarise();
        }`,
      why: "C: two statements is a function with a decision in it — the walk stops there",
    },
  ];

  /** Write `sources` to a temp directory, analyse them, and hand back the counts by file name. */
  async function analyzeSources(
    sources: { file: string; source: string }[],
  ): Promise<Map<string, number>> {
    const dir = await mkdtemp(join(tmpdir(), "jx-pane-scope-"));
    try {
      const paths = sources.map((fixture) => join(dir, fixture.file));
      await Promise.all(
        sources.map(async (fixture, i) => writeFile(paths[i]!, fixture.source, "utf8")),
      );
      const found = await analyzeFocusScope(paths);
      return new Map(
        sources.map((fixture, i) => [fixture.file, found.get(paths[i]!)?.length ?? 0]),
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  }

  test("the AST rule catches all twenty-two shapes — the regex's eight and the widening's four", async () => {
    const counts = await analyzeSources(FIXTURES);
    const actual = FIXTURES.map((f) => `${f.file} → ${counts.get(f.file)} · ${f.why}`);
    const wanted = FIXTURES.map((f) => `${f.file} → ${f.expected} · ${f.why}`);
    expect(actual).toEqual(wanted);
  }, 30_000);

  test("a DEFAULT is the opposite of the defect, and is not counted", async () => {
    /* `surface: CanvasSurface = activeCanvasSurface()` is a signature saying, in public, "the
       focused pane when you do not say" — eleven of the geometry verbs are written that way on
       purpose, and a rule that fired on them would be one nobody could keep green. A parameter
       list is walked OUTSIDE the pane scope for exactly this reason. */
    const counts = await analyzeSources([
      {
        file: "default.ts",
        source: `export function resetZoom(surface: CanvasSurface = activeCanvasSurface()) {
            surface.panX = 0;
          }`,
      },
      {
        // A function that takes only a TAB may legitimately ask whether it is the focused one.
        file: "tab-only.ts",
        source: `export function isTabActive(tab: Tab | null): boolean {
            return tab !== null && activeTab.value === tab;
          }`,
      },
    ]);
    expect([...counts]).toEqual([
      ["default.ts", 0],
      ["tab-only.ts", 0],
    ]);
  }, 30_000);

  test("the module that OWNS focus is excluded rather than allow-listed", async () => {
    /* `focusPane` and `closePane` both take a `paneId` and both WRITE `workspace.activePaneId` —
       that is the definition of moving focus. Putting the one legitimate writer in a table of
       things that must not come back would be a lie about what the table is. */
    const seen = await analyzeFocusScope([join(process.cwd(), "src/workspace/workspace.ts")]);
    expect([...seen.values()][0]!.length).toBeGreaterThan(0);
    const counted = await countFocusInPaneScope(["src/workspace/workspace.ts"]);
    expect(counted.size).toBe(0);
  }, 30_000);

  test("a failure NAMES the site, and says when it is one hop away", async () => {
    /* A count alone sends the reader back to the source to find out what it meant — and the
       one-hop reads are the ones nobody would find, because the call site contains no focus name
       at all. */
    /* Both files: a hop can only be resolved when the module holding the reader is in the set,
       which is why the real run scans all of `src/` in one pass. */
    const sites = await focusSitesInPaneScope([
      "src/settings/css-vars-editor.ts",
      "src/style/live-preview.ts",
    ]);
    expect(describeFocusSites(sites, "src/settings/css-vars-editor.ts")).toContain(
      "pushProjectStylesToCanvas() (one hop)",
    );
    expect(describeFocusSites(sites, "src/nothing/here.ts")).toBe("");
  }, 30_000);

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

  test("the detail is appended to the failure line, not printed beside it", () => {
    const sites = new Map([
      ["src/a.ts", [{ line: 12, name: "activeTab", via: null }]],
      [
        "src/b.ts",
        [{ line: 88, name: "pushProjectStylesToCanvas()", via: "pushProjectStylesToCanvas" }],
      ],
    ]);
    expect(
      withFocusDetail(["src/a.ts: 1 focus read(s), 0 allowed", "src/c.ts: unrelated"], sites),
    ).toEqual([
      "src/a.ts: 1 focus read(s), 0 allowed — src/a.ts:12 activeTab",
      "src/c.ts: unrelated",
    ]);
    expect(withFocusDetail(["src/b.ts: x"], sites)).toEqual([
      "src/b.ts: x — src/b.ts:88 pushProjectStylesToCanvas() (one hop)",
    ]);
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
