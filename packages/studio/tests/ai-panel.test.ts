/**
 * Tests for src/panels/ai-panel.ts — Claude AI assistant panel.
 *
 * Quikchat is mocked (no real chat widget) and EventSource is replaced with an in-memory fake, so
 * no real session or network traffic ever happens. The panel keeps module-level state, so the tests
 * in this file are ordered and run as one continuous scenario.
 */
import { installMockPlatform } from "./harness";
import { describe, expect, mock, test } from "bun:test";
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

mock.module("quikchat/md", () => ({ default: FakeQuikChat }));

// ─── EventSource fake ─────────────────────────────────────────────────────────

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners = new Map<string, ((e: { data?: string }) => void)[]>();
  closed = false;
  url: string;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, fn: (e: { data?: string }) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  close() {
    this.closed = true;
  }

  /** Deliver an event; payload is JSON-stringified unless already a string or omitted. */
  emit(type: string, payload?: unknown) {
    const event: { data?: string } = {};
    if (typeof payload === "string") {
      event.data = payload;
    } else if (payload !== undefined) {
      event.data = JSON.stringify(payload);
    }
    for (const fn of this.listeners.get(type) ?? []) {
      fn(event);
    }
  }
}

Object.defineProperty(globalThis, "EventSource", {
  configurable: true,
  value: FakeEventSource,
  writable: true,
});

// Deterministic rAF so flush() runs the mount callback.
(globalThis as Record<string, unknown>).requestAnimationFrame = (cb: (t: number) => void) =>
  setTimeout(() => cb(0), 0);

// ─── Platform ─────────────────────────────────────────────────────────────────

const authQueue: (() => Promise<{ authenticated: boolean; error?: string }>)[] = [
  async () => {
    throw new Error("net down");
  },
  async () => ({ authenticated: false, error: "denied" }),
  async () => ({ authenticated: false }),
  async () => ({ authenticated: true }),
];
let authCalls = 0;
const createdSessions: unknown[] = [];
let createSessionImpl: (opts: unknown) => Promise<{ id: string }> = async (opts) => {
  createdSessions.push(opts);
  return { id: "sess-1" };
};

const { state } = installMockPlatform({
  aiAuthStatus: async () => {
    authCalls += 1;
    const next = authQueue.shift();
    return next ? next() : { authenticated: true };
  },
  aiCreateSession: (opts) => createSessionImpl(opts),
});

const ai = await import("../src/panels/ai-panel");

// ─── Helpers ──────────────────────────────────────────────────────────────────

let container = document.createElement("div");
const renderPanel = () => {
  render(ai.renderAiPanelTemplate(), container);
};

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

function es() {
  return FakeEventSource.instances.at(-1)!;
}

function button(label: string) {
  return [...container.querySelectorAll("sp-button, sp-action-button")].find((b) =>
    b.textContent?.includes(label),
  ) as HTMLElement;
}

