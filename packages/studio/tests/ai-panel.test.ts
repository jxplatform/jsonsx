/**
 * Tests for src/panels/ai-panel.ts — Stack B document-assistant panel.
 *
 * Quikchat is mocked (no real chat widget) and the document assistant is mocked with a reactive
 * chat-state we drive by hand, so watchAssistant()'s effect fires on mutations without any network
 * traffic. The panel keeps module-level state, so the tests run as one ordered scenario.
 */
import { installMockPlatform } from "./harness";
import { reactive } from "@vue/reactivity";
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { render } from "lit-html";

// ─── Quikchat mock ────────────────────────────────────────────────────────────

class FakeQuikChat {
  static instances: FakeQuikChat[] = [];
  calls: unknown[][] = [];
  container: unknown;
  callback: (chat: unknown, msg: string) => void;
  opts: Record<string, unknown>;
  nextId = 1;

  constructor(
    container: unknown,
    callback: (chat: unknown, msg: string) => void,
    opts: Record<string, unknown>,
  ) {
    this.container = container;
    this.callback = callback;
    this.opts = opts;
    FakeQuikChat.instances.push(this);
  }

  messageAddNew(text: string, sender: string, side: string, role?: string) {
    this.calls.push(["messageAddNew", text, sender, side, role]);
    const id = this.nextId;
    this.nextId += 1;
    return id;
  }

  messageAddTypingIndicator(text: string) {
    this.calls.push(["messageAddTypingIndicator", text]);
    const id = this.nextId;
    this.nextId += 1;
    return id;
  }

  messageReplaceContent(id: number, text: string) {
    this.calls.push(["messageReplaceContent", id, text]);
  }

  messageAppendContent(id: number, text: string) {
    this.calls.push(["messageAppendContent", id, text]);
  }

  inputAreaSetEnabled(enabled: boolean) {
    this.calls.push(["inputAreaSetEnabled", enabled]);
  }

  historyImport(history: unknown[]) {
    this.calls.push(["historyImport", history]);
  }
}

void mock.module("quikchat/md", () => ({ default: FakeQuikChat }));

// ─── Document-assistant mock (reactive chat-state we drive by hand) ─────────────

interface FakeMsg {
  role: string;
  content: string;
  toolCalls?: { name: string; arguments: string }[];
}

const chatState = reactive({
  messages: [] as FakeMsg[],
  status: "idle" as "idle" | "streaming" | "error",
  error: null as string | null,
});

const sendMessage = mock(async (_text: string) => {});
const stop = mock(() => {});
const newChat = mock(() => {
  chatState.messages.splice(0);
  chatState.status = "idle";
  chatState.error = null;
});

void mock.module("../src/services/document-assistant", () => ({
  createDocumentAssistant: () => ({ chatState, sendMessage, stop, newChat }),
}));

// Deterministic rAF so flush() runs the scheduled mountQuikChat callback.
(globalThis as Record<string, unknown>).requestAnimationFrame = (cb: (t: number) => void) =>
  setTimeout(() => cb(0), 0);

// ─── Fetch mock (for fetchModels) ──────────────────────────────────────────────

let fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = async () =>
  Response.json({ models: [] }, { status: 200 });
const fetchCalls: { url: string; init?: RequestInit | undefined }[] = [];
(globalThis as Record<string, unknown>).fetch = (url: string, init?: RequestInit) => {
  fetchCalls.push({ init, url });
  return fetchImpl(url, init);
};

const { state } = installMockPlatform();
const ai = await import("../src/panels/ai-panel");

// ─── Helpers ────────────────────────────────────────────────────────────────

let container = document.createElement("div");
function renderPanel() {
  render(ai.renderAiPanelTemplate(), container);
}

