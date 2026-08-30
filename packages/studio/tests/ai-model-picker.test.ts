/**
 * Tests for src/ui/ai-model-picker.ts — the provider catalogue as one sp-picker.
 *
 * Four of these moved here from ai-chat-composer.test.ts when the picker left the composer to be
 * shared with the New Project Import source. The rest cover what only a SECOND host makes
 * observable: the getModel/onChange seams, and the invariant that a list is only ever shown for the
 * credentials it was listed under.
 */
import { clearSeededSettings, flush, installMockPlatform, seedSettings } from "./harness";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { render } from "lit-html";
import { createModelPicker } from "../src/ui/ai-model-picker";
import { resetModelCache } from "../src/services/ai-models";
import { saveAiProvider } from "../src/services/ai-settings";
import type { ModelPickerOptions } from "../src/ui/ai-model-picker";

installMockPlatform();

let fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = async () =>
  Response.json({ models: [] }, { status: 200 });
(globalThis as Record<string, unknown>).fetch = (url: string, init?: RequestInit) =>
  fetchImpl(url, init);

function mount(extra: Partial<ModelPickerOptions> = {}) {
  const container = document.createElement("div");
  const rerender = () => {
    render(picker.render(), container);
  };
  const picker = createModelPicker({ requestRender: () => rerender(), ...extra });
  rerender();
  return { container, picker, rerender };
}

function items(container: HTMLElement, cls = ".ai-model-picker") {
  return [...container.querySelectorAll(`${cls} sp-menu-item`)] as (HTMLElement & {
    value?: string;
  })[];
}

function pickerEl(container: HTMLElement, cls = ".ai-model-picker") {
  return container.querySelector(cls) as HTMLElement & { value?: string };
}

