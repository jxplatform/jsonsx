/**
 * Tests for src/panels/chat-panel.ts — the assistant, hosted by the Inspector dock's fourth tab.
 *
 * The panel must render with NO document and NO project (the whole point of it), keep a single
 * persistent host container, stamp the `inspector.assistant` region three screenshot shots crop to,
 * and consume a pending agent prompt as soon as the workspace adopts the project root it was stored
 * for (the New Project / bootstrap handoff) — which now REVEALS the tab instead of opening a dock.
 */
import { flush, resetStudioState, resetWorkspaceWithTab } from "./harness";
import { reactive } from "@vue/reactivity";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { initShellRefs } from "../src/store";
import { closeAllTabs, setWorkspaceProject } from "../src/workspace/workspace";
import { setPendingAgentPrompt } from "../src/services/agent-seed";
import { shell } from "../src/shell";
import { inspectorTab } from "../src/panels/right-panel";

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

/**
 * The Assistant tab's body, as `right-panel.ts` builds it.
 *
 * A bare div here rather than the real Inspector: this file is about the tenant, not the host, and
 * `mount(host)` taking its container as an argument is exactly what makes that separable.
 */
function chatHost(): HTMLElement {
  return document.querySelector("#assistant-tab") as HTMLElement;
}

beforeEach(() => {
  document.body.innerHTML = `<div id="app">
    <div id="toolbar"></div><div id="activity-bar"></div><div id="left-panel"></div>
    <div id="canvas-wrap"></div><div id="right-panel"><div id="assistant-tab"></div></div>
    <div id="statusbar"></div>
  </div>`;
  initShellRefs();
  resetStudioState();
  closeAllTabs();
  setWorkspaceProject(null);
  globalThis.localStorage.clear();
  shell.docks.right.collapsed = false;
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
  test("renders the chat with no tab and no project, offering the settings action", async () => {
    mount(chatHost());
    await flush(4);
    const container = chatHost().querySelector(".ai-panel-host") as HTMLElement;
    expect(container).toBeTruthy();
    // No key stored and no configured proxy → still a chat, with the setup action beneath it.
    // The credentials form itself lives in Preferences › Assistant, not in this tab.
    expect(container.querySelector(".ai-creds-form")).toBeNull();
    expect(container.querySelector(".ai-chat-header")).toBeTruthy();
    expect(container.querySelector(".ai-setup-notice")).toBeTruthy();
  });

  test("renders the chat view once a key exists, with or without an open tab", async () => {
    globalThis.localStorage.setItem("jx.ai.openaiKey", "sk-test");
    mount(chatHost());
    render();
    await flush(4);
    const container = chatHost().querySelector(".ai-panel-host") as HTMLElement;
    expect(container.querySelector(".ai-chat-header")).toBeTruthy();

    // Opening a document changes nothing about the panel's availability.
    resetWorkspaceWithTab();
    render();
    await flush(4);
    expect(container.querySelector(".ai-chat-header")).toBeTruthy();
  });

  test("consumes a pending agent prompt when the workspace adopts its project root", async () => {
    globalThis.localStorage.setItem("jx.ai.openaiKey", "sk-test");
    shell.docks.right.collapsed = true;
    setPendingAgentPrompt("/proj-c", "build a landing page");
    mount(chatHost());
    await flush(4);
    expect(assistantSend).not.toHaveBeenCalled();

    setWorkspaceProject("/proj-c", { name: "Proj C" });
    await flush(6);

    // The Inspector opens, the Assistant tab is selected, the localStorage entry is consumed, and
    // The prompt is sent.
    expect(shell.docks.right.collapsed).toBe(false);
    expect(inspectorTab()).toBe("assistant");
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
    const container = host.querySelector(".ai-panel-host");
    mount(host); // Same host → keeps the existing container (single lit part cache).
    expect(host.querySelector(".ai-panel-host")).toBe(container);

    unmount();
    expect(host.querySelector(".ai-panel-host")).toBeNull();
    expect(() => render()).not.toThrow();
  });

  test("stamps `inspector.assistant` — the region three shots crop to", async () => {
    // The id survived the fifth column being deleted and now survives the `#chat-panel` div being
    // Deleted: it names the ROLE, so it is stamped by whoever hosts the assistant.
    mount(chatHost());
    await flush(2);
    const { resolveRegion } = await import("../src/ui/regions");
    expect(resolveRegion("inspector.assistant")).toBe(
      chatHost().querySelector(".ai-panel-host") as HTMLElement,
    );
  });

  test("a mount with no host is inert", () => {
    expect(() => mount(null)).not.toThrow();
  });
});
