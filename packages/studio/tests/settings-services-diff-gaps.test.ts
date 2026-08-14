/**
 * Diff-gap tests for the settings surfaces and the two services beside them.
 *
 * Each block covers a branch the sibling suites reach around rather than through: a store that is
 * not there, a lazy import that refuses, a control that parked its own failure, the pane host's two
 * draw guards, and the one thing `write_file` cannot pre-validate — the disk saying no.
 *
 * `section-registry` is mocked for two of them, and only two of its exports are replaced:
 *
 * - `setSettingsSection` throws, which is what a failed chunk load looks like to the CSS-variables
 *   editor's "Manage contexts…" — the module imports the registry LAZILY to break a cycle, so the
 *   only thing that can go wrong is asynchronous and its `.catch` is the only place that says so.
 * - `onSettingsDocumentChanged` hands the listener to the test and returns an unsubscribe that does
 *   nothing, so a change notification can be delivered to a pane that has already been detached.
 *   The real unsubscribe makes that state unreachable; the guard in `draw` is what would catch it
 *   if it ever became reachable again, and this is the only way to prove it still holds.
 *
 * Everything else is the real module, spread through — the registry's `sections` map is shared, so
 * a section registered here is the section the pane host renders.
 */
import { flush, installMockPlatform, pointer, resetStudioState, surfaceOf } from "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { nothing, render as litRender } from "lit-html";
import { createToolRegistry } from "@jxsuite/ai";
import { problems, resetNotifications } from "../src/services/notify";
import { beginTurn, endTurn, resetAiWrites, writesForTurn } from "../src/services/ai-writes";
import { clearStudioStorage } from "../src/services/profile";
import { closeAllTabs, setWorkspaceProject } from "../src/workspace/workspace";

import type { ProjectToolsCtx } from "../src/services/ai-project-tools";
import type { StudioPlatform } from "../src/types";

const registry = await import("../src/settings/section-registry");

/** Every listener the pane host subscribed with, in subscription order. */
const paneListeners: (() => void)[] = [];

void mock.module("../src/settings/section-registry", () => ({
  ...registry,
  onSettingsDocumentChanged: (listener: () => void) => {
    paneListeners.push(listener);
    return () => {};
  },
  setSettingsSection: () => {
    throw new Error("chunk load failed");
  },
}));

const { renderCssVarsEditor } = await import("../src/settings/css-vars-editor");
const { contextsError, renderContextsSection } = await import("../src/settings/contexts-section");
const { detachSettingsPane, renderSettingsPane } = await import("../src/panels/settings-pane");
const { registerProjectTools } = await import("../src/services/ai-project-tools");

// ─── services/profile.ts — a profile with no store to clear ──────────────────

describe("clearStudioStorage without a Storage", () => {
  test("reports nothing removed instead of dereferencing an absent store", () => {
    localStorage.setItem("jx-studio-panel-widths", '{"left":400}');
    localStorage.setItem("theme", "dark");

    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: undefined });
    let removed: string[];
    try {
      removed = clearStudioStorage();
    } finally {
      if (descriptor) {
        Object.defineProperty(globalThis, "localStorage", descriptor);
      } else {
        Reflect.deleteProperty(globalThis, "localStorage");
      }
    }

    expect(removed).toEqual([]);
    // Nothing was reached, so nothing was cleared — the guard is a refusal, not a silent success.
    expect(localStorage.getItem("jx-studio-panel-widths")).toBe('{"left":400}');

    // And with the store back, the same call does the job the guard skipped.
    expect(clearStudioStorage()).toEqual(["jx-studio-panel-widths"]);
    expect(localStorage.getItem("jx-studio-panel-widths")).toBeNull();
    expect(localStorage.getItem("theme")).toBe("dark");
    localStorage.clear();
  });
});

// ─── settings/contexts-section.ts — the parked failure, read back ────────────

