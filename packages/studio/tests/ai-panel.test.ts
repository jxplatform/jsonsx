/**
 * Tests for src/panels/ai-panel.ts — the assistant tab orchestrator: key gate, the chat ↔ sessions
 * view machine, the rAF render loop driven by the reactive chat-state watcher, stick-to-bottom
 * auto-scroll, and the seedAssistantPrompt hand-off.
 *
 * The document assistant is mocked (reactive chat-state, recorded session API); the panel module
 * holds singleton state, so these tests run as one ordered scenario.
 */
import {
  flush,
  installMockPlatform,
  key,
  pointer,
  resetWorkspaceWithTab,
  setValue,
} from "./harness";
import { reactive } from "@vue/reactivity";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Message } from "@jxsuite/ai/chat-state";
import type { SessionMeta } from "../src/services/ai-session-store";
import { fetchAvailableModels, invalidateModelCache } from "../src/services/ai-models";

installMockPlatform();

// Model-picker fetches resolve instantly with one model.
(globalThis as Record<string, unknown>).fetch = async () =>
  Response.json({ models: [{ id: "gpt-4o" }] }, { status: 200 });

// Deterministic rAF for the panel's coalesced render loop.
(globalThis as unknown as Record<string, unknown>).requestAnimationFrame = (
  cb: FrameRequestCallback,
) => setTimeout(() => cb(0), 0) as unknown as number;

// ─── Document-assistant mock ─────────────────────────────────────────────────

const chatState = reactive({
  error: null as string | null,
  messages: [] as Message[],
  status: "idle" as "idle" | "streaming" | "error",
});

let msgCounter = 0;
function pushMessage(role: Message["role"], content: string, extra: Partial<Message> = {}) {
  msgCounter += 1;
  chatState.messages.push({
    content,
    id: `m${msgCounter}`,
    role,
    timestamp: msgCounter,
    ...extra,
  } as Message);
}

let activeId: string | null = null;
let sessionList: SessionMeta[] = [];
const sendMessage = mock(async (text: string) => {
  pushMessage("user", text);
});
const stopMock = mock(() => {});
const newChatMock = mock(() => {
  chatState.messages.length = 0;
  activeId = null;
});
const openSessionMock = mock((id: string) => {
  activeId = id;
  chatState.messages.length = 0;
  pushMessage("user", `restored from ${id}`);
});
const deleteSessionMock = mock((id: string) => {
  sessionList = sessionList.filter((s) => s.id !== id);
});

void mock.module("../src/services/document-assistant", () => ({
  createDocumentAssistant: () => ({
    activeSessionId: () => activeId,
    chatState,
    deleteSession: deleteSessionMock,
    listSessions: () => sessionList,
    newChat: newChatMock,
    openSession: openSessionMock,
    sendMessage,
    stop: stopMock,
  }),
}));

const { bindAiPanelHost, mountAiPanel, renderAiPanelTemplate, seedAssistantPrompt } =
  await import("../src/panels/ai-panel");

// The panel renders into its bound host via the rAF loop, exactly as in the app.
const host = document.createElement("div");
document.body.append(host);
bindAiPanelHost(host);
mountAiPanel();
mountAiPanel(); // Idempotent

function q<T extends Element = HTMLElement>(sel: string) {
  return host.querySelector(sel) as T | null;
}

beforeEach(() => {
  resetWorkspaceWithTab();
});

// ─── Ordered scenario (module-level singleton state) ─────────────────────────