function click(el: HTMLElement) {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function callsOf(instance: FakeQuikChat, name: string) {
  return instance.calls.filter((c) => c[0] === name);
}

function platCalls(name: string) {
  return state.calls.filter((c) => c[0] === name);
}

// ─── Scenario ─────────────────────────────────────────────────────────────────

describe("ai-panel (sequential scenario)", () => {
  test("mountQuikChat is a no-op before the panel container exists", () => {
    ai.mountQuikChat();
    expect(FakeQuikChat.instances.length).toBe(0);
  });

  test("renders checking state before auth resolves", async () => {
    renderPanel();
    await flush();
    expect(container.textContent).toContain("Checking authentication");
  });

  test("auth check failure shows unauthenticated view with the thrown error", async () => {
    ai.registerRightPanelRender(renderPanel);
    ai.mountAiPanel();
    await flush();
    expect(authCalls).toBe(1);
    expect(container.textContent).toContain("Claude authentication required");
    expect(container.textContent).toContain("npx @anthropic-ai/claude-code login");
    expect(container.querySelector("sp-help-text")?.textContent).toContain("net down");
    // Mounting again is a no-op
    ai.mountAiPanel();
    await flush();
    expect(authCalls).toBe(1);
  });

  test("retry re-checks auth and shows the backend error", async () => {
    click(button("Retry"));
    await flush();
    expect(authCalls).toBe(2);
    expect(container.querySelector("sp-help-text")?.textContent).toContain("denied");
  });

  test("unauthenticated without error hides the help text", async () => {
    click(button("Retry"));
    await flush();
    expect(authCalls).toBe(3);
    expect(container.textContent).toContain("Claude authentication required");
    expect(container.querySelector("sp-help-text")).toBeNull();
  });

  test("successful auth shows the chat view and mounts quikchat once", async () => {
    click(button("Retry"));
    await flush();
    expect(container.textContent).toContain("New Chat");
    expect(container.querySelector("#ai-quikchat")).toBeTruthy();
    expect(FakeQuikChat.instances.length).toBe(1);
    expect(qc().opts.theme).toBe("quikchat-theme-dark");
    // Same container — no second instance
    ai.mountQuikChat();
    expect(FakeQuikChat.instances.length).toBe(1);
  });

  test("blank input is ignored", async () => {
    qc().callback(qc(), "   ");
    await flush();
    expect(createdSessions.length).toBe(0);
    expect(callsOf(qc(), "messageAddTypingIndicator").length).toBe(0);
  });

  test("first message creates a session and opens the SSE stream", async () => {
    qc().callback(qc(), "hello");
    await flush();
    expect(createdSessions).toEqual([{ message: "hello" }]);
    expect(callsOf(qc(), "messageAddTypingIndicator").length).toBe(1);
    expect(qc().calls).toContainEqual(["inputAreaSetEnabled", false]);
    expect(FakeEventSource.instances.length).toBe(1);
    expect(es().url).toBe("/__mock/ai/stream");
    expect(platCalls("aiStreamUrl")).toEqual([["aiStreamUrl", "sess-1"]]);
    // Streaming → Stop button visible
    expect(button("Stop")).toBeTruthy();
  });

  test("messages sent while streaming are dropped", async () => {
    qc().callback(qc(), "again");
    await flush();
    expect(createdSessions.length).toBe(1);
    expect(platCalls("aiSendMessage").length).toBe(0);
  });

  test("text deltas replace the typing indicator then append", async () => {
    es().emit("stream_event", {
      event: { delta: { text: "Hel", type: "text_delta" }, type: "content_block_delta" },
    });
    es().emit("stream_event", {
      event: { delta: { text: "lo", type: "text_delta" }, type: "content_block_delta" },
    });
    es().emit("stream_event", { event: { type: "other" } });
    es().emit("stream_event", "not json");
    const replaced = callsOf(qc(), "messageReplaceContent");
    expect(replaced.at(-1)?.[2]).toBe("Hel");
    const appended = callsOf(qc(), "messageAppendContent");
    expect(appended.at(-1)?.[2]).toBe("lo");
  });

  test("assistant tool_use blocks render formatted tool labels", async () => {
    es().emit("assistant", "not json");
    es().emit("assistant", {
      message: {
        content: [
          { text: "I will edit", type: "text" },
          { input: { file_path: "/elsewhere/a.json" }, name: "Edit", type: "tool_use" },
          { input: { path: "/elsewhere/b.json" }, name: "Write", type: "tool_use" },
          { input: {}, name: "Edit", type: "tool_use" },
          { input: {}, name: "Read", type: "tool_use" },
          { input: { command: "x".repeat(60) }, name: "Bash", type: "tool_use" },
          { input: { pattern: "**/*.ts" }, name: "Glob", type: "tool_use" },
          { input: { pattern: "foo" }, name: "Grep", type: "tool_use" },
          { name: "WebSearch", type: "tool_use" },
        ],
      },
    });
    const labels = callsOf(qc(), "messageAddNew")
      .filter((c) => c[4] === "tool")
      .map((c) => c[1]);
    expect(labels).toEqual([
      "📝 Edit: /elsewhere/a.json",
      "📝 Write: /elsewhere/b.json",
      "📝 Edit: file",
      "📖 Read: file",
      `⚡ Run: ${"x".repeat(50)}…`,
      "🔍 Glob: **/*.ts",
      "🔍 Grep: foo",
      "🔧 WebSearch",
    ]);
    // New assistant bubble started with the block text
    const assistantAdds = callsOf(qc(), "messageAddNew").filter((c) => c[4] === "assistant");
    expect(assistantAdds.at(-1)?.[1]).toBe("I will edit");
  });

  test("done finishes the stream and re-enables input", async () => {
    es().emit("done");
    await flush();
    expect(qc().calls.at(-1)).toEqual(["inputAreaSetEnabled", true]);
    expect(button("Stop")).toBeUndefined();
  });

  test("second message reuses the session and error payloads surface", async () => {
    qc().callback(qc(), "follow-up");
    await flush();
    expect(platCalls("aiSendMessage")).toEqual([["aiSendMessage", "sess-1", "follow-up"]]);
    expect(FakeEventSource.instances.length).toBe(1);
    es().emit("error", { error: "boom" });
    await flush();
    const replaced = callsOf(qc(), "messageReplaceContent");
    expect(replaced.at(-1)?.[2]).toBe("Error: boom");
    expect(button("Stop")).toBeUndefined();
  });

  test("result with is_error replaces the bubble with the error", async () => {
    qc().callback(qc(), "third");
    await flush();
    es().emit("result", { is_error: true, result: "limit exceeded" });
    await flush();
    const replaced = callsOf(qc(), "messageReplaceContent");
    expect(replaced.at(-1)?.[2]).toBe("Error: limit exceeded");
    // A result event when not streaming is ignored (finishStream guard)
    es().emit("result", "garbage");
    await flush();
  });

  test("remounting into a fresh container replays the conversation", async () => {
    container = document.createElement("div");
    renderPanel();
    await flush();
    ai.mountQuikChat();
    const replay = qc();
    expect(FakeQuikChat.instances.length).toBe(2);
    const adds = callsOf(replay, "messageAddNew");
    const users = adds.filter((c) => c[4] === "user").map((c) => c[1]);
    expect(users).toEqual(["hello", "follow-up", "third"]);
    expect(adds.filter((c) => c[4] === "tool").length).toBe(8);
    const assistants = adds.filter((c) => c[4] === "assistant").map((c) => c[1]);
    expect(assistants).toContain("Hello");
    expect(assistants).toContain("I will edit");
    expect(assistants).toContain("Error: boom");
    expect(assistants).toContain("Error: limit exceeded");
  });

  test("replay during streaming restores partial text and disables input", async () => {
    qc().callback(qc(), "stream me");
    await flush();
    es().emit("stream_event", {
      event: { delta: { text: "partial answer", type: "text_delta" }, type: "content_block_delta" },
    });
    container = document.createElement("div");
    renderPanel();
    await flush();
    ai.mountQuikChat();
    const replay = qc();
    expect(FakeQuikChat.instances.length).toBe(3);
    const adds = callsOf(replay, "messageAddNew");
    expect(adds.at(-1)?.[1]).toBe("partial answer");
    expect(replay.calls).toContainEqual(["inputAreaSetEnabled", false]);
    es().emit("done");
    await flush();
  });

  test("assistant events without content or text are tolerated", async () => {
    qc().callback(qc(), "more");
    await flush();
    es().emit("assistant", {});
    // Bare content array with only a tool block while no text accumulated
    es().emit("assistant", {
      content: [{ input: { pattern: "x" }, name: "Glob", type: "tool_use" }],
    });
    const labels = callsOf(qc(), "messageAddNew").filter((c) => c[4] === "tool");
    expect(labels.at(-1)?.[1]).toBe("🔍 Glob: x");
    // Error event with no data → parse failure swallowed, stream finishes
    es().emit("error");
    await flush();
    expect(button("Stop")).toBeUndefined();
  });

  test("stop button stops the active session", async () => {
    qc().callback(qc(), "stop me");
    await flush();
    expect(button("Stop")).toBeTruthy();
    click(button("Stop"));
    await flush();
    expect(platCalls("aiStopSession")).toEqual([["aiStopSession", "sess-1"]]);
    expect(button("Stop")).toBeUndefined();
  });

  test("new chat deletes the session and clears history", async () => {
    // Cover the unregistered-render fallback inside rerenderPanel
    (globalThis as Record<string, unknown>).__jxRightPanelRender = undefined;
    click(button("New Chat"));
    await flush();
    ai.registerRightPanelRender(renderPanel);
    expect(platCalls("aiDeleteSession")).toEqual([["aiDeleteSession", "sess-1"]]);
    expect(qc().calls).toContainEqual(["historyImport", []]);
    expect(es().closed).toBe(true);
    // History gone — remount replays nothing
    container = document.createElement("div");
    renderPanel();
    await flush();
    ai.mountQuikChat();
    expect(callsOf(qc(), "messageAddNew").length).toBe(0);
  });

  test("stop without a session is a no-op; create-session failure surfaces", async () => {
    let reject: (e: unknown) => void = () => {};
    createSessionImpl = () =>
      new Promise((_resolve, rej) => {
        reject = rej;
      });
    qc().callback(qc(), "fail msg");
    await flush();
    // Streaming with no session yet — Stop renders but does nothing
    expect(button("Stop")).toBeTruthy();
    click(button("Stop"));
    await flush();
    expect(platCalls("aiStopSession").length).toBe(1); // Unchanged from earlier test
    reject(new Error("no backend"));
    await flush();
    const replaced = callsOf(qc(), "messageReplaceContent");
    expect(String(replaced.at(-1)?.[2])).toContain("no backend");
    expect(qc().calls.at(-1)).toEqual(["inputAreaSetEnabled", true]);
    expect(button("Stop")).toBeUndefined();
  });
});
