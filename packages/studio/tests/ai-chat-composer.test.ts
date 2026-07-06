/**
 * Tests for src/panels/ai-chat/composer.ts — the sticky chat input: Enter/Shift+Enter, empty-send +
 * streaming guards, auto-grow, clear-after-send, the Send↔Stop morph, context-attach chips
 * (page/selection), and the model picker states.
 */
import {
  flush,
  installMockPlatform,
  key,
  pointer,
  resetWorkspaceWithTab,
  setValue,
} from "./harness";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { render } from "lit-html";
import { createComposer } from "../src/panels/ai-chat/composer";
import { ATTACHED_CONTEXT_DELIMITER } from "../src/panels/ai-chat/attached-context";
import { invalidateModelCache } from "../src/services/ai-models";
import type { ComposerOptions } from "../src/panels/ai-chat/composer";

installMockPlatform();

// ─── Fetch stub (model listing) ──────────────────────────────────────────────

let fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = async () =>
  Response.json({ models: [] }, { status: 200 });
(globalThis as Record<string, unknown>).fetch = (url: string, init?: RequestInit) =>
  fetchImpl(url, init);

// ─── Harness ─────────────────────────────────────────────────────────────────

function makeComposer(extra: Partial<ComposerOptions> = {}) {
  const container = document.createElement("div");
  const onSend = mock((_text: string) => {});
  const onStop = mock(() => {});
  const onOpenSettings = mock(() => {});
  let streaming = false;
  const composer = createComposer({
    isStreaming: () => streaming,
    onOpenSettings,
    onSend,
    onStop,
    requestRender: () => {
      render(composer.render(), container);
    },
    ...extra,
  });
  render(composer.render(), container);
  return {
    composer,
    container,
    onOpenSettings,
    onSend,
    onStop,
    rerender: () => {
      render(composer.render(), container);
    },
    setStreaming: (v: boolean) => {
      streaming = v;
    },
    textarea: () => container.querySelector("textarea")!,
  };
}

