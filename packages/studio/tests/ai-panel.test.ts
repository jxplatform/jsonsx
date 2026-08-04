/**
 * Tests for src/panels/ai-panel.ts — the assistant tab orchestrator: the chat ↔ sessions view
 * machine, the hand-off to Preferences › Assistant where the provider key now lives, the rAF render
 * loop driven by the reactive chat-state watcher, stick-to-bottom auto-scroll, and the
 * seedAssistantPrompt hand-off.
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

const { platform: mockPlatform } = installMockPlatform();

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
  /* The real one pops the failed assistant turn AND the user message that caused it, on the
     contract that the caller re-sends. It has been exported with zero callers since it was
     written (§7.4); the panel's Retry is the first. */
  retryLast() {
    while (chatState.messages.length > 0 && chatState.messages.at(-1)!.role !== "user") {
      chatState.messages.pop();
    }
    chatState.messages.pop();
    chatState.error = null;
    chatState.status = "idle";
  },
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

const {
  bindAiPanelHost,
  handleRestore,
  mountAiPanel,
  renderAiPanelTemplate,
  seedAssistantMessages,
  seedAssistantPrompt,
} = await import("../src/panels/ai-panel");
const { closePreferences } = await import("../src/settings/preferences-dialog");
const { initLayers } = await import("../src/ui/layers");

// The panel renders into its bound host via the rAF loop, exactly as in the app.
const host = document.createElement("div");
document.body.append(host);
bindAiPanelHost(host);
mountAiPanel();
mountAiPanel(); // Idempotent

// The credentials form left the panel for Preferences, so these tests need the overlay layers.
for (const id of ["layer-popover", "layer-modal", "layer-dialog"]) {
  if (!document.querySelector(`#${id}`)) {
    const el = document.createElement("div");
    el.id = id;
    document.body.append(el);
  }
}
initLayers();

function q<T extends Element = HTMLElement>(sel: string) {
  return host.querySelector(sel) as T | null;
}

/** Query inside the dialog layer — where Preferences renders. */
function d<T extends Element = HTMLElement>(sel: string) {
  return document.querySelector(`#layer-dialog ${sel}`) as T | null;
}

/** The dialog's `<sp-button>` whose label contains `label`. */
function dialogButton(label: string) {
  return [...document.querySelectorAll("#layer-dialog sp-button")].find((b) =>
    b.textContent?.includes(label),
  ) as HTMLElement | undefined;
}

/** Open Preferences › Assistant from the in-panel notice and settle its first render. */
async function openSettingsFromNotice() {
  pointer(q(".ai-setup-notice sp-button")!, "click");
  await flush(3);
}

/** Dismiss whatever Preferences sheet is up, and let the panel repaint. */
async function closeSettings() {
  closePreferences();
  await flush(3);
}

beforeEach(() => {
  resetWorkspaceWithTab();
});

// ─── Ordered scenario (module-level singleton state) ─────────────────────────

