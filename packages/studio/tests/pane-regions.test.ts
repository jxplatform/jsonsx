import { standUpPaneGrid } from "./harness";
import { afterEach, describe, expect, test } from "bun:test";
import {
  REGION_ATTR,
  SHELL_REGION_HOSTS,
  listRegions,
  paneRegion,
  paneStripRegion,
  resolveAllRegions,
} from "../src/ui/regions";
import { allCanvasSurfaces, unregisterCanvasSurface } from "../src/canvas/surface-registry";
import {
  ALLOWED_ACTIVE_TAB_READS,
  ALLOWED_SINGLE_INSTANCE,
  ALLOWED_VIEW_READS,
  BANNED_VIEW_FIELDS,
  checkPaneSingletons,
  countPerFile,
  diffAgainstAllowed,
  report,
} from "../scripts/check-pane-singletons";

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

afterEach(() => {
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
   * The highest-value assertion in the workstream, and it fails on the literal stamps by
   * construction: it stands up two stages, has each of them emit the SAME part, and demands that
   * every non-overlay id in the document resolve to exactly one element.
   *
   * It converts a silent screenshot regression — the `screenshots` lane produces a bot commit, not
   * a red X — into a red unit test in the PR that causes it.
   */
  function stamp(host: HTMLElement, paneId: string, part: string): void {
    const el = document.createElement("div");
    el.setAttribute(REGION_ATTR, paneRegion(paneId, part));
    host.append(el);
  }

  test("every pane-surface id resolves to exactly one element", () => {
    const primary = standUpPaneGrid("primary");
    const secondary = standUpPaneGrid("secondary");
    primary.wrap.setAttribute(REGION_ATTR, paneRegion("primary"));
    secondary.wrap.setAttribute(REGION_ATTR, paneRegion("secondary"));
    // The seven manifest-named ids that stage CONTENT emits, drawn in both panes at once.
    for (const part of [
      "library",
      "library/dropZone",
      "entry",
      "entry/fields",
      "editor",
      "frontmatter",
      "prop:count",
    ]) {
      stamp(primary.wrap, "primary", part);
      stamp(secondary.wrap, "secondary", part);
    }

    const ambiguous = listRegions().filter(
      (id) => !id.startsWith("overlay") && resolveAllRegions(id).length !== 1,
    );
    expect(ambiguous).toEqual([]);
    // And both panes really are addressable, so the test is not passing by drawing nothing.
    expect(listRegions()).toContain("pane.secondary/library");
    expect(listRegions()).toContain("pane.primary/library");
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

  test("a path that no longer exists counts as zero, not as a crash", async () => {
    /* Both lists name PATHS. A checker that threw on a renamed file would be one nobody could run
       to find out whether the rule still holds — which is the state it would be reporting on. */
    const counts = await countPerFile(["src/does/not/exist.ts"], /let active\b/g);
    expect([...counts]).toEqual([]);
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
