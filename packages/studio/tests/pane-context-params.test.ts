/**
 * The context bar's route-param pickers, with TWO panes attached.
 *
 * One claim, and it is a liveness claim rather than a rendering one. The candidate values behind
 * `resolving with [sku] ⌄` were cached in a single slot (`_paramValues` + `_paramValuesKey`) while
 * `render()` loops every attached pane. Two panes showing pages under DIFFERENT dynamic routes
 * evicted each other on every pass — and because the load that landed called `render()`, which
 * re-issued both loads, the result was an unbounded microtask chain: no animation frame, no paint,
 * no keystroke. `⌘\` with two dynamic pages open was the whole reproduction.
 *
 * It cannot be caught by a one-pane test, by the type checker or by any lint rule: a `let` holding
 * one value is perfectly well-typed and perfectly correct until there are two of the thing.
 *
 * The mocked loader CAPS itself. Without the fix the chain never yields, so `await flush()` would
 * never resume and this file would hang rather than go red — the cap turns a hang into a failed
 * expectation, which is a test result somebody can read.
 */
import { flush, installMockPlatform, resetStudioState, resetWorkspaceWithTab } from "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Tab } from "../src/tabs/tab";

/** Every `loadParamValues` call this test provoked, by document path. */
const loadCalls: string[] = [];

/**
 * The point past which the loader stops answering.
 *
 * Above it every call returns a promise that never settles, which breaks the livelock so the
 * assertion below can fail with a number instead of timing out.
 */
const CAP = 40;

const realParams = await import("../src/page-params");

void mock.module("../src/page-params", () => ({
  ...realParams,
  loadParamValues: (documentPath: string | null) => {
    loadCalls.push(String(documentPath));
    if (loadCalls.length > CAP) {
      return new Promise(() => {});
    }
    return Promise.resolve(
      String(documentPath).includes("[sku]") ? { sku: ["alpha", "beta"] } : { id: ["1", "2"] },
    );
  },
}));

const paneContext = await import("../src/panels/pane-context");
const { PRIMARY_PANE, SECONDARY_PANE, closeAllTabs, openTab, splitRight, workspace } =
  await import("../src/workspace/workspace");

type Ctx = Parameters<typeof paneContext.mount>[1];

function makeCtx(): Ctx {
  return {
    exportFile: mock(() => {}),
    parseMediaEntries: mock(() => ({
      baseWidth: 1200,
      featureQueries: [] as { name: string; query: string }[],
      sizeBreakpoints: [] as { name: string; query: string; width: number; type: string }[],
    })),
    setCanvasMode: mock((_tab: Tab | null, _mode: string) => {}),
  } as Ctx;
}

let primaryHost: HTMLElement;
let sideHost: HTMLElement;

/** The labels of the param pickers a host painted, with the options each offers. */
function pickers(host: HTMLElement): { label: string; items: string[] }[] {
  return [...host.querySelectorAll("sp-picker.pc-param")].map((picker) => ({
    items: [...picker.querySelectorAll("sp-menu-item")].map((o) => o.textContent?.trim() ?? ""),
    label: picker.getAttribute("label") ?? "",
  }));
}

beforeEach(() => {
  loadCalls.length = 0;
  closeAllTabs();
  resetStudioState({ isSiteProject: true });
  installMockPlatform();
  paneContext.resetParamValues();
  primaryHost = document.createElement("div");
  sideHost = document.createElement("div");
  document.body.append(primaryHost, sideHost);
});

afterEach(() => {
  paneContext.unmount();
  primaryHost.remove();
  sideHost.remove();
  closeAllTabs();
});

/** Two panes, each on a page under a dynamic route of its own. */
async function twoDynamicPanes() {
  resetWorkspaceWithTab(
    { children: [], tagName: "div" },
    { documentPath: "pages/products/[sku].json", id: "sku-tab" },
  );
  // `openTab`, not a second `resetWorkspaceWithTab` — the reset closes every tab, and the whole
  // Subject here is two panes each holding one.
  openTab({
    document: { children: [], tagName: "div" },
    documentPath: "pages/posts/[id].json",
    id: "id-tab",
  });
  expect(splitRight()?.id).toBe(SECONDARY_PANE);
  paneContext.mount(primaryHost, makeCtx());
  paneContext.attachPaneChromeHost(SECONDARY_PANE, sideHost);
  await flush();
}

