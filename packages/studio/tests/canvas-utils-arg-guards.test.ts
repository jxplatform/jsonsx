/**
 * The argument guards on the rendering-context verbs — `canvas.setBreakpoint`, `canvas.setTestProp`
 * and `canvas.setRouteParam` — plus the pane resolution all of them share.
 *
 * Each of these refusals exists because the alternative is a canvas that RENDERS a state nobody
 * declared: a breakpoint the document has no media query for, a test value no prop reads, a route
 * parameter the path has no bracket segment for. A screenshot taken through any of those
 * photographs something the built site never produces, so the verb has to refuse by name and say
 * what it does have — which is what these tests assert on, sentence for sentence.
 *
 * `canvas-view-commands.test.ts` beside this one covers the same records' HAPPY paths and the
 * pane-repaint rule; this file is the refusals and the "…it defines: nothing" tail of each list.
 */
import { resetStudioState } from "./harness";
import { beforeEach, describe, expect, test } from "bun:test";
import { createCommandRegistry } from "../src/commands/registry";
import { makeContext } from "../src/commands/context";
import {
  PRIMARY_PANE,
  SECONDARY_PANE,
  activeTab,
  closeAllTabs,
  focusPane,
  openTab,
  splitRight,
} from "../src/workspace/workspace";
import type { CommandContext } from "../src/commands/context";
import type { CommandRegistry } from "../src/commands/registry";

const { canvasViewCommands } = await import("../src/canvas/canvas-utils");

// ─── Context ──────────────────────────────────────────────────────────────────

/** Which pane each verb repainted — a refusal must repaint none. */
const renderedPanes: string[] = [];
const deps = {
  getCanvasMode: () => "design",
  renderPane: (paneId: string) => renderedPanes.push(paneId),
  setCanvasMode: () => {},
  setOpenPopover: () => {},

  setResolvingOpen: () => {},
};

let ctx: CommandContext = makeContext();
let registry: CommandRegistry;

const DOC = {
  children: [{ tagName: "p", textContent: "Hi" }],
  tagName: "div",
};

/** One open tab, replacing whatever was open, with the document and path a test needs. */
function openDoc(opts: { document?: Record<string, unknown>; documentPath?: string } = {}) {
  closeAllTabs();
  return openTab({
    capabilities: { modes: ["edit", "design"] },
    document: opts.document ?? structuredClone(DOC),
    documentPath: opts.documentPath ?? "pages/index.json",
    id: "t1",
  });
}

/** A page that declares two breakpoints of its own. */
function openWithMedia() {
  return openDoc({
    document: {
      ...structuredClone(DOC),
      $media: { lg: "(min-width: 1024px)", md: "(min-width: 768px)" },
    },
  });
}

beforeEach(() => {
  resetStudioState();
  renderedPanes.length = 0;
  ctx = makeContext({ document: { open: true } });
  registry = createCommandRegistry({ getContext: () => ctx });
  registry.registerAll(canvasViewCommands(deps));
  openDoc();
});

describe("the pane a rendering-context verb addresses", () => {
  test("refuses a named pane that is showing no document, and repaints nothing", () => {
    // Nothing has split, so "secondary" names no stage — the state an automation script reaches by
    // Naming the side pane before opening one.
    expect(() =>
      registry.run("canvas.setBreakpoint", { media: null, pane: SECONDARY_PANE }),
    ).toThrow('command "canvas.setBreakpoint" argument "pane": "secondary" has no open document');
    expect(renderedPanes).toEqual([]);
  });

  test("the refusal names the verb that was run, not the family", () => {
    expect(() => registry.run("canvas.setTestProp", { name: "count", pane: "tertiary" })).toThrow(
      'command "canvas.setTestProp" argument "pane": "tertiary" has no open document',
    );
    // And the refusal came from the PANE, before the prop was ever checked against the document.
    expect(activeTab.value?.session.ui.previewProps).toBeNull();
  });

  test("a named pane that IS showing one resolves to that pane's tab, not the focused one", () => {
    const tab = openDoc();
    splitRight();
    focusPane(PRIMARY_PANE);
    void registry.run("canvas.setColorScheme", { pane: SECONDARY_PANE, scheme: "dark" });
    expect(tab.session.ui.previewColorScheme).toBe("dark");
    expect(renderedPanes).toEqual([SECONDARY_PANE]);
  });
});