describe("ai-panel", () => {
  test("keeps the chat and offers the settings action when no key is stored", async () => {
    globalThis.localStorage.clear();
    pushMessage("user", "pre-existing");
    await flush(3); // Watcher → rAF render
    // The panel is a chat, not a credentials form — the transcript and composer are both up.
    expect(q(".ai-chat-messages")).not.toBeNull();
    expect(q(".ai-composer textarea")).not.toBeNull();
    expect(q(".ai-creds-form")).toBeNull();
    // …with one line and the action that fixes it.
    expect(q(".ai-setup-notice")!.textContent).toContain("No AI provider is connected yet.");
    // The action is Preferences, not a dialog of the panel's own: a provider key is an
    // Application setting, and the surface that owns those can also list and revoke it.
    expect(q(".ai-setup-notice sp-button")!.textContent).toContain("Open Preferences…");
    chatState.messages.length = 0;
  });

  test("the notice opens Preferences on the Assistant section; Close dismisses it", async () => {
    globalThis.localStorage.clear();
    await flush(3);
    await openSettingsFromNotice();
    expect(d(".ai-creds-form")).not.toBeNull();
    expect(d("sp-dialog-wrapper")!.getAttribute("headline")).toBe("Preferences");
    // The form is Spectrum controls, not raw inputs with inline styles.
    expect(document.querySelectorAll("#layer-dialog sp-textfield").length).toBeGreaterThan(0);
    expect(d(".ai-creds-form input")).toBeNull();

    d("sp-dialog-wrapper")!.dispatchEvent(new Event("close", { bubbles: true }));
    await flush(3);
    expect(d(".ai-creds-form")).toBeNull();
    expect(q(".ai-setup-notice")).not.toBeNull();
  });

  test("saving a key retires the notice — and leaves Preferences open", async () => {
    globalThis.localStorage.clear();
    await flush(3);
    await openSettingsFromNotice();
    const field = d<HTMLInputElement>("sp-textfield")!;
    field.value = "sk-from-dialog";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    pointer(dialogButton("Save")!, "click");
    await flush(3);
    expect(globalThis.localStorage.getItem("jx.ai.openaiKey")).toBe("sk-from-dialog");
    // Preferences is a PLACE, not a wizard step: it stays up, and the panel behind it has
    // Already dropped the notice because the save announced itself.
    expect(d(".ai-creds-form")).not.toBeNull();
    expect(q(".ai-setup-notice")).toBeNull();
    await closeSettings();
    globalThis.localStorage.clear();
    await flush(3);
  });

  test("offers Connect Cloudflare in the dialog and retires the notice after connecting", async () => {
    globalThis.localStorage.clear();
    const realFetch = globalThis.fetch;
    // Managed platform, Workers AI not yet connected.
    (globalThis as Record<string, unknown>).fetch = async () =>
      Response.json({ models: [], configured: false, managed: true }, { status: 200 });
    await fetchAvailableModels({ force: true });
    const cfConnect = mock(async () => ({ connected: true, accountId: "acc-1" }));
    mockPlatform.cfConnect = cfConnect;
    pushMessage("user", "nudge render");
    await flush(3);
    await openSettingsFromNotice();
    // Both real paths show: the managed connect CTA above the BYOK form.
    expect(d(".ai-managed-connect")).not.toBeNull();
    expect(d(".ai-creds-form")).not.toBeNull();

    // Connecting flips /models to configured — the notice retires.
    (globalThis as Record<string, unknown>).fetch = async () =>
      Response.json(
        { models: [{ id: "@cf/meta/llama-4" }], configured: true, managed: true },
        { status: 200 },
      );
    pointer(dialogButton("Connect Cloudflare")!, "click");
    await flush(6);
    expect(cfConnect).toHaveBeenCalledTimes(1);
    expect(d(".ai-managed-connect")).toBeNull();
    expect(q(".ai-setup-notice")).toBeNull();
    expect(q(".ai-composer textarea")).not.toBeNull();

    await closeSettings();
    chatState.messages.length = 0;
    delete mockPlatform.cfConnect;
    invalidateModelCache();
    (globalThis as Record<string, unknown>).fetch = realFetch;
    await flush(3);
  });

  test("no notice at all when the proxy reports itself configured (managed platforms)", async () => {
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
    expect(q(".ai-setup-notice")).toBeNull();
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
    expect(q(".ai-setup-notice")).toBeNull();
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

  test("the composer gear opens Preferences; the chat behind it is untouched", async () => {
    pointer(q("sp-action-button[title='API key & endpoint']")!, "click");
    await flush(3);
    expect(d(".ai-creds-form")).not.toBeNull();
    // The chat behind the sheet never went anywhere — that is the whole point of the move.
    expect(q(".ai-chat-messages")).not.toBeNull();
    // Cancel is offered because a key exists at this point in the scenario; it clears the drafts
    // And leaves the sheet up.
    pointer(dialogButton("Cancel")!, "click");
    await flush(3);
    expect(d(".ai-creds-form")).not.toBeNull();
    await closeSettings();
    expect(d(".ai-creds-form")).toBeNull();
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

  test("seedAssistantMessages stages a canned conversation and retires the notice", async () => {
    globalThis.localStorage.clear();
    chatState.messages.length = 0;
    await flush(3); // With no key the setup notice is back.
    expect(q(".ai-setup-notice")).not.toBeNull();

    seedAssistantMessages([
      {
        content:
          'Make the hero friendlier\n\n---- attached context ----\nPage: pages/index.md\nSelected element at ["children",0]: <h1>',
        role: "user",
      },
      {
        content: "Done — I softened the headline.",
        role: "assistant",
        toolCalls: [{ arguments: '{"path":["children",0]}', name: "set_text" }],
      },
    ]);
    await flush(3);
    // The inert demo key landed (localStorage only — no request fires)…
    expect(globalThis.localStorage.getItem("jx.ai.openaiKey")).toBe("sk-demo");
    expect(q(".ai-setup-notice")).toBeNull();
    // …and the canned transcript renders with context chips and tool chips.
    expect(q(".ai-msg-user")!.textContent).toContain("Make the hero friendlier");
    expect(q(".ai-context-chip")!.textContent).toContain("Page: pages/index.md");
    expect(q(".ai-msg-assistant")!.textContent).toContain("softened the headline");
    expect(q(".ai-tool-chip")!.textContent).toContain('set_text: ["children",0]');
  });
});

// ─── §7.4: Retry and Restore to here ─────────────────────────────────────────

const { beginTurn, endTurn, recordWrite, resetAiWrites } =
  await import("../src/services/ai-writes");
const { problems, resetNotifications, toasts } = await import("../src/services/notify");
const { activeTab, closeAllTabs } = await import("../src/workspace/workspace");

/** File a ledger entry against a message id, the way the agent loop does. */
function ledger(id: string, writes: { disk: boolean; ok: boolean; path: string }[]) {
  beginTurn(`for:${id}`);
  for (const w of writes) {
    recordWrite({ ...w, tool: "write_file" });
  }
  endTurn(id);
}

function notices(): string[] {
  return [...toasts, ...problems].map((n) => n.message);
}

describe("retry", () => {
  test("the error row's Retry re-sends the last user message", async () => {
    chatState.messages.length = 0;
    chatState.error = "429 rate limit";
    chatState.status = "error";
    pushMessage("user", "make it blue");
    pushMessage("assistant", "");
    await flush(3);

    sendMessage.mockClear();
    pointer(q(".ai-msg-retry")!, "click");
    await flush(4);
    expect(sendMessage).toHaveBeenCalledWith("make it blue");
    chatState.error = null;
    chatState.status = "idle";
  });

  test("Retry with nothing to re-send does nothing", async () => {
    chatState.messages.length = 0;
    chatState.error = "boom";
    chatState.status = "error";
    await flush(3);
    sendMessage.mockClear();
    pointer(q(".ai-msg-retry")!, "click");
    await flush(4);
    expect(sendMessage).not.toHaveBeenCalled();
    chatState.error = null;
    chatState.status = "idle";
  });
});

describe("restore to here", () => {
  beforeEach(() => {
    resetAiWrites();
    resetNotifications();
    chatState.messages.length = 0;
    chatState.error = null;
    chatState.status = "idle";
  });

  test("a transactional turn restores through the tab's history", async () => {
    pushMessage("assistant", "Done.");
    const { id } = chatState.messages.at(-1)!;
    ledger(id, [{ disk: false, ok: true, path: "pages/index.json" }]);
    await flush(3);
    expect(activeTab.value).not.toBeNull();
    pointer(q(".ai-msg-changes sp-action-button")!, "click");
    await flush(3);
    expect(notices()).toContain("Restored to before that turn.");
  });

  test("a turn with no ledger left says so instead of restoring something else", async () => {
    pushMessage("assistant", "Done.");
    const { id } = chatState.messages.at(-1)!;
    ledger(id, [{ disk: false, ok: true, path: "pages/index.json" }]);
    await flush(3);
    resetAiWrites();
    pointer(q(".ai-msg-changes sp-action-button")!, "click");
    await flush(3);
    expect(notices()).toContain("There is no longer a record of what that turn changed.");
  });

  test("a turn that touched disk offers no button, and refuses if called anyway", async () => {
    pushMessage("assistant", "Done.");
    const { id } = chatState.messages.at(-1)!;
    ledger(id, [{ disk: true, ok: true, path: "layouts/base.json" }]);
    await flush(3);
    /* Not rendered — but the ledger can be trimmed between a render and a click, so the handler
       guards again rather than trusting the renderer. */
    expect(q(".ai-msg-changes sp-action-button")).toBeNull();
    handleRestore(id);
    expect(notices().at(-1)).toContain("layouts/base.json");
    expect(notices().at(-1)).toContain("undo cannot reach");
  });

  test("with no tab open it says where to go rather than restoring the wrong document", async () => {
    pushMessage("assistant", "Done.");
    const { id } = chatState.messages.at(-1)!;
    ledger(id, [{ disk: false, ok: true, path: "pages/index.json" }]);
    closeAllTabs();
    handleRestore(id);
    expect(notices().at(-1)).toBe("Open the document that turn edited to restore it.");
  });
});