describe("two panes on dynamic routes", () => {
  test("each pane loads its own candidates ONCE, and neither evicts the other", async () => {
    await twoDynamicPanes();
    const afterMount = loadCalls.length;
    // Twenty idle turns. A one-slot cache re-issues on every pass, so the count is the assertion:
    // It has to stop growing the moment both answers are in.
    for (let turn = 0; turn < 20; turn += 1) {
      paneContext.render();
      await flush();
    }
    console.log(
      `[pane-context params] loadParamValues calls: after mount ${afterMount}, ` +
        `after 20 idle turns ${loadCalls.length} (cap ${CAP})`,
    );
    expect(afterMount).toBe(2);
    expect(loadCalls.length).toBe(2);
    expect([...loadCalls].toSorted()).toEqual([
      "pages/posts/[id].json",
      "pages/products/[sku].json",
    ]);
  });

  test("both bars fill — the unfocused pane's picker is not permanently empty", async () => {
    await twoDynamicPanes();
    for (let turn = 0; turn < 3; turn += 1) {
      paneContext.render();
      await flush();
    }
    const primary = pickers(primaryHost);
    const side = pickers(sideHost);
    console.log(
      `[pane-context params] primary pickers: ${JSON.stringify(primary)}  ` +
        `side pickers: ${JSON.stringify(side)}`,
    );
    expect(primary).toEqual([{ items: ["alpha", "beta"], label: "sku" }]);
    expect(side).toEqual([{ items: ["1", "2"], label: "id" }]);
  });

  test("the auto-selected value lands on the tab it was loaded FOR", async () => {
    /* The load is asynchronous and the guard that admits it is "still SHOWN somewhere" rather than
       "still focused" — deliberately, so the unfocused pane's picker is not permanently empty. That
       guard is what made this reachable: `autoSelectParams` wrote through `updateUi("previewParams",
       …)`, which resolved `activeTab.value`, so BOTH panes' candidates were auto-selected onto
       whichever tab had focus. The primary then rendered with no route chosen at all, and the side
       tab was handed a `sku` its own route does not declare. */
    await twoDynamicPanes();
    for (let turn = 0; turn < 3; turn += 1) {
      paneContext.render();
      await flush();
    }
    const primary = workspace.tabs.get("sku-tab")!;
    const side = workspace.tabs.get("id-tab")!;
    console.log(
      `[pane-context params] primary(${primary.documentPath}).previewParams=` +
        `${JSON.stringify(primary.session.ui.previewParams)}  ` +
        `side(${side.documentPath}).previewParams=` +
        `${JSON.stringify(side.session.ui.previewParams)}  focus=${workspace.activePaneId}`,
    );
    expect(primary.session.ui.previewParams).toEqual({ sku: "alpha" });
    expect(side.session.ui.previewParams).toEqual({ id: "1" });
    // Neither tab carries a param the other document declares — the specific wrong state.
    expect(primary.session.ui.previewParams?.id).toBeUndefined();
    expect(side.session.ui.previewParams?.sku).toBeUndefined();
  });

  test("one pane is unchanged: a single dynamic page still loads exactly once", async () => {
    resetWorkspaceWithTab(
      { children: [], tagName: "div" },
      { documentPath: "pages/products/[sku].json", id: "solo" },
    );
    paneContext.mount(primaryHost, makeCtx());
    await flush();
    for (let turn = 0; turn < 5; turn += 1) {
      paneContext.render();
      await flush();
    }
    expect(loadCalls).toEqual(["pages/products/[sku].json"]);
    expect(pickers(primaryHost)).toEqual([{ items: ["alpha", "beta"], label: "sku" }]);
    // And the primary really is the pane that drew it.
    expect(paneContext.attachPaneChromeHost).toBeInstanceOf(Function);
    expect(PRIMARY_PANE).toBe("primary");
  });
});