describe("canvas.setBreakpoint", () => {
  test("refuses a media that is neither a breakpoint key nor null", () => {
    openWithMedia();
    expect(() => registry.run("canvas.setBreakpoint", { media: 42 })).toThrow(
      'command "canvas.setBreakpoint" argument "media": expected a breakpoint key or null',
    );
    expect(activeTab.value?.session.ui.activeMedia).toBeNull();
    expect(renderedPanes).toEqual([]);
  });

  test("omitting media refuses too — it does not read as a clear", () => {
    openWithMedia();
    activeTab.value!.session.ui.activeMedia = "md";
    expect(() => registry.run("canvas.setBreakpoint", {})).toThrow(
      'command "canvas.setBreakpoint" argument "media": expected a breakpoint key or null',
    );
    // The one that would be silently wrong: `{}` clearing the breakpoint back to base.
    expect(activeTab.value?.session.ui.activeMedia).toBe("md");
  });

  test("refuses a key the document does not define, listing the ones it does", () => {
    openWithMedia();
    expect(() => registry.run("canvas.setBreakpoint", { media: "xl" })).toThrow(
      'command "canvas.setBreakpoint" argument "media": "xl" is not a breakpoint this document ' +
        "defines — it defines: lg, md",
    );
    expect(activeTab.value?.session.ui.activeMedia).toBeNull();
    expect(renderedPanes).toEqual([]);
  });

  test('a document that defines none says "nothing", rather than an empty list', () => {
    openDoc();
    expect(() => registry.run("canvas.setBreakpoint", { media: "md" })).toThrow(
      'command "canvas.setBreakpoint" argument "media": "md" is not a breakpoint this document ' +
        "defines — it defines: nothing",
    );
  });

  test("accepts a key only the SITE defines — the popover offers those too", () => {
    resetStudioState({ projectConfig: { $media: { sm: "(min-width: 640px)" } } });
    openDoc();
    void registry.run("canvas.setBreakpoint", { media: "sm" });
    expect(activeTab.value?.session.ui.activeMedia).toBe("sm");
    expect(renderedPanes).toEqual([PRIMARY_PANE]);
  });

  test("a declared key and null both go through", () => {
    openWithMedia();
    void registry.run("canvas.setBreakpoint", { media: "md" });
    expect(activeTab.value?.session.ui.activeMedia).toBe("md");
    void registry.run("canvas.setBreakpoint", { media: null });
    expect(activeTab.value?.session.ui.activeMedia).toBeNull();
  });
});

describe("canvas.setTestProp", () => {
  /** A component document declaring one prop. */
  const withState = () =>
    openDoc({
      document: { ...structuredClone(DOC), state: { count: 0, label: "Hi" } },
      documentPath: "components/counter.json",
    });

  test("refuses a prop the component does not declare, listing the ones it does", () => {
    withState();
    expect(() => registry.run("canvas.setTestProp", { name: "total", value: 3 })).toThrow(
      'command "canvas.setTestProp" argument "name": "total" is not a prop this component ' +
        "declares — it declares: count, label",
    );
    // No value was seeded for a name nothing reads.
    expect(activeTab.value?.session.ui.previewProps).toBeNull();
    expect(renderedPanes).toEqual([]);
  });

  test('a component with no state says "nothing", rather than an empty list', () => {
    openDoc({ documentPath: "components/plain.json" });
    expect(() => registry.run("canvas.setTestProp", { name: "count", value: 1 })).toThrow(
      'command "canvas.setTestProp" argument "name": "count" is not a prop this component ' +
        "declares — it declares: nothing",
    );
  });

  test("a declared prop is seeded, and null clears it again", () => {
    withState();
    void registry.run("canvas.setTestProp", { name: "count", value: 7 });
    expect(activeTab.value?.session.ui.previewProps).toEqual({ count: 7 });
    void registry.run("canvas.setTestProp", { name: "count", value: null });
    expect(activeTab.value?.session.ui.previewProps).toBeNull();
    expect(renderedPanes).toEqual([PRIMARY_PANE, PRIMARY_PANE]);
  });
});

describe("canvas.setRouteParam", () => {
  const dynamicPage = () => openDoc({ documentPath: "pages/products/[sku].json" });

  test("refuses a name the route does not carry, listing the ones it has", () => {
    dynamicPage();
    expect(() => registry.run("canvas.setRouteParam", { name: "id", value: "42" })).toThrow(
      'command "canvas.setRouteParam" argument "name": "id" is not a parameter of this route — ' +
        "it has: sku",
    );
    expect(activeTab.value?.session.ui.previewParams).toEqual({});
    expect(renderedPanes).toEqual([]);
  });

  test('a static page says "none", rather than an empty list', () => {
    openDoc();
    expect(() => registry.run("canvas.setRouteParam", { name: "sku", value: "42" })).toThrow(
      'command "canvas.setRouteParam" argument "name": "sku" is not a parameter of this route — ' +
        "it has: none",
    );
  });

  test("a declared parameter is written and the pane repainted", () => {
    dynamicPage();
    void registry.run("canvas.setRouteParam", { name: "sku", value: "ABC-1" });
    expect(activeTab.value?.session.ui.previewParams).toEqual({ sku: "ABC-1" });
    expect(renderedPanes).toEqual([PRIMARY_PANE]);
  });
});