describe("contextsError", () => {
  test("is null until a control refuses, then names the control and the reason", () => {
    installMockPlatform();
    resetStudioState({ projectConfig: { $media: { "--": "1280px" } } as unknown });
    const container = document.createElement("div");
    renderContextsSection(container);

    expect(contextsError(container)).toBeNull();

    const base = container.querySelector('[data-context="base"]') as HTMLInputElement;
    base.value = "wide";
    base.dispatchEvent(new Event("change", { bubbles: true }));

    expect(contextsError(container)).toEqual({
      message: "Enter a width in pixels, like 1280px.",
      target: "base",
    });
    expect(container.querySelector(".settings-field-error")?.textContent?.trim()).toBe(
      "Enter a width in pixels, like 1280px.",
    );

    // Keyed by container, so a second mount has its own failure state rather than this one.
    const other = document.createElement("div");
    renderContextsSection(other);
    expect(contextsError(other)).toBeNull();
  });
});

// ─── settings/css-vars-editor.ts — "Manage contexts…" that cannot navigate ───

describe("css vars — Manage contexts when the section cannot be opened", () => {
  test("files a Problem naming the failure instead of dropping it", async () => {
    installMockPlatform();
    resetStudioState({
      projectConfig: {
        $media: { "--sm": "(max-width: 600px)" },
        style: { "--color-primary": "#007acc" },
      } as unknown,
    });
    resetNotifications();

    const container = document.createElement("div");
    renderCssVarsEditor(container);
    const link = [...container.querySelectorAll("sp-action-button")].find((b) =>
      b.textContent?.includes("Manage contexts"),
    );
    expect(link).toBeDefined();

    pointer(link!, "click");
    await flush(4);

    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toBe("Could not open Settings › Contexts — chunk load failed");
    expect(problems[0]!.source).toBe("Settings");
    expect(problems[0]!.severity).toBe("error");
    resetNotifications();
  });
});

// ─── panels/settings-pane.ts — the two guards in draw() ──────────────────────

describe("the settings pane's draw guards", () => {
  let host: HTMLElement;
  let renders = 0;

  beforeEach(() => {
    installMockPlatform();
    resetStudioState({ projectConfig: {} as unknown });
    paneListeners.length = 0;
    renders = 0;
    registry.resetSettingsDocumentState();
    registry.registerSettingsSection({
      key: "gapsOnly",
      label: "Gaps Only",
      order: 10,
      render: (el) => {
        renders += 1;
        el.textContent = `render ${renders}`;
      },
    });
    host = document.createElement("div");
  });

  afterEach(() => {
    detachSettingsPane("primary");
    registry.unregisterSettingsSection("gapsOnly");
    registry.resetSettingsDocumentState();
  });

  test("a change notification for a detached pane is a no-op, not a null dereference", () => {
    renderSettingsPane(surfaceOf(host));
    expect(renders).toBe(1);
    const drawn = host.innerHTML;

    detachSettingsPane("primary");
    /* The unsubscribe is stubbed in this file, so the listener outlives its panel — the state the
       guard exists for. It must draw nothing rather than reach through the missing record. */
    paneListeners[0]!();

    expect(renders).toBe(1);
    expect(host.innerHTML).toBe(drawn);
  });

  test("an idle remount leaves the section body standing, half-typed form and all", () => {
    renderSettingsPane(surfaceOf(host));
    expect(renders).toBe(1);

    /* Stands in for the open inline form the idempotence exists to protect: a node the SECTION
       owns, holding state no redraw could restore because the user typed it and it has not been
       written back to the document yet. The section renderer replaces `textContent`, so this node
       survives exactly as long as the renderer is not re-run. */
    const body = host.querySelector(".settings-doc-content") as HTMLElement;
    const halfTyped = document.createElement("input");
    halfTyped.value = "half-typed";
    body.append(halfTyped);

    renderSettingsPane(surfaceOf(host));
    renderSettingsPane(surfaceOf(host));

    expect(renders).toBe(1);
    const survivor = host.querySelector(".settings-doc-content input");
    expect(survivor).toBe(halfTyped);
    expect((survivor as HTMLInputElement).value).toBe("half-typed");
  });

  test("…and a real change still redraws — the guard is idempotence, not inertia", () => {
    renderSettingsPane(surfaceOf(host));
    expect(renders).toBe(1);

    /* The document announcing a change draws with `force`, which is the half of the guard that
       must NOT be suppressed. Without this the test above would be satisfied by a pane that never
       redraws at all. */
    paneListeners[0]!();

    expect(renders).toBe(2);
    expect(host.querySelector(".settings-doc-content")?.textContent).toBe("render 2");
  });

  test("the body binder invoked as the pane tears down resurrects nothing", () => {
    renderSettingsPane(surfaceOf(host));
    expect(renders).toBe(1);

    /* The canvas's mode change does exactly this pair, in this order: `detachSettingsPane`
       (canvas/canvas-render.ts:953) and then `litRender(nothing, canvasWrap)` (:962) over the very
       container that held the template. The second disconnects the `ref`, so lit invokes the
       binder with `undefined` AFTER the record is gone — the only path that reaches its guard, and
       without it the binder dereferences a missing panel and the mode change throws. */
    detachSettingsPane("primary");
    litRender(nothing, host);

    expect(host.querySelector(".settings-doc-content")).toBeNull();
    expect(renders).toBe(1);

    // Re-mountable afterwards, which is what "tore down cleanly" has to mean.
    renderSettingsPane(surfaceOf(host));
    expect(renders).toBe(2);
    expect(host.querySelector(".settings-doc-content")?.textContent).toBe("render 2");
  });
});