/** Choose a value the way Spectrum's picker reports one. */
function choose(el: HTMLElement & { value?: string }, value: string) {
  el.value = value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

beforeEach(() => {
  localStorage.clear();
  clearSeededSettings();
  resetModelCache();
  fetchImpl = async () =>
    Response.json({ models: [{ id: "gpt-4o" }, { id: "o3", name: "o3 mini" }] }, { status: 200 });
});

describe("ai-model-picker — listing", () => {
  test("lists fetched models after the lazy load resolves", async () => {
    const c = mount();
    // The first render kicks off the fetch; the loading item stands in meanwhile.
    expect(c.container.textContent).toContain("Loading models…");
    await flush();
    c.rerender();
    expect(items(c.container).some((i) => i.getAttribute("value") === "o3")).toBe(true);
    expect(c.container.textContent).toContain("o3 mini");
    expect(c.container.textContent).not.toContain("Loading models…");
  });

  test("prepends a current model id the catalogue does not list", async () => {
    // A self-hosted or newly released id is the normal case, not an error.
    seedSettings({ "jx.ai.model": "my-custom-model" });
    const c = mount();
    await flush();
    c.rerender();
    expect(items(c.container)[0]!.getAttribute("value")).toBe("my-custom-model");
  });

  test("a model already in the catalogue is not duplicated", async () => {
    seedSettings({ "jx.ai.model": "o3" });
    const c = mount();
    await flush();
    c.rerender();
    expect(items(c.container).filter((i) => i.getAttribute("value") === "o3")).toHaveLength(1);
  });

  test("change persists the model choice", async () => {
    const c = mount();
    await flush();
    c.rerender();
    choose(pickerEl(c.container), "o3");
    expect(globalThis.localStorage.getItem("jx.ai.model")).toBe("o3");
  });

  test("selecting the loading placeholder chooses nothing", async () => {
    const c = mount();
    choose(pickerEl(c.container), "__loading__");
    expect(globalThis.localStorage.getItem("jx.ai.model")).toBeNull();
  });

  test("an empty value chooses nothing", async () => {
    const c = mount();
    await flush();
    c.rerender();
    choose(pickerEl(c.container), "");
    expect(globalThis.localStorage.getItem("jx.ai.model")).toBeNull();
  });
});

describe("ai-model-picker — tool support", () => {
  test("labels a model the backend says cannot call tools, and lists it anyway", async () => {
    /* Labelled, never filtered or disabled: a chat-only model is a legitimate choice, and hiding
       half a managed catalogue would report a capability gap as an outage. */
    fetchImpl = async () =>
      Response.json(
        {
          models: [
            { id: "@cf/meta/llama-4", toolSupport: true },
            { id: "@cf/tiny/chat", name: "Tiny Chat", toolSupport: false },
            { id: "gpt-4o" },
          ],
        },
        { status: 200 },
      );
    seedSettings({ "jx.ai.model": "@cf/meta/llama-4" });
    const c = mount();
    await flush();
    c.rerender();

    const byValue = new Map(
      items(c.container).map((i) => [i.getAttribute("value"), i.textContent]),
    );
    expect(byValue.get("@cf/tiny/chat")).toContain("Tiny Chat — no tools");
    // A model that CAN, and one the backend said nothing about, are both left unadorned.
    expect(byValue.get("@cf/meta/llama-4")).not.toContain("no tools");
    expect(byValue.get("gpt-4o")).not.toContain("no tools");
    expect(byValue.size).toBe(3);
  });

  test("selectedLacksTools reads the stored choice", async () => {
    fetchImpl = async () =>
      Response.json({ models: [{ id: "@cf/tiny/chat", toolSupport: false }] }, { status: 200 });
    seedSettings({ "jx.ai.model": "@cf/tiny/chat" });
    const c = mount();
    // Before the catalogue lands nothing is known, so nothing is claimed.
    expect(c.picker.selectedLacksTools()).toBe(false);
    await flush();
    expect(c.picker.selectedLacksTools()).toBe(true);
  });
});

describe("ai-model-picker — failure", () => {
  test("fetch failure offers Retry, which refetches", async () => {
    fetchImpl = async () => new Response("boom", { status: 500 });
    const c = mount();
    await flush();
    c.rerender();
    expect(items(c.container).some((i) => i.getAttribute("value") === "__retry_models__")).toBe(
      true,
    );
    expect(pickerEl(c.container).getAttribute("title")).toContain("HTTP 500");
    expect(c.picker.error()).toContain("HTTP 500");

    fetchImpl = async () => Response.json({ models: [{ id: "recovered" }] }, { status: 200 });
    choose(pickerEl(c.container), "__retry_models__");
    await flush();
    c.rerender();
    expect(items(c.container).some((i) => i.getAttribute("value") === "recovered")).toBe(true);
    // The retry sentinel never persists as the chosen model.
    expect(globalThis.localStorage.getItem("jx.ai.model")).toBeNull();
  });

  test("a failed fetch is not retried on every render", async () => {
    let calls = 0;
    fetchImpl = async () => {
      calls += 1;
      return new Response("boom", { status: 500 });
    };
    const c = mount();
    await flush();
    c.rerender();
    c.rerender();
    c.rerender();
    expect(calls).toBe(1);
  });

  test("a fetch rejection with no message still reports something", async () => {
    // A rejection value that carries no `message` — the fallback exists because `fetch` and the
    // Platform layer are free to reject with anything.
    const messageless = { name: "TypeError" } as unknown as Error;
    fetchImpl = async () => {
      throw messageless;
    };
    const c = mount();
    await flush();
    expect(c.picker.error()).toBe("Failed to fetch models");
  });

  test("isLoading reports the in-flight fetch", async () => {
    const c = mount();
    expect(c.picker.isLoading()).toBe(true);
    await flush();
    expect(c.picker.isLoading()).toBe(false);
  });
});

describe("ai-model-picker — the second host's seams", () => {
  test("getModel and onChange keep a draft out of the application preference", async () => {
    /* The Import form chooses a model for ONE run. Writing it through setModel would silently
       retarget the assistant, which the user did not ask for. */
    let draft = "gpt-4o";
    const onChange = mock((id: string) => {
      draft = id;
    });
    const c = mount({ getModel: () => draft, onChange });
    await flush();
    c.rerender();

    choose(pickerEl(c.container), "o3");
    expect(onChange).toHaveBeenCalledWith("o3");
    expect(draft).toBe("o3");
    expect(globalThis.localStorage.getItem("jx.ai.model")).toBeNull();
  });

  test("className and size are the host's to set", async () => {
    const c = mount({ className: "np-model", size: "m" });
    await flush();
    c.rerender();
    const el = pickerEl(c.container, ".np-model");
    expect(el).not.toBeNull();
    expect(el.getAttribute("size")).toBe("m");
  });

  test("selectedLacksTools tracks the host's own current choice", async () => {
    fetchImpl = async () =>
      Response.json(
        { models: [{ id: "gpt-4o" }, { id: "@cf/tiny/chat", toolSupport: false }] },
        { status: 200 },
      );
    let draft = "gpt-4o";
    const c = mount({
      getModel: () => draft,
      onChange: (id: string) => {
        draft = id;
      },
    });
    await flush();
    c.rerender();
    // The backend said nothing about gpt-4o, and silence is not "no tools".
    expect(c.picker.selectedLacksTools()).toBe(false);

    choose(pickerEl(c.container), "@cf/tiny/chat");
    expect(c.picker.selectedLacksTools()).toBe(true);
  });

  test("a credential change makes the catalogue unavailable rather than stale", async () => {
    /* The list is read from cachedModels(credentials) on every render, never held here. Holding it
       is what once let the picker offer one provider's models while another was configured. */
    const c = mount();
    await flush();
    c.rerender();
    expect(items(c.container).some((i) => i.getAttribute("value") === "o3")).toBe(true);

    fetchImpl = async () => Response.json({ models: [{ id: "llama-3" }] }, { status: 200 });
    saveAiProvider({ apiKey: "sk-other", baseUrl: "https://elsewhere.example/v1", model: "" });
    c.rerender();
    expect(items(c.container).some((i) => i.getAttribute("value") === "o3")).toBe(false);

    await flush();
    c.rerender();
    expect(items(c.container).some((i) => i.getAttribute("value") === "llama-3")).toBe(true);
  });
});
