/**
 * Tests for src/panels/chat-panel.ts — the persistent AI chat sidebar.
 *
 * The panel must render with NO document and NO project (the whole point of the sidebar), keep a
 * single persistent host container, and consume a pending agent prompt as soon as the workspace
 * adopts the project root it was stored for (the New Project / bootstrap handoff).
 */
import { flush, resetStudioState, resetWorkspaceWithTab } from "./harness";
import { reactive } from "@vue/reactivity";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { initShellRefs } from "../src/store";
import { closeAllTabs, setWorkspaceProject } from "../src/workspace/workspace";
import { setPendingAgentPrompt } from "../src/services/agent-seed";
import { view } from "../src/view";

// Chat-panel hosts ai-panel, which instantiates a document assistant at module load. Mock it
// (before the dynamic import below) so no send ever touches the network.
const assistantChatState = reactive({
  error: null as string | null,
  messages: [] as { role: string; content: string }[],
  status: "idle" as "idle" | "streaming" | "error",
});
const assistantSend = mock(async (_text: string) => {});
void mock.module("../src/services/document-assistant", () => ({
  createDocumentAssistant: () => ({
    activeSessionId: () => null,
    chatState: assistantChatState,
    deleteSession: () => {},
    listSessions: () => [],
    newChat: () => {},
    openSession: () => {},
    sendMessage: assistantSend,
    stop: () => {},
  }),
}));

/* Keep the credentials gate deterministic: no managed proxy, no configured proxy, no probe fetch.
   hasAiCredentials still tracks the stored key, since these tests drive the gate through it. */
void mock.module("../src/services/ai-models", () => ({
  ensureProxyProbe: () => {},
  fetchAvailableModels: async () => {},
  getProxyDefaultModel: () => "",
  hasAiCredentials: () => Boolean(globalThis.localStorage.getItem("jx.ai.openaiKey")),
  invalidateModelCache: () => {},
  isManagedProxy: () => false,
  isProxyConfigured: () => false,
}));

const { mount, render, unmount } = await import("../src/panels/chat-panel");

// The ai-panel render loop and the pending-prompt seed defer via requestAnimationFrame.
const origRaf = globalThis.requestAnimationFrame;
(globalThis as unknown as Record<string, unknown>).requestAnimationFrame = (
  cb: FrameRequestCallback,
) => setTimeout(() => cb(0), 0) as unknown as number;

function chatHost(): HTMLElement {
  return document.querySelector("#chat-panel") as HTMLElement;
}

beforeEach(() => {
  document.body.innerHTML = `<div id="app">
    <div id="toolbar"></div><div id="activity-bar"></div><div id="left-panel"></div>
    <div id="canvas-wrap"></div><div id="right-panel"></div><div id="chat-panel"></div>
    <div id="statusbar"></div>
  </div>`;
  initShellRefs();
  resetStudioState();
  closeAllTabs();
  setWorkspaceProject(null);
  globalThis.localStorage.clear();
  view.chatPanelCollapsed = false;
  assistantSend.mockClear();
});

afterEach(() => {
  unmount();
  closeAllTabs();
  setWorkspaceProject(null);
});

afterEach(() => {
  globalThis.requestAnimationFrame = origRaf;
});

describe("chat panel", () => {
  test("renders the credentials gate with no tab and no project", async () => {
    mount(chatHost());
    await flush(4);
    const container = chatHost().querySelector(".panel-body") as HTMLElement;
    expect(container).toBeTruthy();
    // No key stored and no configured proxy → the key gate shows, chat still reachable.
    expect(container.querySelector(".ai-creds-form")).toBeTruthy();
  });

  test("renders the chat view once a key exists, with or without an open tab", async () => {
    globalThis.localStorage.setItem("jx.ai.openaiKey", "sk-test");
    mount(chatHost());
    render();
    await flush(4);
    const container = chatHost().querySelector(".panel-body") as HTMLElement;
    expect(container.querySelector(".ai-chat-header")).toBeTruthy();

    // Opening a document changes nothing about the panel's availability.
    resetWorkspaceWithTab();
    render();
    await flush(4);
    expect(container.querySelector(".ai-chat-header")).toBeTruthy();
  });

  test("consumes a pending agent prompt when the workspace adopts its project root", async () => {
    globalThis.localStorage.setItem("jx.ai.openaiKey", "sk-test");
    view.chatPanelCollapsed = true;
    setPendingAgentPrompt("/proj-c", "build a landing page");
    mount(chatHost());
    await flush(4);
    expect(assistantSend).not.toHaveBeenCalled();

    setWorkspaceProject("/proj-c", { name: "Proj C" });
    await flush(6);

    // The sidebar force-opens, the localStorage entry is consumed, and the prompt is sent.
    expect(view.chatPanelCollapsed).toBe(false);
    expect(document.querySelector("#app")!.classList.contains("chat-collapsed")).toBe(false);
    expect(globalThis.localStorage.getItem("jx.ai.pendingAgentPrompt:/proj-c")).toBeNull();
    expect(assistantSend).toHaveBeenCalledWith("build a landing page");
  });

  test("a project root without a pending prompt does not seed anything", async () => {
    mount(chatHost());
    setWorkspaceProject("/proj-d");
    await flush(4);
    expect(assistantSend).not.toHaveBeenCalled();
  });

  test("mount is idempotent per host and render after unmount is a no-op", async () => {
    const host = chatHost();
    mount(host);
    await flush(2);
    const container = host.querySelector(".panel-body");
    mount(host); // Same host → keeps the existing container (single lit part cache).
    expect(host.querySelector(".panel-body")).toBe(container);

    unmount();
    expect(host.querySelector(".panel-body")).toBeNull();
    expect(() => render()).not.toThrow();
  });
});