// ─── services/ai-project-tools.ts — the disk refusing the write ──────────────

describe("ai-project-tools — write_file when the disk refuses", () => {
  function harness(writeFile: (path: string, content: string) => Promise<void>) {
    installMockPlatform({ writeFile } as Partial<StudioPlatform>);
    const tools = createToolRegistry();
    const ctx: ProjectToolsCtx = {
      adoptProject: async () => {},
      findOpenTab: () => null,
      getTab: () => null,
      reloadTab: async () => {},
      validate: async () => [],
    };
    registerProjectTools(tools, ctx);
    return tools;
  }

  beforeEach(() => {
    closeAllTabs();
    setWorkspaceProject(null);
    resetAiWrites();
  });

  test("reports the path and the reason, and records a failed disk write in the ledger", async () => {
    const tools = harness(() => Promise.reject(new Error("EACCES: permission denied")));
    beginTurn("turn-1");

    const res = await tools.execute("write_file", { content: "hello", path: "data/notes.txt" });
    const recorded = endTurn("msg-1");

    expect(res.success).toBe(false);
    expect(res.error).toBe('Failed to write "data/notes.txt": EACCES: permission denied');
    expect(res.summary).toBeUndefined();
    /* §7.4: the panel renders the ledger, not the model-facing prose — so a write that failed is a
       listed attempt that changed nothing, with the reason attached. */
    expect(recorded).toEqual([
      {
        disk: true,
        error: "EACCES: permission denied",
        ok: false,
        path: "data/notes.txt",
        tool: "write_file",
      },
    ]);
    expect(writesForTurn("msg-1")).toEqual(recorded);
  });

  test("a rejection that is not an Error is stringified rather than reported as an object", async () => {
    const notAnError = "quota exceeded" as unknown as Error;
    const tools = harness(() => Promise.reject(notAnError));
    beginTurn("turn-2");

    const res = await tools.execute("write_file", { content: "hello", path: "data/other.txt" });
    const recorded = endTurn("msg-2");

    expect(res.error).toBe('Failed to write "data/other.txt": quota exceeded');
    expect(recorded[0]?.error).toBe("quota exceeded");
  });
});