describe("ai-panel", () => {
  test("gates the chat behind the credentials form when no key is stored", async () => {
    globalThis.localStorage.clear();
    pushMessage("user", "pre-existing");
    await flush(3); // Watcher → rAF render
    expect(q(".ai-creds-form")).not.toBeNull();
    expect(q(".ai-chat-messages")).toBeNull();
    chatState.messages.length = 0;
  });

  test("unlocks without a key when the proxy reports itself configured (managed platforms)", async () => {
    globalThis.localStorage.clear();
    const realFetch = globalThis.fetch;
    (globalThis as Record<string, unknown>).fetch = async () =>
      Response.json(
        { models: [{ id: "@cf/meta/llama-4" }], configured: true, managed: true },
        { status: 200 },
      );
    await fetchAvailableModels({ force: true });
    pushMessage("user", "cloud hello");
    await flush(3);
    expect(q(".ai-creds-form")).toBeNull();
    expect(q(".ai-composer textarea")).not.toBeNull();
    chatState.messages.length = 0;
    invalidateModelCache();
    (globalThis as Record<string, unknown>).fetch = realFetch;
    await flush(3);
  });

  test("shows the chat view once a key exists, and streams reactively into it", async () => {
    globalThis.localStorage.setItem("jx.ai.openaiKey", "sk-test");
    pushMessage("user", "hello");
    await flush(3);
    expect(q(".ai-creds-form")).toBeNull();
    expect(q(".ai-chat-header")).not.toBeNull();
    expect(q(".ai-composer textarea")).not.toBeNull();
    expect(q(".ai-msg-user")!.textContent).toContain("hello");
    // A fresh unsaved chat titles as "New chat".
    expect(q(".ai-chat-title")!.textContent).toBe("New chat");

    // Streaming: tail renders as plain text, header shows the spinner, Send morphs to Stop.
    chatState.status = "streaming";
    pushMessage("assistant", "**partial");
    await flush(3);
    expect(q(".ai-msg-streaming")!.textContent).toBe("**partial");
    expect(q("sp-progress-circle")).not.toBeNull();
    expect(q(".ai-send-btn")!.getAttribute("title")).toBe("Stop");

    // Token growth repaints through the watcher.
    chatState.messages.at(-1)!.content += " more**";
    await flush(3);
    expect(q(".ai-msg-streaming")!.textContent).toBe("**partial more**");

    // Finalize: markdown parses, spinner clears.
    chatState.status = "idle";
    await flush(3);
    expect(q(".ai-msg-streaming")).toBeNull();
    expect(q(".ai-msg-md strong")!.textContent).toBe("partial more");
    expect(q("sp-progress-circle")).toBeNull();
  });

  test("chat errors render with recovery advice", async () => {
    chatState.error = "429 rate limit";
    chatState.status = "error";
    await flush(3);
    expect(q(".ai-msg-error")!.textContent).toContain("429 rate limit");
    expect(q(".ai-msg-error-advice")!.textContent).toContain("rate limit");
    chatState.error = null;
    chatState.status = "idle";
    await flush(3);
  });

  test("composer sends flow into the assistant and Stop stops it", async () => {
    const ta = q<HTMLTextAreaElement>(".ai-composer textarea")!;
    setValue(ta, "add a hero section");
    key(ta, "Enter");
    await flush(3);
    expect(sendMessage).toHaveBeenCalledWith("add a hero section");
    expect(q(".ai-msg-user:last-of-type")).not.toBeNull();

    chatState.status = "streaming";
    await flush(3);
    pointer(q(".ai-send-btn")!, "click");
    expect(stopMock).toHaveBeenCalledTimes(1);
    chatState.status = "idle";
    await flush(3);
  });

  test("history button opens the sessions view; rows open/delete sessions", async () => {
    sessionList = [
      { createdAt: 1, id: "s1", messageCount: 4, title: "First chat", updatedAt: 2 },
      { createdAt: 3, id: "s2", messageCount: 2, title: "Second chat", updatedAt: 4 },
    ];
    pointer(q("sp-action-button[title='Chat history']")!, "click");
    await flush(3);
    expect(q(".ai-sessions")).not.toBeNull();
    expect(host.querySelectorAll(".ai-session-row")).toHaveLength(2);
    expect(q(".ai-session-title")!.textContent).toBe("First chat");

    // Deleting a session stays on the sessions view.
    pointer(host.querySelectorAll(".ai-session-delete")[1]!, "click");
    await flush(3);
    expect(deleteSessionMock).toHaveBeenCalledWith("s2");
    expect(host.querySelectorAll(".ai-session-row")).toHaveLength(1);

    // Opening a session returns to the chat view with its messages and title.
    pointer(q(".ai-session-row")!, "click");
    await flush(3);
    expect(openSessionMock).toHaveBeenCalledWith("s1");
    expect(q(".ai-chat-messages")).not.toBeNull();
    expect(q(".ai-msg-user")!.textContent).toContain("restored from s1");
    expect(q(".ai-chat-title")!.textContent).toBe("First chat");
  });

  test("New Chat clears to a fresh unsaved chat from either view", async () => {
    pointer(q("sp-action-button[title='Chat history']")!, "click");
    await flush(3);
    pointer(q("sp-action-button[title='New chat']")!, "click");
    await flush(3);
    expect(newChatMock).toHaveBeenCalledTimes(1);
    expect(q(".ai-chat-messages")).not.toBeNull();
    expect(q(".ai-chat-title")!.textContent).toBe("New chat");
  });

  test("the composer gear opens the credentials form; Cancel returns to the chat", async () => {
    pointer(q("sp-action-button[title='API key & endpoint']")!, "click");
    await flush(3);
    expect(q(".ai-creds-form")).not.toBeNull();
    const cancel = [...host.querySelectorAll("sp-button")].find((b) =>
      b.textContent?.includes("Cancel"),
    )!;
    pointer(cancel, "click");
    await flush(3);
    expect(q(".ai-creds-form")).toBeNull();
    expect(q(".ai-chat-messages")).not.toBeNull();
  });

  test("seedAssistantPrompt ignores blank prompts and sends real ones", async () => {
    sendMessage.mockClear();
    await seedAssistantPrompt("   ");
    expect(sendMessage).not.toHaveBeenCalled();

    await seedAssistantPrompt("build the project brief");
    expect(sendMessage).toHaveBeenCalledWith("build the project brief");
    await flush(3);
    expect(q(".ai-msg-user:last-of-type")!.textContent).toContain("build the project brief");

    // While streaming, seeds are dropped rather than queued.
    chatState.status = "streaming";
    sendMessage.mockClear();
    await seedAssistantPrompt("dropped");
    expect(sendMessage).not.toHaveBeenCalled();
    chatState.status = "idle";
    await flush(3);
  });

  test("sticks to the bottom while streaming unless the user scrolls up", async () => {
    const scroller = q(".ai-chat-messages")!;
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 400 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 100 });

    // User scrolls up → auto-follow disengages; new messages don't yank the view down.
    scroller.scrollTop = 100;
    scroller.dispatchEvent(new Event("scroll"));
    pushMessage("assistant", "while you were reading");
    await flush(3);
    expect(scroller.scrollTop).toBe(100);

    // Scrolling back near the bottom re-engages; the next render pins to the bottom.
    scroller.scrollTop = 380;
    scroller.dispatchEvent(new Event("scroll"));
    pushMessage("assistant", "caught up");
    await flush(3);
    expect(scroller.scrollTop).toBe(400);
  });

  test("renderAiPanelTemplate is the shared template for host and right-panel renders", () => {
    // Both render paths flow through this single export; the right-panel test renders
    // It directly, so here we just assert it reflects the module's current view state.
    expect(renderAiPanelTemplate()).toBeDefined();
  });
});