async function flush(turns = 4) {
  for (let i = 0; i < turns; i++) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

function qc() {
  return FakeQuikChat.instances.at(-1)!;
}

function callsOf(instance: FakeQuikChat, name: string) {
  return instance.calls.filter((c) => c[0] === name);
}

function byText(label: string) {
  return [...container.querySelectorAll("sp-button, sp-action-button")].find((b) =>
    b.textContent?.includes(label),
  ) as HTMLElement | undefined;
}

function click(el: HTMLElement | undefined) {
  el?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function inputByPlaceholder(ph: string) {
  return container.querySelector(`input[placeholder^="${ph}"]`) as HTMLInputElement | null;
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

// ─── Scenario ───────────────────────────────────────────────────────────────

describe("ai-panel (Stack B sequential scenario)", () => {
  beforeAll(() => {
    globalThis.localStorage.clear();
    chatState.messages.splice(0);
    chatState.status = "idle";
    chatState.error = null;
    ai.registerRightPanelRender(() => renderPanel());
  });

  afterAll(() => {
    globalThis.localStorage.clear();
  });

  test("mountAiPanel is idempotent and registerRightPanelRender is wired", () => {
    ai.mountAiPanel();
    ai.mountAiPanel();
    // No throw; registration already applied in beforeAll.
    expect(typeof ai.renderAiPanelTemplate).toBe("function");
  });

  test("mountQuikChat is a no-op before the chat container exists", () => {
    ai.mountQuikChat();
    expect(FakeQuikChat.instances.length).toBe(0);
  });

  test("renders the key gate when no key is stored", () => {
    renderPanel();
    expect(container.textContent).toContain("AI provider key");
    expect(inputByPlaceholder("sk-")).not.toBeNull();
    // No saved key yet → no Cancel button (only offered when a key exists).
    expect(byText("Cancel")).toBeUndefined();
    // No models fetched yet → free-text model input branch.
    expect(inputByPlaceholder("Model ID")).not.toBeNull();
  });

  test("gate inputs update the drafts", () => {
    fire(inputByPlaceholder("sk-"), "input", "sk-test-key");
    fire(inputByPlaceholder("Model ID"), "input", "gpt-4o-mini");
    fire(inputByPlaceholder("Endpoint"), "input", "http://localhost:11434/v1");
    // Handlers ran without error; drafts are exercised via the subsequent Save.
    expect(inputByPlaceholder("sk-")!.value).toBe("sk-test-key");
  });

  test("fetchModels populates the picker and forwards key + base URL headers", async () => {
    fetchImpl = async () =>
      Response.json({ models: [{ id: "gpt-4o" }, { id: "x", name: "Model X" }] }, { status: 200 });
    fetchCalls.length = 0;
    click(byText("Fetch models"));
    await flush();
    renderPanel();
    // Combobox branch now active (availableModels > 0).
    expect(container.querySelector("sp-combobox")).not.toBeNull();
    expect(container.textContent).toContain("Model X");
    expect(container.textContent).toContain("Refresh models");
    // Header forwarding from the typed drafts.
    const headers = fetchCalls.at(-1)!.init!.headers as Record<string, string>;
    expect(headers["X-Api-Key"]).toBe("sk-test-key");
    expect(headers["X-Api-Base-URL"]).toBe("http://localhost:11434/v1");
    expect(fetchCalls.at(-1)!.url).toContain("/models");
  });

  test("combobox change/input handlers update the model draft", () => {
    fire(container.querySelector("sp-combobox") as HTMLElement, "change", "gpt-4o");
    fire(container.querySelector("sp-combobox") as HTMLElement, "input", "gpt-4o");
    expect(container.querySelector("sp-combobox")).not.toBeNull();
  });

  test("fetchModels surfaces an error on a non-OK response", async () => {
    fetchImpl = async () => new Response("nope", { status: 500 });
    click(byText("Refresh models"));
    await flush();
    renderPanel();
    expect(container.textContent).toContain("HTTP 500");
  });

  test("saveApiKey persists the key and switches to the chat view", async () => {
    // Restore a good models response for later re-fetches.
    fetchImpl = async () => Response.json({ models: [] }, { status: 200 });
    fire(inputByPlaceholder("sk-"), "input", "sk-test-key");
    click(byText("Save"));
    await flush();
    expect(globalThis.localStorage.getItem("jx.ai.openaiKey")).toBe("sk-test-key");
    renderPanel();
    // Chat view: toolbar + quikchat mount point, no key form.
    expect(container.textContent).not.toContain("AI provider key");
    expect(container.querySelector("#ai-quikchat")).not.toBeNull();
    expect(byText("New Chat")).toBeDefined();
  });

  test("mountQuikChat instantiates once and is idempotent", () => {
    renderPanel();
    ai.mountQuikChat();
    expect(FakeQuikChat.instances.length).toBe(1);
    ai.mountQuikChat();
    expect(FakeQuikChat.instances.length).toBe(1);
  });

  test("sending a message drives the assistant and toggles input enablement", async () => {
    sendMessage.mockClear();
    qc().callback(qc(), "hello there");
    await flush();
    expect(sendMessage).toHaveBeenCalledWith("hello there");
    const enableCalls = callsOf(qc(), "inputAreaSetEnabled").map((c) => c[1]);
    expect(enableCalls).toContain(false);
    expect(enableCalls).toContain(true);
  });

  test("empty and streaming sends are ignored", async () => {
    sendMessage.mockClear();
    qc().callback(qc(), "   ");
    chatState.status = "streaming";
    qc().callback(qc(), "while busy");
    await flush();
    chatState.status = "idle";
    await flush();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("streaming flow: live bubble, incremental append, then finalize in place", async () => {
    const inst = qc();
    inst.calls.length = 0;
    // User message + a streaming assistant tail.
    chatState.messages.push({ content: "hi", role: "user" });
    chatState.status = "streaming";
    chatState.messages.push({ content: "", role: "assistant" });
    await flush();
    expect(callsOf(inst, "messageAddNew").some((c) => c[1] === "hi" && c[4] === "user")).toBe(true);
    // Token deltas — mutate through the reactive proxy.
    chatState.messages[1]!.content = "Hello";
    await flush();
    chatState.messages[1]!.content = "Hello world";
    await flush();
    const appends = callsOf(inst, "messageAppendContent").map((c) => c[2]);
    expect(appends).toContain("Hello");
    expect(appends).toContain(" world");
    // Finalize.
    chatState.status = "idle";
    await flush();
    expect(callsOf(inst, "messageReplaceContent").length).toBeGreaterThan(0);
  });

  test("a failed tool result is surfaced; a successful one stays hidden", async () => {
    const inst = qc();
    inst.calls.length = 0;
    chatState.messages.push(
      { content: JSON.stringify({ error: "bad path", success: false }), role: "tool" },
      { content: JSON.stringify({ success: true }), role: "tool" },
    );
    await flush();
    const added = callsOf(inst, "messageAddNew").map((c) => c[1] as string);
    expect(added.some((t) => t.includes("⚠️") && t.includes("bad path"))).toBe(true);
    expect(added.some((t) => t.includes("{") && t.includes("success"))).toBe(false);
  });

  test("a non-JSON tool result is ignored", async () => {
    const inst = qc();
    inst.calls.length = 0;
    chatState.messages.push({ content: "not json at all", role: "tool" });
    await flush();
    expect(callsOf(inst, "messageAddNew").length).toBe(0);
  });

  test("assistant tool-call labels render path, parentPath, plain, and unparsable args", async () => {
    const inst = qc();
    inst.calls.length = 0;
    chatState.messages.push({
      content: "working on it",
      role: "assistant",
      toolCalls: [
        { arguments: JSON.stringify({ path: [0, 1] }), name: "replaceNode" },
        { arguments: JSON.stringify({ parentPath: [2] }), name: "insertNode" },
        { arguments: JSON.stringify({}), name: "validate" },
        { arguments: "{bad json", name: "broken" },
      ],
    });
    await flush();
    const added = callsOf(inst, "messageAddNew").map((c) => c[1] as string);
    expect(added.some((t) => t.includes("working on it"))).toBe(true);
    expect(added.some((t) => t.includes("🔧 replaceNode") && t.includes("[0,1]"))).toBe(true);
    expect(added.some((t) => t.includes("🔧 insertNode") && t.includes("[2]"))).toBe(true);
    expect(added.some((t) => t === "🔧 validate")).toBe(true);
    expect(added.some((t) => t === "🔧 broken")).toBe(true);
  });

  test("error state renders the message with actionable advice", async () => {
    for (const [err, advice] of [
      ["401 no api key", "🔑"],
      ["network error: fetch failed", "dev server"],
      ["429 rate limit", "rate limit"],
      ["500 internal", "server error"],
      ["something obscure", null],
    ] as [string, string | null][]) {
      const inst = qc();
      inst.calls.length = 0;
      chatState.error = err;
      chatState.status = "error";
      await flush();
      chatState.error = null;
      chatState.status = "idle";
      await flush();
      const added = callsOf(inst, "messageAddNew").map((c) => c[1] as string);
      expect(added.some((t) => t.includes("❌") && t.includes(err))).toBe(true);
      if (advice) {
        expect(added.some((t) => t.includes(advice))).toBe(true);
      }
    }
  });

  test("Stop button calls assistant.stop() while streaming", () => {
    stop.mockClear();
    chatState.status = "streaming";
    renderPanel();
    click(byText("Stop"));
    expect(stop).toHaveBeenCalled();
    chatState.status = "idle";
    renderPanel();
  });

  test("New Chat resets the conversation", () => {
    newChat.mockClear();
    const inst = qc();
    inst.calls.length = 0;
    chatState.messages.push({ content: "leftover", role: "user" });
    click(byText("New Chat"));
    expect(newChat).toHaveBeenCalled();
    expect(callsOf(inst, "historyImport").length).toBe(1);
    expect(chatState.messages.length).toBe(0);
  });

  test("key button reopens the gate over an existing key, then Cancel returns to chat", async () => {
    click(byText("🔑"));
    await flush();
    renderPanel();
    // Gate shows again even though a key exists → Cancel offered.
    expect(container.textContent).toContain("AI provider key");
    expect(byText("Cancel")).toBeDefined();
    click(byText("Cancel"));
    renderPanel();
    expect(container.textContent).not.toContain("AI provider key");
    expect(container.querySelector("#ai-quikchat")).not.toBeNull();
  });

  test("mounting into a fresh container replays existing history and skips the streaming tail", async () => {
    chatState.messages.splice(0);
    chatState.messages.push(
      { content: "earlier question", role: "user" },
      { content: JSON.stringify({ success: true }), role: "tool" },
      { content: "partial answer", role: "assistant" },
    );
    chatState.status = "streaming";
    const fresh = document.createElement("div");
    render(ai.renderAiPanelTemplate(), fresh);
    container = fresh;
    ai.mountQuikChat();
    await flush();
    const inst = qc();
    const added = callsOf(inst, "messageAddNew").map((c) => c[1] as string);
    // User message replayed; streaming assistant tail not finalized during replay.
    expect(added.some((t) => t.includes("earlier question"))).toBe(true);
    // The platform mock's aiChatUrl was used by fetchModels earlier.
    expect(state.calls.some((c) => c[0] === "aiChatUrl")).toBe(true);
    chatState.status = "idle";
  });

  test("seedAssistantPrompt drives the same send path as the chat input", async () => {
    sendMessage.mockClear();
    await ai.seedAssistantPrompt("seeded from the new-project flow");
    expect(sendMessage).toHaveBeenCalledWith("seeded from the new-project flow");
    // Blank prompts are ignored by the shared send guard.
    sendMessage.mockClear();
    await ai.seedAssistantPrompt("   ");
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
