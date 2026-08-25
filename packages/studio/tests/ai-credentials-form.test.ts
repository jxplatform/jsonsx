/**
 * Tests for src/ui/ai-credentials-form.ts — the reusable AI provider credentials form.
 *
 * Fetch is stubbed (no network), and the platform mock supplies aiChatUrl. Each form instance
 * renders into its own detached container via a requestRender that re-renders synchronously.
 */
import { clearSeededSettings, installMockPlatform, seedSettings } from "./harness";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { render } from "lit-html";
import { storedModel } from "../src/services/ai-settings";
import { preferredModel } from "../src/services/ai-models";
import { createAiCredentialsForm } from "../src/ui/ai-credentials-form";
import type { AiCredentialsFormOptions } from "../src/ui/ai-credentials-form";

installMockPlatform();

// ─── Fetch stub ───────────────────────────────────────────────────────────────

let fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = async () =>
  Response.json({ models: [] }, { status: 200 });
const fetchCalls: { url: string; init?: RequestInit | undefined }[] = [];
(globalThis as Record<string, unknown>).fetch = (url: string, init?: RequestInit) => {
  fetchCalls.push({ init, url });
  return fetchImpl(url, init);
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function flush(turns = 4) {
  for (let i = 0; i < turns; i++) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

/** Create a form wired to re-render itself into a dedicated container. */
function makeForm(extra: Partial<AiCredentialsFormOptions> = {}) {
  const container = document.createElement("div");
  const form = createAiCredentialsForm({
    requestRender: () => {
      render(form.render(), container);
    },
    ...extra,
  });
  render(form.render(), container);
  return { container, form };
}

/** The Spectrum field whose placeholder starts with `ph` (the form is sp-textfield-based). */
function fieldByPlaceholder(container: HTMLElement, ph: string) {
  return container.querySelector(`sp-textfield[placeholder^="${ph}"]`) as HTMLInputElement | null;
}

function byText(container: HTMLElement, label: string) {
  return [...container.querySelectorAll("sp-button")].find((b) =>
    b.textContent?.includes(label),
  ) as HTMLElement | undefined;
}

function click(el: HTMLElement | undefined) {
  el?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function fire(el: HTMLElement | null, type: string, value?: string) {
  if (!el) {
    return;
  }
  if (value !== undefined) {
    (el as HTMLInputElement).value = value;
  }
  el.dispatchEvent(new Event(type, { bubbles: true }));
}

beforeEach(() => {
  localStorage.clear();
  clearSeededSettings();
  fetchCalls.length = 0;
  fetchImpl = async () => Response.json({ models: [] }, { status: 200 });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("ai-credentials-form", () => {
  test("renders the gate with the default blurb and drafts survive a re-render", () => {
    const { container, form } = makeForm();
    expect(container.textContent).toContain("AI provider key");
    expect(container.textContent).toContain("Any OpenAI-compatible key works");
    expect(container.querySelector(".ai-creds-form")).not.toBeNull();
    fire(fieldByPlaceholder(container, "sk-"), "input", "sk-secret");
    fire(fieldByPlaceholder(container, "Model ID"), "input", "gpt-4o-mini");
    fire(fieldByPlaceholder(container, "Endpoint"), "input", "http://localhost:11434/v1");
    // Re-render from closure state: the typed values round-trip through the drafts.
    render(form.render(), container);
    expect(fieldByPlaceholder(container, "sk-")!.value).toBe("sk-secret");
    expect(fieldByPlaceholder(container, "Model ID")!.value).toBe("gpt-4o-mini");
    expect(fieldByPlaceholder(container, "Endpoint")!.value).toBe("http://localhost:11434/v1");
  });

  test("fetchModels forwards X-Api-Key and X-Api-Base-URL and populates the picker", async () => {
    fetchImpl = async () =>
      Response.json({ models: [{ id: "gpt-4o" }, { id: "x", name: "Model X" }] }, { status: 200 });
    const { container } = makeForm();
    fire(fieldByPlaceholder(container, "sk-"), "input", "sk-fetch-key");
    fire(fieldByPlaceholder(container, "Endpoint"), "input", "http://localhost:9999/v1");
    click(byText(container, "Fetch models"));
    await flush();
    const call = fetchCalls.at(-1)!;
    expect(call.url).toBe("/__mock/ai/models");
    const headers = call.init!.headers as Record<string, string>;
    expect(headers["X-Api-Key"]).toBe("sk-fetch-key");
    expect(headers["X-Api-Base-URL"]).toBe("http://localhost:9999/v1");
    // The model picker switched to the combobox branch listing the fetched models.
    expect(container.querySelector("sp-combobox")).not.toBeNull();
    expect(container.textContent).toContain("Model X");
    expect(container.textContent).toContain("Refresh models");
    // Selecting through the combobox updates the model draft, persisted on Save.
    const combo = container.querySelector("sp-combobox") as HTMLInputElement;
    fire(combo as unknown as HTMLElement, "change", "gpt-4o");
    fire(combo as unknown as HTMLElement, "input", "gpt-4o");
    click(byText(container, "Save"));
    expect(globalThis.localStorage.getItem("jx.ai.model")).toBe("gpt-4o");
  });

  test("fetchModels surfaces an error on a failed response", async () => {
    fetchImpl = async () => new Response("nope", { status: 500 });
    const { container } = makeForm();
    click(byText(container, "Fetch models"));
    await flush();
    expect(container.textContent).toContain("HTTP 500");
    // Still on the free-text model branch — no models arrived.
    expect(container.querySelector("sp-combobox")).toBeNull();
  });

  test("Save persists key, endpoint, and model to localStorage and fires onSaved", () => {
    const onSaved = mock(() => {});
    const { container } = makeForm({ onSaved });
    fire(fieldByPlaceholder(container, "sk-"), "input", "sk-saved");
    fire(fieldByPlaceholder(container, "Model ID"), "input", "gpt-4o-mini");
    fire(fieldByPlaceholder(container, "Endpoint"), "input", "http://localhost:11434/v1");
    click(byText(container, "Save"));
    expect(globalThis.localStorage.getItem("jx.ai.openaiKey")).toBe("sk-saved");
    expect(globalThis.localStorage.getItem("jx.ai.baseUrl")).toBe("http://localhost:11434/v1");
    expect(globalThis.localStorage.getItem("jx.ai.model")).toBe("gpt-4o-mini");
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  test("Cancel is only offered when a key exists; startEdit preloads drafts and fetches models", async () => {
    const onCancel = mock(() => {});
    const { container, form } = makeForm({ onCancel });
    // No stored key → no Cancel button.
    expect(byText(container, "Cancel")).toBeUndefined();
    seedSettings({ "jx.ai.openaiKey": "sk-existing" });
    fetchCalls.length = 0;
    form.startEdit();
    await flush();
    // Drafts preloaded from the stored settings; Cancel offered now that a key exists.
    expect(fieldByPlaceholder(container, "sk-")!.value).toBe("sk-existing");
    /* Empty rather than "gpt-4o": nothing has been chosen, and a prefilled default is a choice the
       user did not make — Save would then persist it. */
    expect(fieldByPlaceholder(container, "Model ID")!.value).toBe("");
    expect(byText(container, "Cancel")).toBeDefined();
    // StartEdit auto-fetched the model list.
    expect(fetchCalls.length).toBe(1);
    click(byText(container, "Cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  /**
   * The reported bug, as a test.
   *
   * Save used to blank its own drafts while the Preferences sheet stayed open, so every field
   * emptied the moment a save succeeded. Blank is what the setters treat as _clear_, so the obvious
   * response — press Save again — deleted the key and endpoint the first press had just stored. A
   * real install was left holding `{"jx.ai.model": "gpt-4o"}` and nothing else.
   */
  test("Save leaves the form showing what it stored, and a second Save does not erase it", () => {
    const { container } = makeForm();
    fire(fieldByPlaceholder(container, "sk-"), "input", "sk-keepme");
    fire(fieldByPlaceholder(container, "Endpoint"), "input", "https://opencode.ai/zen/go/v1");
    fire(fieldByPlaceholder(container, "Model ID"), "input", "deepseek-v4-pro");
    click(byText(container, "Save"));

    // The fields still show what was persisted — not blanks.
    expect(fieldByPlaceholder(container, "sk-")!.value).toBe("sk-keepme");
    expect(fieldByPlaceholder(container, "Endpoint")!.value).toBe("https://opencode.ai/zen/go/v1");
    expect(fieldByPlaceholder(container, "Model ID")!.value).toBe("deepseek-v4-pro");

    // And pressing Save again is a no-op re-write rather than a revoke.
    click(byText(container, "Save"));
    expect(globalThis.localStorage.getItem("jx.ai.openaiKey")).toBe("sk-keepme");
    expect(globalThis.localStorage.getItem("jx.ai.baseUrl")).toBe("https://opencode.ai/zen/go/v1");
    expect(globalThis.localStorage.getItem("jx.ai.model")).toBe("deepseek-v4-pro");
  });

  /**
   * A blank model field means "whatever the provider defaults to". It must not become a stored
   * choice: prefilling the field with `getModel()`'s `"gpt-4o"` fallback and then saving it is what
   * left a real install holding `jx.ai.model: "gpt-4o"` for a provider that never served it.
   */
  test("Save with no model chosen records no model choice", () => {
    const { container } = makeForm();
    fire(fieldByPlaceholder(container, "sk-"), "input", "sk-nomodel");
    click(byText(container, "Save"));
    expect(globalThis.localStorage.getItem("jx.ai.openaiKey")).toBe("sk-nomodel");
    expect(storedModel()).toBe("");
    // A sender still has something to send.
    expect(preferredModel()).toBe("gpt-4o");
  });

  test("Save keeps the fetched model list, so the combobox does not collapse", async () => {
    fetchImpl = async () => Response.json({ models: [{ id: "gpt-4o" }] }, { status: 200 });
    const { container } = makeForm();
    fire(fieldByPlaceholder(container, "sk-"), "input", "sk-list");
    click(byText(container, "Fetch models"));
    await flush();
    expect(container.querySelector("sp-combobox")).not.toBeNull();
    click(byText(container, "Save"));
    expect(container.querySelector("sp-combobox")).not.toBeNull();
    expect(byText(container, "Refresh models")).toBeDefined();
  });

  /**
   * The precedence used to be `getOpenAiKey() || keyDraft` for the key while the endpoint beside it
   * read draft-first. Editing a key in place therefore tested the OLD one — and a form whose drafts
   * had been blanked still fetched successfully from storage, which is what made an emptied form
   * look like it was working.
   */
  test("Fetch models sends the drafted key, not the stored one", async () => {
    seedSettings({ "jx.ai.openaiKey": "sk-old" });
    fetchImpl = async () => Response.json({ models: [] }, { status: 200 });
    const { container } = makeForm();
    fire(fieldByPlaceholder(container, "sk-"), "input", "sk-new");
    fetchCalls.length = 0;
    click(byText(container, "Fetch models"));
    await flush();
    const headers = fetchCalls.at(-1)!.init!.headers as Record<string, string>;
    expect(headers["X-Api-Key"]).toBe("sk-new");
  });

  test("two instances keep independent draft state", () => {
    const a = makeForm();
    const b = makeForm();
    fire(fieldByPlaceholder(a.container, "sk-"), "input", "sk-instance-a");
    // Re-render both from their own closures: only A's draft carries the typed key.
    render(a.form.render(), a.container);
    render(b.form.render(), b.container);
    expect(fieldByPlaceholder(a.container, "sk-")!.value).toBe("sk-instance-a");
    expect(fieldByPlaceholder(b.container, "sk-")!.value).toBe("");
  });

  test("is built from Spectrum controls with no inline style attributes", () => {
    const { container } = makeForm();
    // The key field masks, and it is a Spectrum control rather than a raw <input>.
    expect(fieldByPlaceholder(container, "sk-")!.getAttribute("type")).toBe("password");
    expect(container.querySelector("input")).toBeNull();
    // Every rule lives in styles/shell.css — check-styles' orphan rule depends on it.
    expect(container.querySelector("[style]")).toBeNull();
    for (const cls of [
      "ai-creds-title",
      "ai-creds-note",
      "ai-creds-label",
      "ai-creds-models",
      "ai-creds-actions",
    ]) {
      expect(container.querySelector(`.${cls}`)).not.toBeNull();
    }
  });

  test("a fetch error renders in the styled error slot, not an inline-coloured span", async () => {
    fetchImpl = async () => new Response("nope", { status: 503 });
    const { container } = makeForm();
    click(byText(container, "Fetch models"));
    await flush();
    expect(container.querySelector(".ai-creds-error")!.textContent).toContain("HTTP 503");
  });

  test("intro replaces the default blurb but keeps the heading", () => {
    const { container } = makeForm({ intro: "Add a key so the agent can build your project." });
    expect(container.textContent).toContain("Add a key so the agent can build your project.");
    expect(container.textContent).not.toContain("Any OpenAI-compatible key works");
    expect(container.textContent).toContain("AI provider key");
  });
});