beforeEach(() => {
  globalThis.localStorage.clear();
  invalidateModelCache();
  resetWorkspaceWithTab();
  fetchImpl = async () =>
    Response.json({ models: [{ id: "gpt-4o" }, { id: "o3", name: "o3 mini" }] }, { status: 200 });
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("composer input", () => {
  test("Enter sends the draft and clears; Shift+Enter does not send", async () => {
    const c = makeComposer();
    setValue(c.textarea(), "build a hero section");
    key(c.textarea(), "Enter", { shiftKey: true });
    expect(c.onSend).not.toHaveBeenCalled();

    key(c.textarea(), "Enter");
    expect(c.onSend).toHaveBeenCalledWith("build a hero section");
    expect(c.textarea().value).toBe("");
  });

  test("whitespace-only drafts never send; the Send button disables", async () => {
    const c = makeComposer();
    key(c.textarea(), "Enter");
    setValue(c.textarea(), "   \n ");
    key(c.textarea(), "Enter");
    expect(c.onSend).not.toHaveBeenCalled();
    expect(c.container.querySelector(".ai-send-btn")!.hasAttribute("disabled")).toBe(true);

    setValue(c.textarea(), "real text");
    expect(c.container.querySelector(".ai-send-btn")!.hasAttribute("disabled")).toBe(false);
    pointer(c.container.querySelector(".ai-send-btn")!, "click");
    expect(c.onSend).toHaveBeenCalledWith("real text");
  });

  test("while streaming, Enter is a no-op and the button morphs into Stop", async () => {
    const c = makeComposer();
    c.setStreaming(true);
    c.rerender();
    setValue(c.textarea(), "typed ahead");
    key(c.textarea(), "Enter");
    expect(c.onSend).not.toHaveBeenCalled();
    // The draft survives for when the stream finishes.
    expect(c.textarea().value).toBe("typed ahead");

    const stopBtn = c.container.querySelector(".ai-send-btn")!;
    expect(stopBtn.getAttribute("title")).toBe("Stop");
    pointer(stopBtn, "click");
    expect(c.onStop).toHaveBeenCalledTimes(1);
  });

  test("auto-grows with content up to the cap", () => {
    const c = makeComposer();
    const ta = c.textarea();
    Object.defineProperty(ta, "scrollHeight", { configurable: true, value: 64 });
    setValue(ta, "line1\nline2\nline3");
    expect(ta.style.height).toBe("64px");

    Object.defineProperty(ta, "scrollHeight", { configurable: true, value: 400 });
    setValue(ta, "many\nmany\nlines");
    expect(ta.style.height).toBe("120px");
  });

  test("the settings button opens the credentials form", () => {
    const c = makeComposer();
    pointer(c.container.querySelector("sp-action-button[title='API key & endpoint']")!, "click");
    expect(c.onOpenSettings).toHaveBeenCalledTimes(1);
  });
});

describe("context attach", () => {
  function menu(c: ReturnType<typeof makeComposer>) {
    return c.container.querySelector("sp-menu")!;
  }
  function menuItems(c: ReturnType<typeof makeComposer>) {
    return [...c.container.querySelectorAll("overlay-trigger sp-menu-item")] as (HTMLElement & {
      value?: string;
    })[];
  }
  function chooseContext(c: ReturnType<typeof makeComposer>, value: string) {
    const m = menu(c) as HTMLElement & { value?: string };
    m.value = value;
    m.dispatchEvent(new Event("change", { bubbles: true }));
  }

  test("menu offers the current page and selected element based on tab state", () => {
    const tab = resetWorkspaceWithTab(
      { children: [{ tagName: "h1", textContent: "Welcome to the site" }], tagName: "div" },
      { documentPath: "pages/index.json" },
    );
    tab.session.selection = ["children", 0];
    const c = makeComposer();
    const [pageItem, selItem] = menuItems(c);
    expect(pageItem!.textContent).toContain("pages/index.json");
    expect(pageItem!.hasAttribute("disabled")).toBe(false);
    expect(selItem!.textContent).toContain("<h1>");
    expect(selItem!.hasAttribute("disabled")).toBe(false);
  });

  test("menu disables items without a page or selection", () => {
    const tab = resetWorkspaceWithTab();
    tab.documentPath = null;
    tab.session.selection = null;
    const c = makeComposer();
    const [pageItem, selItem] = menuItems(c);
    expect(pageItem!.hasAttribute("disabled")).toBe(true);
    expect(selItem!.hasAttribute("disabled")).toBe(true);
  });

  test("attaching context adds deduped chips and serializes into the sent message", () => {
    const tab = resetWorkspaceWithTab(
      { children: [{ tagName: "h1", textContent: "Welcome" }], tagName: "div" },
      { documentPath: "pages/index.json" },
    );
    tab.session.selection = ["children", 0];
    const c = makeComposer();
    chooseContext(c, "page");
    chooseContext(c, "selection");
    chooseContext(c, "page"); // Re-attach → still one page chip
    const chips = c.container.querySelectorAll(".ai-composer-chips .ai-context-chip");
    expect(chips).toHaveLength(2);

    setValue(c.textarea(), "make the heading bigger");
    key(c.textarea(), "Enter");
    const sent = (c.onSend.mock.calls[0] as string[])[0]!;
    expect(sent).toContain("make the heading bigger");
    expect(sent).toContain(ATTACHED_CONTEXT_DELIMITER);
    expect(sent).toContain("Page: pages/index.json");
    expect(sent).toContain('Selected element at ["children",0]: <h1> "Welcome"');
    // Chips clear after sending.
    expect(c.container.querySelectorAll(".ai-context-chip")).toHaveLength(0);
  });

  test("chips can be removed before sending", () => {
    resetWorkspaceWithTab(undefined, { documentPath: "pages/about.json" });
    const c = makeComposer();
    chooseContext(c, "page");
    expect(c.container.querySelectorAll(".ai-context-chip")).toHaveLength(1);
    pointer(c.container.querySelector(".ai-context-chip sp-action-button")!, "click");
    expect(c.container.querySelectorAll(".ai-context-chip")).toHaveLength(0);

    setValue(c.textarea(), "no context here");
    key(c.textarea(), "Enter");
    expect(c.onSend).toHaveBeenCalledWith("no context here");
  });
});

describe("model picker", () => {
  function pickerItems(c: ReturnType<typeof makeComposer>) {
    return [...c.container.querySelectorAll(".ai-model-picker sp-menu-item")] as (HTMLElement & {
      value?: string;
    })[];
  }

  test("lists fetched models after the lazy load resolves", async () => {
    const c = makeComposer();
    // First render kicks off the fetch; loading item present meanwhile.
    expect(c.container.textContent).toContain("Loading models…");
    await flush();
    c.rerender();
    const items = pickerItems(c);
    expect(items.some((i) => i.getAttribute("value") === "o3")).toBe(true);
    expect(c.container.textContent).toContain("o3 mini");
    expect(c.container.textContent).not.toContain("Loading models…");
  });

  test("prepends a stored custom model id missing from the list", async () => {
    globalThis.localStorage.setItem("jx.ai.model", "my-custom-model");
    const c = makeComposer();
    await flush();
    c.rerender();
    const first = pickerItems(c)[0]!;
    expect(first.getAttribute("value")).toBe("my-custom-model");
  });

  test("change persists the model choice", async () => {
    const c = makeComposer();
    await flush();
    c.rerender();
    const picker = c.container.querySelector(".ai-model-picker") as HTMLElement & {
      value?: string;
    };
    picker.value = "o3";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    expect(globalThis.localStorage.getItem("jx.ai.model")).toBe("o3");
  });

  test("fetch failure offers Retry, which refetches", async () => {
    fetchImpl = async () => new Response("boom", { status: 500 });
    const c = makeComposer();
    await flush();
    c.rerender();
    const retry = pickerItems(c).find((i) => i.getAttribute("value") === "__retry_models__");
    expect(retry).toBeDefined();
    expect(c.container.querySelector(".ai-model-picker")!.getAttribute("title")).toContain(
      "HTTP 500",
    );

    fetchImpl = async () => Response.json({ models: [{ id: "recovered" }] }, { status: 200 });
    const picker = c.container.querySelector(".ai-model-picker") as HTMLElement & {
      value?: string;
    };
    picker.value = "__retry_models__";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    c.rerender();
    expect(pickerItems(c).some((i) => i.getAttribute("value") === "recovered")).toBe(true);
    // The retry sentinel never persists as the chosen model.
    expect(globalThis.localStorage.getItem("jx.ai.model")).toBeNull();
  });
});
