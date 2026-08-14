/**
 * Tests for src/ui/ai-credentials-form.ts — the reusable AI provider credentials form.
 *
 * Fetch is stubbed (no network), and the platform mock supplies aiChatUrl. Each form instance
 * renders into its own detached container via a requestRender that re-renders synchronously.
 */
import { installMockPlatform } from "./harness";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { render } from "lit-html";
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
  globalThis.localStorage.clear();
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
    globalThis.localStorage.setItem("jx.ai.openaiKey", "sk-existing");
    fetchCalls.length = 0;
    form.startEdit();
    await flush();
    // Drafts preloaded from the stored settings; Cancel offered now that a key exists.
    expect(fieldByPlaceholder(container, "sk-")!.value).toBe("sk-existing");
    expect(fieldByPlaceholder(container, "Model ID")!.value).toBe("gpt-4o");
    expect(byText(container, "Cancel")).toBeDefined();
    // StartEdit auto-fetched the model list.
    expect(fetchCalls.length).toBe(1);
    click(byText(container, "Cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
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
